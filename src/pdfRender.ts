/**
 * PDF page rasterization helper used by the wine and meal vision pipelines.
 *
 * Strategy: shell out to Poppler's `pdftoppm` to render each PDF page to PNG
 * bytes. Poppler is small, ubiquitous, and avoids pulling a heavy headless
 * Chromium / Cairo binding into the API. On Render the buildpack must install
 * the `poppler-utils` apt package — see CHECKLIST.md.
 *
 * `renderPdfPagesToPng` is best-effort: if `pdftoppm` is missing the helper
 * throws `RenderUnavailableError`, which lets callers gracefully fall back to
 * the existing text-LLM / deterministic paths instead of 500-ing.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export class RenderUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RenderUnavailableError';
  }
}

export type RenderPdfOptions = {
  /** DPI for rasterization. 150 is a good readability/size trade-off. */
  dpi?: number;
  /** 1-indexed page range. When omitted every page is rendered. */
  firstPage?: number;
  lastPage?: number;
  /** Override the binary used (mostly for tests). Default `pdftoppm`. */
  binary?: string;
  /** Hard cap on rendered pages so a 200-page upload can't melt the server. */
  maxPages?: number;
};

const DEFAULT_DPI = 150;
const DEFAULT_MAX_PAGES = 12;

/**
 * Render a PDF buffer to PNG buffers, one per page.
 *
 * Throws `RenderUnavailableError` when `pdftoppm` is not installed, which the
 * server treats as "skip vision, use text/deterministic instead".
 */
export async function renderPdfPagesToPng(
  buffer: Buffer,
  options: RenderPdfOptions = {}
): Promise<Buffer[]> {
  const dpi = options.dpi ?? DEFAULT_DPI;
  const binary = options.binary ?? 'pdftoppm';
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;

  const dir = await mkdtemp(path.join(tmpdir(), 'menu-pdf-render-'));
  const inputPath = path.join(dir, 'input.pdf');
  const outputPrefix = path.join(dir, 'page');
  try {
    await writeFile(inputPath, buffer);
    const args = ['-png', '-r', String(dpi)];
    if (options.firstPage) args.push('-f', String(options.firstPage));
    if (options.lastPage) args.push('-l', String(options.lastPage));
    args.push(inputPath, outputPrefix);

    await runBinary(binary, args);

    const entries = await readdir(dir);
    const pageFiles = entries
      .filter((f) => f.startsWith('page') && f.endsWith('.png'))
      .sort();
    const limited = pageFiles.slice(0, maxPages);
    const buffers: Buffer[] = [];
    for (const f of limited) {
      buffers.push(await readFile(path.join(dir, f)));
    }
    return buffers;
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
          new RenderUnavailableError(
            `${binary} is not installed. Install poppler-utils to enable vision rendering.`
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
          new RenderUnavailableError(
            `${binary} is not installed. Install poppler-utils to enable vision rendering.`
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

/** True when the extracted text from a PDF is empty/near-empty per page. */
export function pdfTextLooksEmpty(pages: string[] | undefined, rawText: string | undefined): boolean {
  const blobs = pages && pages.length > 0 ? pages : rawText ? [rawText] : [];
  if (blobs.length === 0) return true;
  let totalChars = 0;
  let nonEmptyPages = 0;
  for (const b of blobs) {
    const trimmed = (b ?? '').replace(/\s+/g, ' ').trim();
    totalChars += trimmed.length;
    if (trimmed.length >= 40) nonEmptyPages += 1;
  }
  // Treat as image-only when total readable text is very small or no page has
  // a usable amount of words. Tuned so a single-paragraph cover PDF still
  // routes through the text LLM path.
  if (totalChars < 80) return true;
  if (nonEmptyPages === 0) return true;
  return false;
}

/** Detect content type for a buffer of image bytes by magic numbers. */
export function detectImageMime(buffer: Buffer, fallback: string = 'image/png'): string {
  if (buffer.length >= 8) {
    const header = buffer.subarray(0, 8);
    if (
      header[0] === 0x89 &&
      header[1] === 0x50 &&
      header[2] === 0x4e &&
      header[3] === 0x47
    )
      return 'image/png';
    if (header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) return 'image/jpeg';
    if (
      header[0] === 0x47 &&
      header[1] === 0x49 &&
      header[2] === 0x46 &&
      header[3] === 0x38
    )
      return 'image/gif';
    if (header[0] === 0x52 && header[1] === 0x49 && header[2] === 0x46 && header[3] === 0x46)
      return 'image/webp';
  }
  return fallback;
}

/** Build a `data:image/...;base64,...` URL for an image buffer. */
export function imageBufferToDataUrl(buffer: Buffer, mime?: string): string {
  const m = mime ?? detectImageMime(buffer);
  return `data:${m};base64,${buffer.toString('base64')}`;
}
