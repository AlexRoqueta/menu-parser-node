/**
 * Helper for splitting "stitched" tall menu images into overlapping vertical
 * tiles before sending them through the vision LLM.
 *
 * Background: when a user uploads a JPG/PNG that is actually one tall image
 * containing an entire dinner menu (e.g. 1080x4452), passing the whole image
 * to the vision model under-extracts because the model only attends to a few
 * regions of a very tall image. The PDF version of the same menu rasterizes
 * to multiple pages and yields ~30 meals; the single-image version yields
 * ~14. Splitting the tall image into page-like overlapping tiles gives the
 * vision model many smaller, focused crops and recovers the missing meals.
 *
 * Strategy:
 *   - Read width/height from the JPEG SOF or PNG IHDR header (no external
 *     dependency).
 *   - If `height / width` exceeds {@link DEFAULT_TILE_ASPECT_THRESHOLD} the
 *     image is considered "unusually tall" and is sliced into roughly square
 *     vertical tiles with {@link DEFAULT_TILE_OVERLAP_RATIO} overlap so a meal
 *     straddling a tile boundary is captured in both neighbors.
 *   - Slicing shells out to ImageMagick `magick`/`convert` — matching the
 *     existing `pdftoppm`-via-spawn pattern in `pdfRender.ts`. If ImageMagick
 *     is missing the helper returns `null` and the caller falls back to
 *     sending the original image.
 *
 * Returned tile buffers are PNG bytes so the downstream `imageBufferToDataUrl`
 * helper detects the type correctly.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export class TilerUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TilerUnavailableError';
  }
}

export type ImageDimensions = { width: number; height: number };

/**
 * Aspect ratio (`height / width`) above which an image is considered tall
 * enough to be a stitched multi-page menu rather than a single physical page.
 * A typical US Letter page is 8.5x11 (ratio ~1.29). We require a clearly
 * elongated aspect (~1.6+) so we don't tile normal single-page photos.
 */
export const DEFAULT_TILE_ASPECT_THRESHOLD = 1.6;

/**
 * Vertical overlap between successive tiles, expressed as a fraction of tile
 * height. Overlap prevents a single dish that straddles two tiles from being
 * cut in half between calls; merging dedupes the duplicates.
 */
export const DEFAULT_TILE_OVERLAP_RATIO = 0.18;

/**
 * Approximate tile aspect ratio (`tileHeight / width`). 1.3 mimics a page
 * (slightly taller than square). Tiles too close to square waste tokens; tiles
 * too tall reproduce the original under-extraction problem.
 */
export const DEFAULT_TILE_TARGET_ASPECT = 1.3;

/** Hard cap so an enormous panorama can't fan out into 50 tiles. */
export const DEFAULT_TILE_MAX_COUNT = 8;

/** Minimum tile count when tiling is triggered — fewer than 2 is pointless. */
export const DEFAULT_TILE_MIN_COUNT = 2;

export type TileImageOptions = {
  aspectThreshold?: number;
  overlapRatio?: number;
  targetTileAspect?: number;
  minTiles?: number;
  maxTiles?: number;
  /** ImageMagick binary. `magick` on v7+, `convert` on v6. Auto-detected. */
  binary?: string;
};

export type TileImageResult = {
  /** PNG bytes, one per tile, top-to-bottom. */
  tiles: Buffer[];
  /** Source dimensions echoed for logging/tests. */
  source: ImageDimensions;
  /** Per-tile crop rectangles, useful for debugging/tests. */
  rects: { x: number; y: number; width: number; height: number }[];
};

/**
 * Read width/height from a JPEG or PNG byte buffer without decoding the
 * pixels. Returns `null` for unsupported formats so the caller can fall back.
 */
export function readImageDimensions(buffer: Buffer): ImageDimensions | null {
  if (!buffer || buffer.length < 16) return null;
  // PNG: 8-byte signature, then IHDR chunk at offset 8 → length(4) "IHDR"(4)
  // width(4) height(4) — big-endian.
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    if (buffer.length < 24) return null;
    const width = buffer.readUInt32BE(16);
    const height = buffer.readUInt32BE(20);
    if (width > 0 && height > 0) return { width, height };
    return null;
  }
  // JPEG: 0xFFD8 then a series of markers. Each marker begins 0xFF<code>; SOF
  // markers (0xC0-0xCF except 0xC4, 0xC8, 0xCC) carry the frame size.
  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    let i = 2;
    const len = buffer.length;
    while (i + 9 < len) {
      if (buffer[i] !== 0xff) {
        i += 1;
        continue;
      }
      // Skip padding bytes (multiple 0xFFs).
      while (i < len && buffer[i] === 0xff) i += 1;
      if (i >= len) return null;
      const marker = buffer[i];
      i += 1;
      // Standalone markers carry no payload.
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) continue;
      if (i + 1 >= len) return null;
      const segLen = buffer.readUInt16BE(i);
      // SOF0..SOFn — frame headers. Skip DHT(0xC4), JPG(0xC8), DAC(0xCC).
      if (
        marker >= 0xc0 &&
        marker <= 0xcf &&
        marker !== 0xc4 &&
        marker !== 0xc8 &&
        marker !== 0xcc
      ) {
        // Layout: 2-byte length, 1-byte precision, 2-byte height, 2-byte width.
        if (i + 7 >= len) return null;
        const height = buffer.readUInt16BE(i + 3);
        const width = buffer.readUInt16BE(i + 5);
        if (width > 0 && height > 0) return { width, height };
        return null;
      }
      i += segLen;
    }
    return null;
  }
  return null;
}

/**
 * Compute tile crop rectangles for a tall image. Pure function — exposed so
 * tests can verify rectangles without touching ImageMagick.
 */
export function computeVerticalTiles(
  dims: ImageDimensions,
  opts: TileImageOptions = {}
): { rects: { x: number; y: number; width: number; height: number }[]; shouldTile: boolean } {
  const aspectThreshold = opts.aspectThreshold ?? DEFAULT_TILE_ASPECT_THRESHOLD;
  const overlap = clamp(opts.overlapRatio ?? DEFAULT_TILE_OVERLAP_RATIO, 0, 0.45);
  const targetAspect = Math.max(0.5, opts.targetTileAspect ?? DEFAULT_TILE_TARGET_ASPECT);
  const minTiles = Math.max(2, opts.minTiles ?? DEFAULT_TILE_MIN_COUNT);
  const maxTiles = Math.max(minTiles, opts.maxTiles ?? DEFAULT_TILE_MAX_COUNT);

  const { width, height } = dims;
  if (width <= 0 || height <= 0) return { rects: [], shouldTile: false };
  const aspect = height / width;
  if (aspect < aspectThreshold) return { rects: [], shouldTile: false };

  // Choose a tile height close to the target page-like aspect, but stretched
  // so that `tileCount` tiles with `overlap` cover the whole image exactly.
  const targetTileHeight = Math.round(width * targetAspect);
  const safeTileHeight = Math.max(1, Math.min(targetTileHeight, height));
  // Number of tiles needed so consecutive tiles step (1 - overlap) * tile and
  // the last tile ends at `height`.
  const step = Math.max(1, Math.floor(safeTileHeight * (1 - overlap)));
  const rawCount = Math.ceil((height - safeTileHeight) / step) + 1;
  const tileCount = clamp(rawCount, minTiles, maxTiles);

  // Recompute exact tile height/step so the tiles span the entire image.
  // total_span = tileHeight + (tileCount - 1) * step = height
  // step = tileHeight * (1 - overlap)
  // => tileHeight = height / (1 + (tileCount - 1) * (1 - overlap))
  const denom = 1 + (tileCount - 1) * (1 - overlap);
  let tileHeight = Math.round(height / denom);
  tileHeight = Math.min(tileHeight, height);
  const exactStep = tileCount > 1 ? (height - tileHeight) / (tileCount - 1) : 0;

  const rects: { x: number; y: number; width: number; height: number }[] = [];
  for (let i = 0; i < tileCount; i++) {
    const y = i === tileCount - 1 ? height - tileHeight : Math.round(i * exactStep);
    const clampedY = clamp(y, 0, Math.max(0, height - tileHeight));
    rects.push({ x: 0, y: clampedY, width, height: tileHeight });
  }
  return { rects, shouldTile: true };
}

function clamp(n: number, lo: number, hi: number): number {
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

/**
 * Decide whether `buffer` is "tall enough" to be a stitched multi-page menu
 * and, if so, slice it into overlapping vertical tiles. Returns `null` when
 * the image is normal-sized OR when ImageMagick is unavailable; the caller
 * should pass the original image to the vision LLM in either case.
 */
export async function tileTallImage(
  buffer: Buffer,
  opts: TileImageOptions = {}
): Promise<TileImageResult | null> {
  const dims = readImageDimensions(buffer);
  if (!dims) return null;
  const { rects, shouldTile } = computeVerticalTiles(dims, opts);
  if (!shouldTile || rects.length < 2) return null;

  const binaryCandidates = opts.binary
    ? [opts.binary]
    : ['magick', 'convert'];

  let lastError: unknown = null;
  for (const binary of binaryCandidates) {
    try {
      const tiles = await cropTiles(buffer, rects, binary);
      return { tiles, source: dims, rects };
    } catch (err) {
      if (err instanceof TilerUnavailableError) {
        lastError = err;
        continue;
      }
      throw err;
    }
  }
  // All binaries unavailable — return null so the route falls back to a
  // single-image vision call instead of failing the upload.
  void lastError;
  return null;
}

async function cropTiles(
  buffer: Buffer,
  rects: { x: number; y: number; width: number; height: number }[],
  binary: string
): Promise<Buffer[]> {
  const dir = await mkdtemp(path.join(tmpdir(), 'menu-img-tile-'));
  const inputPath = path.join(dir, 'input.img');
  try {
    await writeFile(inputPath, buffer);
    const out: Buffer[] = [];
    for (let i = 0; i < rects.length; i++) {
      const r = rects[i];
      const outPath = path.join(dir, `tile-${i + 1}.png`);
      // ImageMagick syntax: convert input.img -crop {W}x{H}+{X}+{Y} +repage out.png
      // `magick` v7 uses the same args as a subcommand-less invocation.
      const args = [
        inputPath,
        '-crop',
        `${r.width}x${r.height}+${r.x}+${r.y}`,
        '+repage',
        outPath
      ];
      await runBinary(binary, args);
      out.push(await readFile(outPath));
    }
    return out;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function runBinary(binary: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawn(binary, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === 'ENOENT') {
        return reject(
          new TilerUnavailableError(
            `${binary} is not installed. Install imagemagick to enable image tiling.`
          )
        );
      }
      return reject(err);
    }
    let stderr = '';
    proc.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    proc.on('error', (err) => {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        return reject(
          new TilerUnavailableError(
            `${binary} is not installed. Install imagemagick to enable image tiling.`
          )
        );
      }
      reject(err);
    });
    proc.on('close', (code) => {
      if (code === 0) return resolve();
      reject(new Error(`${binary} exited with code ${code}: ${stderr.trim()}`));
    });
  });
}
