/**
 * Validate the LLM wine extraction pipeline.
 *
 * Default (no LLM call): asserts that the post-processing layer
 *   (validateAndNormalize + mergeExtractions + toTableSommWines) faithfully
 *   reproduces a known-good target JSON, that bottle-only entries are
 *   preserved, and that chunking + merging round-trips the full 233-record
 *   Watergrill target. Uses /home/user/workspace/watergrill_wines_raw.json by
 *   default so we can compare without spending tokens.
 *
 * Live mode (--live):
 *   - Requires OPENAI_API_KEY.
 *   - Reads the fixture PDF path passed via --pdf=PATH (default:
 *     /home/user/workspace/Watergrill-wine-menu.pdf if present, else the
 *     packaged text fixture).
 *   - Calls extractWinesWithLlm (chunked) and prints summary metrics.
 *
 * Usage:
 *   tsx scripts/validate-wine-llm.ts
 *   tsx scripts/validate-wine-llm.ts --live --pdf=/path/to/wine.pdf --out=live.json
 *   tsx scripts/validate-wine-llm.ts --target=/path/to/target.json
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  chunkPages,
  extractPdfPages,
  extractWinesWithLlm,
  mergeExtractions,
  pageLooksLikeWine,
  toTableSommWines,
  validateAndNormalize,
  type WineLlmExtraction
} from '../src/wineLlmParser.js';

type Args = {
  live: boolean;
  target?: string;
  pdf?: string;
  text?: string;
  out?: string;
};

function parseArgs(argv: string[]): Args {
  const args: Args = { live: false };
  for (const a of argv.slice(2)) {
    if (a === '--live') args.live = true;
    else if (a.startsWith('--target=')) args.target = a.slice('--target='.length);
    else if (a.startsWith('--pdf=')) args.pdf = a.slice('--pdf='.length);
    else if (a.startsWith('--text=')) args.text = a.slice('--text='.length);
    else if (a.startsWith('--out=')) args.out = a.slice('--out='.length);
  }
  return args;
}

const DEFAULT_TARGET_CANDIDATES = [
  '/home/user/workspace/watergrill_wines_raw.json',
  path.resolve('scripts/fixtures/watergrill_wines_raw.json')
];

async function findExisting(paths: string[]): Promise<string | null> {
  for (const p of paths) {
    try {
      await fs.access(p);
      return p;
    } catch {
      // continue
    }
  }
  return null;
}

function assert(cond: any, msg: string) {
  if (!cond) {
    console.error('  ✗', msg);
    process.exitCode = 1;
  } else {
    console.log('  ✓', msg);
  }
}

async function runPostProcessingTests(targetPath: string) {
  console.log(`\n== Post-processing tests (target: ${targetPath}) ==`);
  const raw = await fs.readFile(targetPath, 'utf8');
  const target = JSON.parse(raw) as WineLlmExtraction;

  // 1. Round-trip through validator: should preserve every wine.
  const normalized = validateAndNormalize(target, {
    sourceFile: target.source_file ?? 'unknown'
  });
  assert(
    normalized.wines.length === target.wines.length,
    `validateAndNormalize preserves wine count (${normalized.wines.length}/${target.wines.length})`
  );
  assert(
    normalized.wine_count === normalized.wines.length,
    `wine_count is recomputed (${normalized.wine_count})`
  );
  assert(
    normalized.extraction_scope.toLowerCase().includes('glass'),
    'extraction_scope retained'
  );

  // 1b. Bottle-only wines (no glass, no half) are preserved.
  const bottleOnlyTarget = target.wines.filter(
    (w) => w.prices.bottle != null && w.prices.glass == null && w.prices.half_bottle_carafe == null
  );
  const bottleOnlyNorm = normalized.wines.filter(
    (w) => w.prices.bottle != null && w.prices.glass == null && w.prices.half_bottle_carafe == null
  );
  assert(
    bottleOnlyNorm.length === bottleOnlyTarget.length,
    `bottle-only entries preserved (${bottleOnlyNorm.length} / ${bottleOnlyTarget.length} expected)`
  );

  // 2. Validator drops items without a wine string or any price.
  const polluted = {
    source_file: 'x',
    wines: [
      { wine: '', prices: { glass: 10 } }, // empty name
      { wine: 'Region heading', prices: {} }, // no prices
      { wine: 'Real Wine', prices: { glass: '15.00' } }, // string price OK
      { wine: 'Bottle Only Wine', prices: { bottle: 50 } }
    ]
  };
  const cleaned = validateAndNormalize(polluted, { sourceFile: 'x' });
  assert(cleaned.wines.length === 2, 'drops empty-name and no-price entries');
  assert(cleaned.wines[0].prices.glass === 15, 'parses numeric strings into numbers');
  assert(
    cleaned.wines[1].prices.bottle === 50 &&
      cleaned.wines[1].prices.glass == null &&
      cleaned.wines[1].prices.half_bottle_carafe == null,
    'bottle-only record kept with bottle price only'
  );

  // 3. Vintage normalization.
  const vintageCases = validateAndNormalize(
    {
      source_file: 'x',
      wines: [
        { wine: 'A', vintage: '2022', prices: { bottle: 1 } },
        { wine: 'B', vintage: 'NV', prices: { bottle: 1 } },
        { wine: 'C', vintage: 'nv', prices: { bottle: 1 } },
        { wine: 'D', vintage: '2022 Reserve', prices: { bottle: 1 } },
        { wine: 'E', vintage: null, prices: { bottle: 1 } }
      ]
    },
    { sourceFile: 'x' }
  );
  assert(vintageCases.wines[0].vintage === '2022', 'vintage 4-digit kept');
  assert(vintageCases.wines[1].vintage === 'NV', 'NV uppercased');
  assert(vintageCases.wines[2].vintage === 'NV', 'nv → NV');
  assert(vintageCases.wines[3].vintage === '2022', 'vintage extracted from messy string');
  assert(vintageCases.wines[4].vintage === null, 'null vintage preserved');

  // 4. Category normalization.
  const categoryCases = validateAndNormalize(
    {
      source_file: 'x',
      wines: [
        { wine: 'A', category: 'red', prices: { bottle: 1 } },
        { wine: 'B', category: 'sparkling wines', prices: { bottle: 1 } },
        { wine: 'C', category: 'Rose', prices: { bottle: 1 } },
        { wine: 'D', category: 'orange', prices: { bottle: 1 } }
      ]
    },
    { sourceFile: 'x' }
  );
  assert(categoryCases.wines[0].category === 'Red', 'red → Red');
  assert(categoryCases.wines[1].category === 'Sparkling', 'sparkling wines → Sparkling');
  assert(categoryCases.wines[2].category === 'Rosé', 'Rose → Rosé');
  assert(categoryCases.wines[3].category === 'Orange', 'orange → Orange');

  // 5. TableSomm mapping.
  const wines = toTableSommWines(normalized);
  assert(wines.length === normalized.wines.length, 'toTableSommWines preserves count');
  const sample = wines.find((w) => w.glassPrice != null && w.halfBottlePrice != null);
  assert(sample !== undefined, 'has at least one wine with glass + half-bottle');
  if (sample) {
    assert(
      sample.priceTiers && sample.priceTiers.length >= 2,
      `priceTiers populated (${sample.priceTiers?.length} tiers)`
    );
    assert(typeof sample.name === 'string' && sample.name.length > 0, 'wine name preserved');
    assert(
      sample.tags.includes('by-the-glass') && sample.tags.includes('half-bottle-carafe'),
      'tags include by-the-glass and half-bottle-carafe'
    );
  }
  const bottleSample = wines.find(
    (w) => w.bottlePrice != null && w.glassPrice == null && w.halfBottlePrice == null
  );
  assert(bottleSample !== undefined, 'has at least one bottle-only wine after mapping');
  if (bottleSample) {
    assert(
      bottleSample.tags.includes('bottle') &&
        !bottleSample.tags.includes('by-the-glass'),
      'bottle-only wine tagged "bottle" but not "by-the-glass"'
    );
    assert(
      bottleSample.priceTiers?.length === 1 && bottleSample.priceTiers[0].label === 'Bottle',
      'bottle-only wine has a single Bottle priceTier'
    );
    assert(
      bottleSample.price === bottleSample.bottlePrice,
      'primary price falls back to bottlePrice for bottle-only wines'
    );
    assert(
      typeof bottleSample.name === 'string' && bottleSample.name.includes(','),
      'bottle-only wine name retains full identity (commas → producer/region/country)'
    );
  }

  // 6. No wines should be just a region/heading fragment.
  const fragmentLike = wines.filter((w) =>
    /^(red|white|rose|rosé|sparkling|champagne|orange|by the glass|france|italy|usa|california|napa)$/i.test(
      w.name.trim()
    )
  );
  assert(fragmentLike.length === 0, 'no wines collapse to bare region/heading fragments');

  // 7. Sanity on price values.
  const badPrices = wines.filter(
    (w) =>
      (w.glassPrice != null && (w.glassPrice <= 0 || w.glassPrice > 10000)) ||
      (w.bottlePrice != null && (w.bottlePrice <= 0 || w.bottlePrice > 100000)) ||
      (w.halfBottlePrice != null && (w.halfBottlePrice <= 0 || w.halfBottlePrice > 100000))
  );
  assert(badPrices.length === 0, 'all prices in plausible range');

  return { normalized, wines };
}

/**
 * Simulate the chunk → LLM → merge pipeline by partitioning the target JSON by
 * source_pages and treating each partition as if it were the LLM's answer for
 * that chunk. This exercises mergeExtractions and bottle-only preservation
 * without spending tokens.
 */
async function runChunkedMergeTest(targetPath: string) {
  console.log(`\n== Chunked-merge round-trip (target: ${targetPath}) ==`);
  const raw = await fs.readFile(targetPath, 'utf8');
  const target = JSON.parse(raw) as WineLlmExtraction;
  // Bucket wines by their first source page; emulate the per-chunk
  // extraction that the new pipeline will produce.
  const buckets = new Map<number, WineLlmExtraction>();
  for (const w of target.wines) {
    const pg = (w.source_pages && w.source_pages[0]) ?? 0;
    if (!buckets.has(pg)) {
      buckets.set(pg, {
        source_file: target.source_file,
        extraction_scope: target.extraction_scope,
        wine_count: 0,
        wines: []
      });
    }
    buckets.get(pg)!.wines.push(w);
  }
  for (const e of buckets.values()) e.wine_count = e.wines.length;
  console.log(`  · simulated ${buckets.size} chunks`);

  const merged = mergeExtractions(Array.from(buckets.values()), {
    sourceFile: target.source_file,
    extractionScope: target.extraction_scope
  });
  assert(merged.wines.length === target.wines.length, `merge preserves count (${merged.wines.length}/${target.wines.length})`);

  // Same input twice should dedupe down to the same count.
  const dup = mergeExtractions(
    [...buckets.values(), ...buckets.values()],
    {
      sourceFile: target.source_file,
      extractionScope: target.extraction_scope
    }
  );
  assert(
    dup.wines.length === target.wines.length,
    `merging duplicates dedupes back to ${target.wines.length}`
  );

  const mappedWines = toTableSommWines(merged);
  const bottleOnly = mappedWines.filter(
    (w) => w.bottlePrice != null && w.glassPrice == null && w.halfBottlePrice == null
  );
  assert(bottleOnly.length > 0, `bottle-only wines survive merge → mapping (${bottleOnly.length})`);
}

/**
 * Mocked LLM end-to-end test: feed extractWinesWithLlm fake page content and a
 * mocked fetchImpl that returns the wines we expect from each chunk. Confirms
 * chunking + per-chunk LLM call + merge produces the right output without
 * touching the network.
 */
async function runMockedExtractTest() {
  console.log('\n== Mocked extractWinesWithLlm pipeline ==');
  // Three fake pages: page 1 by-the-glass, pages 2 & 3 bottle list. With
  // default pagesPerChunk = 2 this should issue 2 LLM calls.
  const pages = [
    [
      ':: WINES BY THE GLASS ::',
      'Pinot Gris, Cooper Mountain, Willamette Valley, OR 2023 14.5 28',
      'Chardonnay, Sean Minor, Sonoma Coast, CA 2023 15 29'
    ].join('\n'),
    [
      ':: CHAMPAGNE & SPARKLING WINE ::',
      "1004 Gloria Ferrer Sonoma Brut, Sonoma, CA NV 66",
      "1006 Nicolas Feuillatte Réserve Exclusive Brut, Epernay, Champagne NV 98"
    ].join('\n'),
    [
      ':: PINOT NOIR ::',
      '200 Torii Mor, Willamette Valley, OR 2023 57',
      '420 Goldeneye, Anderson Valley, Mendocino, CA 2022 122'
    ].join('\n')
  ];

  const fakeResponses: Record<string, unknown> = {
    'page-1': {
      source_file: 'mock.pdf',
      wines: [
        {
          wine: 'Pinot Gris, Cooper Mountain, Willamette Valley, OR',
          vintage: '2023',
          category: 'White',
          bin: null,
          prices: { glass: 14.5, half_bottle_carafe: 28 },
          source_pages: [1]
        },
        {
          wine: 'Chardonnay, Sean Minor, Sonoma Coast, CA',
          vintage: '2023',
          category: 'White',
          bin: null,
          prices: { glass: 15, half_bottle_carafe: 29 },
          source_pages: [1]
        }
      ]
    },
    'page-2': {
      source_file: 'mock.pdf',
      wines: [
        {
          wine: 'Gloria Ferrer Sonoma Brut, Sonoma, CA',
          vintage: 'NV',
          category: 'Sparkling',
          bin: '1004',
          prices: { bottle: 66 },
          source_pages: [2]
        },
        {
          wine: 'Nicolas Feuillatte Réserve Exclusive Brut, Epernay, Champagne',
          vintage: 'NV',
          category: 'Champagne',
          bin: '1006',
          prices: { bottle: 98 },
          source_pages: [2]
        },
        {
          wine: 'Torii Mor Pinot Noir, Willamette Valley, OR',
          vintage: '2023',
          category: 'Red',
          bin: '200',
          prices: { bottle: 57 },
          source_pages: [3]
        },
        {
          wine: 'Goldeneye Pinot Noir, Anderson Valley, Mendocino, CA',
          vintage: '2022',
          category: 'Red',
          bin: '420',
          prices: { bottle: 122 },
          source_pages: [3]
        }
      ]
    }
  };

  let calls = 0;
  const fetchImpl: any = async (_url: string, init: any) => {
    calls += 1;
    const body = JSON.parse(init.body);
    const userMsg = body.messages.find((m: any) => m.role === 'user')?.content ?? '';
    let key = 'page-1';
    if (/page-2/.test(userMsg) || /page-3/.test(userMsg)) key = 'page-2';
    if (/page-1/.test(userMsg)) key = 'page-1';
    const payload = fakeResponses[key];
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      async json() {
        return {
          choices: [
            {
              message: { content: JSON.stringify(payload) }
            }
          ]
        };
      },
      async text() {
        return '';
      }
    };
  };

  const result = await extractWinesWithLlm({
    sourceFile: 'mock.pdf',
    pages,
    apiKey: 'test',
    fetchImpl
  });
  assert(calls === 2, `pipeline issued one call per chunk (got ${calls}, expected 2)`);
  assert(result.wines.length === 6, `merged result has 6 wines (got ${result.wines.length})`);
  const bottleOnly = result.wines.filter(
    (w) => w.prices.bottle != null && w.prices.glass == null && w.prices.half_bottle_carafe == null
  );
  assert(bottleOnly.length === 4, `bottle-only wines preserved across chunks (got ${bottleOnly.length})`);
  const byGlass = result.wines.filter((w) => w.prices.glass != null);
  assert(byGlass.length === 2, `by-glass wines preserved (got ${byGlass.length})`);
  const sourcePagesUnion = new Set(result.wines.flatMap((w) => w.source_pages ?? []));
  assert(
    sourcePagesUnion.has(1) && sourcePagesUnion.has(2) && sourcePagesUnion.has(3),
    `merged source_pages cover all chunk pages (${Array.from(sourcePagesUnion).sort().join(',')})`
  );
}

async function runChunkingTests() {
  console.log('\n== Chunk + page filtering tests ==');
  // pageLooksLikeWine
  const cocktailPage =
    ':: COCKTAILS :: BRISTOL STREET 17.00 Grainger\'s organic vodka, strawberries, lemon';
  const winePage =
    ':: SPARKLING :: Saracco Moscato d\'Asti, Piedmont, Italy 2024 13\nChardonnay, Sean Minor 15';
  const spiritsPage = ':: SPIRITS :: :: WHISKEY :: Evan Williams Bardstown KY 86 proof 13.5';
  assert(!pageLooksLikeWine(cocktailPage), 'cocktail page rejected');
  assert(pageLooksLikeWine(winePage), 'wine page accepted');
  assert(!pageLooksLikeWine(spiritsPage), 'spirits page rejected');
  assert(!pageLooksLikeWine(''), 'empty page rejected');

  // chunkPages groups pages and emits **page-N** markers
  const pages = [
    '', // page 1 empty / cover
    cocktailPage, // page 2 cocktails (skipped)
    winePage, // page 3
    winePage, // page 4
    winePage, // page 5
    winePage // page 6
  ];
  const chunks = chunkPages(pages, { pagesPerChunk: 2, chunkCharTarget: 100000 });
  assert(chunks.length === 2, `expected 2 chunks from 4 wine pages at 2/chunk (got ${chunks.length})`);
  assert(chunks[0].pageNumbers.join(',') === '3,4', `first chunk pages 3,4 (got ${chunks[0].pageNumbers.join(',')})`);
  assert(chunks[1].pageNumbers.join(',') === '5,6', `second chunk pages 5,6 (got ${chunks[1].pageNumbers.join(',')})`);
  assert(chunks[0].text.includes('**page-3**'), 'chunk text marks page-3');
  assert(chunks[0].text.includes('**page-4**'), 'chunk text marks page-4');

  // Char-target driven flush: when each wine page exceeds the (clamped) char
  // target, every wine page should end up in its own chunk even with a large
  // pagesPerChunk. We use 600-char pages and clamp-min target (500) to trigger.
  const bigText =
    winePage +
    '\n' +
    'Pinot Noir, Argyle Reserve, Willamette Valley, OR 2023 21 41\n'.repeat(10);
  const bigPages = ['', cocktailPage, bigText, bigText, bigText, bigText];
  const tinyChunks = chunkPages(bigPages, { pagesPerChunk: 4, chunkCharTarget: 500 });
  assert(
    tinyChunks.length === 4,
    `char-target overflow produces one chunk per wine page (got ${tinyChunks.length})`
  );
}

async function runLiveTest(args: Args) {
  console.log('\n== Live LLM test ==');
  if (!process.env.OPENAI_API_KEY) {
    console.log('  · OPENAI_API_KEY not set — skipping live test.');
    return;
  }
  const pdfPath = args.pdf ?? '/home/user/workspace/Watergrill-wine-menu.pdf';
  const textFixture =
    args.text ?? path.resolve('scripts/fixtures/watergrill-wine-menu.txt');

  let pages: string[] | undefined;
  let rawText: string;
  let sourceFile: string;
  try {
    const buf = await fs.readFile(pdfPath);
    pages = await extractPdfPages(buf);
    rawText = pages.join('\n\n');
    sourceFile = path.basename(pdfPath);
    console.log(`  · Read PDF (${pages.length} pages, ${rawText.length} chars)`);
  } catch {
    rawText = await fs.readFile(textFixture, 'utf8');
    sourceFile = path.basename(textFixture);
    console.log(`  · Read text fixture (${rawText.length} chars)`);
  }

  const extraction = await extractWinesWithLlm({
    sourceFile,
    pages,
    rawText
  });
  console.log(`  · LLM returned ${extraction.wines.length} wines`);
  if (args.out) {
    await fs.writeFile(args.out, JSON.stringify(extraction, null, 2));
    console.log(`  · Wrote ${args.out}`);
  }

  assert(extraction.wines.length > 0, 'live extraction returned at least one wine');
  const withPrices = extraction.wines.filter(
    (w) => w.prices.glass != null || w.prices.half_bottle_carafe != null || w.prices.bottle != null
  );
  assert(
    withPrices.length === extraction.wines.length,
    'every wine has at least one price'
  );
  const bottleOnly = extraction.wines.filter(
    (w) => w.prices.bottle != null && w.prices.glass == null && w.prices.half_bottle_carafe == null
  );
  assert(bottleOnly.length > 0, `live extraction returns bottle-only wines (${bottleOnly.length})`);
  // For Watergrill we expect to cover the full list. Use a soft floor of 200
  // (target is 233) — anything less means we're still under-extracting.
  if (/watergrill/i.test(sourceFile)) {
    assert(
      extraction.wines.length >= 200,
      `Watergrill extraction recovers ≥200 wines (got ${extraction.wines.length}; target 233)`
    );
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const targetPath =
    args.target ?? (await findExisting(DEFAULT_TARGET_CANDIDATES));
  if (!targetPath) {
    console.error('No target JSON found. Pass --target=/path/to/target.json');
    process.exit(1);
  }

  await runPostProcessingTests(targetPath);
  await runChunkedMergeTest(targetPath);
  await runChunkingTests();
  await runMockedExtractTest();
  if (args.live) {
    await runLiveTest(args);
  }

  if (process.exitCode && process.exitCode !== 0) {
    console.error('\nValidation FAILED');
  } else {
    console.log('\nValidation passed.');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
