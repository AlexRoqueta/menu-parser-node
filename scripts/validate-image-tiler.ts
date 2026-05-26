/**
 * Validation harness for the image tiler used by `/parse-menu` and
 * `/parse-wine-list` direct image uploads.
 *
 * Verifies:
 *   1. `readImageDimensions` parses JPEG/PNG width/height correctly.
 *   2. `computeVerticalTiles` returns no tiles for normal-aspect images and
 *      ≥ 2 overlapping tiles for unusually tall images, with tile rectangles
 *      that span the full image height and fit within the source bounds.
 *   3. `tileTallImage` produces actual PNG buffers when ImageMagick is
 *      available (skipped with a clear note when it isn't).
 *
 * Run:  npx tsx scripts/validate-image-tiler.ts
 *
 * Optional env: `TILER_IMAGE` to point at a custom test image. Defaults to
 * the Maggiano's stitched menu image used to investigate the regression.
 */
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  DEFAULT_TILE_ASPECT_THRESHOLD,
  computeVerticalTiles,
  readImageDimensions,
  tileTallImage
} from '../src/imageTiler.js';

type Check = { name: string; ok: boolean; detail?: string };
const checks: Check[] = [];
const record = (name: string, ok: boolean, detail?: string) =>
  checks.push({ name, ok, detail });

async function main() {
  const imagePath =
    process.env.TILER_IMAGE ??
    '/home/user/workspace/Maggiano-s-Little-Italy-Dinner-Menu.jpg';
  const exists = await stat(imagePath).then(
    () => true,
    () => false
  );
  if (!exists) {
    console.warn(`[skip] no image at ${imagePath} — point TILER_IMAGE at a JPG/PNG to validate.`);
  }

  // --- Dimension parsing -----------------------------------------------------
  // Hand-crafted 8x4 PNG header (only the IHDR is needed for dimensions).
  const pngHeader = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, // IHDR length
    0x49, 0x48, 0x44, 0x52, // "IHDR"
    0x00, 0x00, 0x00, 0x08, // width = 8
    0x00, 0x00, 0x00, 0x04, // height = 4
    0x08, 0x06, 0x00, 0x00, 0x00 // bit depth/color type/...
  ]);
  const png = readImageDimensions(pngHeader);
  record('PNG header parsed', png?.width === 8 && png?.height === 4, JSON.stringify(png));

  if (exists) {
    const buf = await readFile(imagePath);
    const dims = readImageDimensions(buf);
    record(
      `dimensions of ${path.basename(imagePath)}`,
      Boolean(dims && dims.width > 0 && dims.height > 0),
      dims ? `${dims.width}x${dims.height} aspect=${(dims.height / dims.width).toFixed(2)}` : 'null'
    );

    // --- Tile-rect math ------------------------------------------------------
    if (dims) {
      const isTall = dims.height / dims.width >= DEFAULT_TILE_ASPECT_THRESHOLD;
      const { rects, shouldTile } = computeVerticalTiles(dims);
      record(
        'tall image triggers tiling',
        isTall ? shouldTile && rects.length >= 2 : !shouldTile,
        `shouldTile=${shouldTile} rects=${rects.length} (isTall=${isTall})`
      );
      if (shouldTile) {
        const lastRect = rects[rects.length - 1];
        const lastEnd = lastRect.y + lastRect.height;
        record(
          'tile rects cover entire image height',
          lastEnd === dims.height,
          `lastEnd=${lastEnd} height=${dims.height}`
        );
        const allInsideX = rects.every((r) => r.x === 0 && r.width === dims.width);
        record('tile rects span full width', allInsideX);
        const allInsideY = rects.every(
          (r) => r.y >= 0 && r.y + r.height <= dims.height
        );
        record('tile rects within source bounds', allInsideY);
        // Adjacent tiles must overlap so a meal that straddles a boundary
        // appears in both tiles and dedupe restores it cleanly.
        let overlapsOk = true;
        for (let i = 0; i + 1 < rects.length; i++) {
          const a = rects[i];
          const b = rects[i + 1];
          if (b.y >= a.y + a.height) {
            overlapsOk = false;
            break;
          }
        }
        record('adjacent tiles overlap', overlapsOk);
      }

      // --- Actual cropping (requires ImageMagick) ----------------------------
      try {
        const result = await tileTallImage(buf);
        if (!result) {
          if (isTall) {
            console.warn(
              '[note] tileTallImage returned null — image qualifies but ImageMagick may be missing. Cropping check skipped.'
            );
          }
        } else {
          record(
            'tileTallImage produced PNG tile buffers',
            result.tiles.length === rects.length &&
              result.tiles.every((b) => b.length > 0 && b[0] === 0x89 && b[1] === 0x50),
            `tiles=${result.tiles.length} firstBytes=0x${result.tiles[0]?.[0]?.toString(16)}${result.tiles[0]?.[1]?.toString(16)}`
          );
        }
      } catch (err) {
        record(
          'tileTallImage threw',
          false,
          err instanceof Error ? err.message : String(err)
        );
      }
    }
  }

  // --- Normal-aspect image (synthetic, no IO) --------------------------------
  const normal = computeVerticalTiles({ width: 1200, height: 1500 });
  record(
    'normal aspect image is NOT tiled',
    !normal.shouldTile && normal.rects.length === 0,
    `shouldTile=${normal.shouldTile}`
  );

  // --- Synthetic tall image --------------------------------------------------
  const tall = computeVerticalTiles({ width: 1080, height: 4452 });
  record(
    'synthetic tall image yields ≥ 2 tiles',
    tall.shouldTile && tall.rects.length >= 2,
    `tiles=${tall.rects.length}`
  );

  // --- Report ----------------------------------------------------------------
  let failed = 0;
  for (const c of checks) {
    const prefix = c.ok ? 'PASS' : 'FAIL';
    if (!c.ok) failed += 1;
    console.log(`[${prefix}] ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
  }
  if (failed > 0) {
    console.error(`\n${failed}/${checks.length} checks failed.`);
    process.exitCode = 1;
  } else {
    console.log(`\nAll ${checks.length} checks passed.`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
