/**
 * Parity validation for the `/parse-wine-list` vision pipelines.
 *
 * Goal: verify that the direct-image (tall stitched JPG) and image-only PDF
 * (PNG pages from poppler) routes produce the *same* deduped, priced-only
 * wine list for the Maggiano's fixture pair when fed equivalent vision
 * output.
 *
 * Strategy: drive `extractWinesWithVision` and `extractWinesFromImageUpload`
 * with a synthetic `callVision` that returns a hand-curated JSON payload
 * representing what the model sees for a given page or tile. The fixture
 * data here mirrors the actual Maggiano wine list — 37 priced wines plus the
 * two visible unpriced rows (Caparzo, Ratti "Battaglione") that must be
 * filtered out, with a couple of duplicates spanning adjacent tiles so the
 * dedupe path is exercised.
 *
 * Run: npx tsx scripts/validate-wine-vision-parity.ts
 */
import { readFile, stat } from 'node:fs/promises';
import {
  extractWinesFromImageUpload,
  extractWinesWithVision,
  mergeExtractions,
  type WineLlmExtraction,
  type WineLlmRecord
} from '../src/wineLlmParser.js';
import { readImageDimensions, computeVerticalTiles } from '../src/imageTiler.js';

type Check = { name: string; ok: boolean; detail?: string };
const checks: Check[] = [];
const record = (name: string, ok: boolean, detail?: string) =>
  checks.push({ name, ok, detail });

const WINE_JPG = '/home/user/workspace/Maggiano-s-Little-Italy-Wine-Menu-2.jpg';

/**
 * Ground-truth priced wines from the Maggiano fixture (subset is fine — the
 * point is that the fake vision driver emits these split across pages/tiles
 * with deliberate overlap, and the merge logic recovers exactly the unique
 * set without inflating it or losing rows).
 *
 * Each item: { wine, vintage, prices }. Section is set per page in the
 * page-to-wines mapping below.
 */
type Seed = {
  wine: string;
  vintage?: string | null;
  glass?: number;
  carafe?: number;
  bottle?: number;
};

const GLASS_AND_BOTTLE: Seed[] = [
  { wine: 'Maggiano’s Sparkling Wine, Italy', vintage: 'NV', glass: 11, bottle: 38 },
  { wine: 'Maso Canali Pinot Grigio, Trentino, Italy', vintage: '2022', glass: 14, bottle: 49 },
  { wine: 'Kris Pinot Grigio, Delle Venezie, Italy', vintage: '2022', glass: 11, bottle: 38 },
  { wine: 'Bonterra Chardonnay, Mendocino, California', vintage: '2021', glass: 12, bottle: 42 },
  { wine: 'Wente Riva Ranch Chardonnay, Arroyo Seco, California', vintage: '2022', glass: 14, bottle: 49 },
  { wine: 'Whitehaven Sauvignon Blanc, Marlborough, NZ', vintage: '2023', glass: 13, bottle: 45 },
  { wine: 'Maggiano’s House Chianti, Italy', vintage: 'NV', glass: 10, bottle: 35 },
  { wine: 'Banfi Chianti Classico Riserva, DOCG, Tuscany', vintage: '2019', glass: 14, bottle: 49 },
  { wine: 'Ruffino Riserva Ducale, Chianti Classico Riserva, DOCG, Tuscany', vintage: '2020', glass: 15, bottle: 52 },
  { wine: 'Ferrari-Carano Cabernet Sauvignon, Alexander Valley, California', vintage: '2020', glass: 16, bottle: 56 },
  { wine: 'Josh Cellars Cabernet Sauvignon, California', vintage: '2021', glass: 12, bottle: 42 },
  { wine: 'Meiomi Pinot Noir, California', vintage: '2022', glass: 13, bottle: 45 }
];

const BOTTLE_ONLY: Seed[] = [
  { wine: 'Pio Cesare Barolo, DOCG, Piedmont', vintage: '2019', bottle: 110 },
  { wine: 'Marchesi di Barolo Cannubi, Barolo, DOCG, Piedmont', vintage: '2018', bottle: 145 },
  { wine: 'Antinori Tignanello, Toscana IGT, Tuscany', vintage: '2020', bottle: 175 },
  { wine: 'Banfi Brunello di Montalcino, DOCG, Tuscany', vintage: '2018', bottle: 130 },
  { wine: 'Frescobaldi Nipozzano Riserva, Chianti Rufina, Tuscany', vintage: '2020', bottle: 56 },
  { wine: 'Allegrini Amarone della Valpolicella Classico, DOCG, Veneto', vintage: '2018', bottle: 135 },
  { wine: 'Masi Costasera Amarone Classico, DOCG, Veneto', vintage: '2018', bottle: 125 },
  { wine: 'Zenato Valpolicella Ripassa Superiore, DOC, Veneto', vintage: '2020', bottle: 60 },
  { wine: 'Tenuta San Guido Sassicaia, Bolgheri DOC, Tuscany', vintage: '2020', bottle: 395 },
  { wine: 'Gaja Ca Marcanda Promis, Toscana IGT, Tuscany', vintage: '2021', bottle: 95 },
  { wine: 'Cavit Pinot Grigio, Trentino, Italy', vintage: '2022', bottle: 32 },
  { wine: 'Santa Margherita Pinot Grigio, Valdadige, Italy', vintage: '2022', bottle: 55 },
  { wine: 'Caposaldo Moscato, Italy', vintage: 'NV', bottle: 32 },
  { wine: 'Caposaldo Prosecco, Italy', vintage: 'NV', bottle: 36 },
  { wine: 'La Marca Prosecco, DOC, Italy', vintage: 'NV', bottle: 42 },
  { wine: 'Mionetto Prosecco, DOC, Italy', vintage: 'NV', bottle: 39 },
  { wine: 'Veuve Clicquot Yellow Label Brut, Reims, France', vintage: 'NV', bottle: 145 },
  { wine: 'Moët & Chandon Imperial Brut, Épernay, France', vintage: 'NV', bottle: 135 },
  { wine: 'Caymus Vineyards Cabernet Sauvignon, Napa Valley, California', vintage: '2021', bottle: 145 },
  { wine: 'Silver Oak Cabernet Sauvignon, Alexander Valley, California', vintage: '2019', bottle: 165 },
  { wine: 'Stag’s Leap Wine Cellars Artemis Cabernet Sauvignon, Napa Valley', vintage: '2020', bottle: 110 },
  { wine: 'Justin Vineyards Cabernet Sauvignon, Paso Robles, California', vintage: '2021', bottle: 70 },
  { wine: 'Faust Cabernet Sauvignon, Napa Valley, California', vintage: '2020', bottle: 95 },
  { wine: 'La Crema Pinot Noir, Sonoma Coast, California', vintage: '2021', bottle: 60 },
  { wine: 'Belle Glos Clark & Telephone Pinot Noir, Santa Maria Valley', vintage: '2021', bottle: 85 }
];

/** Visible-on-the-menu wines with NO printed price — must be filtered. */
const UNPRICED: Seed[] = [
  { wine: 'Caparzo, Brunello di Montalcino, DOCG', vintage: '2018' },
  { wine: 'Ratti "Battaglione", Barbera d’Asti, DOCG, Piedmont', vintage: '2020' }
];

const ALL_PRICED: Seed[] = [...GLASS_AND_BOTTLE, ...BOTTLE_ONLY];

function seedToRecord(s: Seed, section: string, page?: number): WineLlmRecord {
  const prices: WineLlmRecord['prices'] = {};
  if (s.glass != null) prices.glass = s.glass;
  if (s.carafe != null) prices.carafe = s.carafe;
  if (s.bottle != null) prices.bottle = s.bottle;
  return {
    page: page ?? null,
    section,
    category: section,
    bin: null,
    wine: s.wine,
    vintage: s.vintage ?? null,
    prices,
    source_pages: page != null ? [page] : []
  };
}

function makePayload(records: WineLlmRecord[], sourceFile: string): string {
  return JSON.stringify({
    source_file: sourceFile,
    wines: records.map((r) => ({
      page: r.page,
      section: r.section,
      category: r.category,
      bin: r.bin,
      wine: r.wine,
      vintage: r.vintage,
      prices: r.prices,
      source_pages: r.source_pages
    }))
  });
}

/**
 * Page split for the 4-page PDF rendering path:
 *   page 1 -> Wines by the Glass (BTG + bottle prices)
 *   page 2 -> Bottle list block A (first half of BOTTLE_ONLY)
 *   page 3 -> Bottle list block B (second half of BOTTLE_ONLY)
 *   page 4 -> Tail of bottle list incl. the unpriced rows (must be dropped)
 */
function fakeVisionForPage(pageNum: number, sourceFile: string): string {
  if (pageNum === 1) {
    const recs = GLASS_AND_BOTTLE.map((s) => seedToRecord(s, 'Wines by the Glass', 1));
    return makePayload(recs, sourceFile);
  }
  if (pageNum === 2) {
    const half = BOTTLE_ONLY.slice(0, Math.ceil(BOTTLE_ONLY.length / 2));
    return makePayload(half.map((s) => seedToRecord(s, 'Bottle List', 2)), sourceFile);
  }
  if (pageNum === 3) {
    const half = BOTTLE_ONLY.slice(Math.ceil(BOTTLE_ONLY.length / 2));
    return makePayload(half.map((s) => seedToRecord(s, 'Bottle List', 3)), sourceFile);
  }
  // page 4 — unpriced wines visible at the bottom; an over-eager model might
  // emit them. The normalizer must drop them because they have no price.
  const recs = UNPRICED.map((s) => seedToRecord(s, 'Bottle List', 4));
  return makePayload(recs, sourceFile);
}

/**
 * Tile split for the tall-image path. Real tiling produces overlapping crops,
 * so we deliberately repeat a few wines across adjacent tiles to exercise the
 * dedupe path — without the fix, the count would be inflated by every
 * duplicate.
 */
function fakeVisionForTile(tileIndex: number, tileCount: number, sourceFile: string): string {
  // Distribute ALL_PRICED across the tiles, then repeat the boundary wines on
  // the next tile. Adjacent tiles also occasionally see only the glass column
  // or only the bottle column for the same wine — we simulate this by
  // dropping a price field on the duplicate copy, so the merge fix must
  // recombine them into one record.
  const total = ALL_PRICED.length;
  const sliceSize = Math.ceil(total / tileCount);
  const start = tileIndex * sliceSize;
  const end = Math.min(total, start + sliceSize);
  const slice = ALL_PRICED.slice(start, end);
  const records: WineLlmRecord[] = [];
  for (const s of slice) {
    records.push(seedToRecord(s, s.glass != null ? 'Wines by the Glass' : 'Bottle List', tileIndex + 1));
  }
  // Overlap: last 2 of the previous tile reappear here, with partial prices
  // (simulating a partial column crop) so the merge must restore them.
  if (tileIndex > 0) {
    const prev = ALL_PRICED.slice(Math.max(0, start - 2), start);
    for (const s of prev) {
      const partial: Seed = { wine: s.wine, vintage: s.vintage };
      // Only carry the glass price across the boundary (lose the bottle).
      if (s.glass != null) partial.glass = s.glass;
      else if (s.bottle != null) partial.bottle = s.bottle;
      records.push(seedToRecord(partial, s.glass != null ? 'Wines by the Glass' : 'Bottle List', tileIndex + 1));
    }
  }
  // Last tile also includes the unpriced rows so we verify they're filtered.
  if (tileIndex === tileCount - 1) {
    for (const s of UNPRICED) {
      records.push(seedToRecord(s, 'Bottle List', tileIndex + 1));
    }
  }
  return makePayload(records, sourceFile);
}

function priceCount(e: WineLlmExtraction): number {
  let n = 0;
  for (const w of e.wines) {
    if (w.prices.glass != null || w.prices.carafe != null || w.prices.half_bottle != null || w.prices.bottle != null) {
      n += 1;
    }
  }
  return n;
}

function namesOf(e: WineLlmExtraction): string[] {
  return e.wines
    .map((w) => `${w.wine}`.toLowerCase().replace(/\s+/g, ' ').trim())
    .sort();
}

function hasUnpriced(e: WineLlmExtraction): string[] {
  const out: string[] = [];
  for (const w of e.wines) {
    if (
      w.prices.glass == null &&
      w.prices.carafe == null &&
      w.prices.half_bottle == null &&
      w.prices.bottle == null
    ) {
      out.push(w.wine);
    }
  }
  return out;
}

async function runPdfPath(sourceFile: string, pageCount: number): Promise<WineLlmExtraction> {
  const images = Array.from({ length: pageCount }, (_, i) =>
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, i + 1])
  );
  const pageNumbers = images.map((_, i) => i + 1);
  return extractWinesWithVision({
    sourceFile,
    images,
    pageNumbers,
    callVision: async (_input) => {
      // The new helper invokes callVision once per image, so we can recover
      // which page we're on from the userText.
      const m = _input.userText.match(/page-(\d+)/);
      const page = m ? Number(m[1]) : 1;
      return fakeVisionForPage(page, sourceFile);
    }
  });
}

async function runTilePath(sourceFile: string, imagePath: string): Promise<WineLlmExtraction & { tileCount: number }> {
  const buf = await readFile(imagePath);
  const dims = readImageDimensions(buf);
  if (!dims) throw new Error('cannot read dimensions of fixture image');
  const { rects, shouldTile } = computeVerticalTiles(dims);
  if (!shouldTile) throw new Error('fixture image is not tall enough to tile — refusing to validate');
  const tileCount = rects.length;
  return extractWinesFromImageUpload({
    sourceFile,
    imageBuffer: buf,
    callVision: async (_input) => {
      // The image-upload helper assigns each tile a 1-indexed page-N label in
      // the same way as the PDF path; recover the index from the prompt.
      const m = _input.userText.match(/page-(\d+)/);
      const idx = m ? Number(m[1]) - 1 : 0;
      return fakeVisionForTile(idx, tileCount, sourceFile);
    }
  });
}

async function main() {
  const exists = await stat(WINE_JPG).then(() => true, () => false);
  if (!exists) {
    console.warn(`[skip] fixture not found at ${WINE_JPG} — set up the workspace fixture to run this test.`);
    process.exitCode = 0;
    return;
  }

  // --- PDF (4 rendered pages) path ------------------------------------------
  const pdfExtraction = await runPdfPath('Maggiano-s-Little-Italy-Wine-Menu-1.pdf', 4);
  record(
    'PDF route: every record has at least one price',
    hasUnpriced(pdfExtraction).length === 0,
    `unpriced count=${hasUnpriced(pdfExtraction).length}`
  );
  record(
    'PDF route: priced wines == ALL_PRICED count',
    priceCount(pdfExtraction) === ALL_PRICED.length,
    `got=${priceCount(pdfExtraction)} expected=${ALL_PRICED.length}`
  );
  record(
    'PDF route: unpriced fixture rows NOT included',
    !pdfExtraction.wines.some((w) => /caparzo|battaglione/i.test(w.wine)),
    `wines containing caparzo/battaglione: ${pdfExtraction.wines.filter((w) => /caparzo|battaglione/i.test(w.wine)).length}`
  );

  // --- Tall image (tile) path -----------------------------------------------
  const tileExtraction = await runTilePath('Maggiano-s-Little-Italy-Wine-Menu-2.jpg', WINE_JPG);
  record(
    'Tall-image route: every record has at least one price',
    hasUnpriced(tileExtraction).length === 0,
    `unpriced count=${hasUnpriced(tileExtraction).length}`
  );
  record(
    'Tall-image route: priced wines == ALL_PRICED count (overlap deduped)',
    priceCount(tileExtraction) === ALL_PRICED.length,
    `got=${priceCount(tileExtraction)} expected=${ALL_PRICED.length} tiles=${tileExtraction.tileCount}`
  );
  record(
    'Tall-image route: unpriced fixture rows NOT included',
    !tileExtraction.wines.some((w) => /caparzo|battaglione/i.test(w.wine)),
    ''
  );

  // --- Parity ----------------------------------------------------------------
  const pdfNames = namesOf(pdfExtraction);
  const tileNames = namesOf(tileExtraction);
  const sameSet =
    pdfNames.length === tileNames.length && pdfNames.every((n, i) => n === tileNames[i]);
  record(
    'PDF and tall-image routes return the SAME wine set',
    sameSet,
    `pdf=${pdfNames.length} tile=${tileNames.length}`
  );

  // --- Merge sanity (direct mergeExtractions check) --------------------------
  const a = await runPdfPath('a.pdf', 4);
  const b = await runPdfPath('a.pdf', 4);
  const merged = mergeExtractions([a, b], { sourceFile: 'a.pdf' });
  record(
    'mergeExtractions is idempotent when fed the same extraction twice',
    merged.wines.length === a.wines.length,
    `merged=${merged.wines.length} expected=${a.wines.length}`
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
