/**
 * Validate the LLM wine extraction pipeline.
 *
 * Default (no LLM call): asserts that the post-processing layer
 *   (validateAndNormalize + toTableSommWines) faithfully reproduces a known-good
 *   target JSON. Uses /home/user/workspace/watergrill_wines_raw.json by default
 *   so we can compare without spending tokens.
 *
 * Live mode (--live):
 *   - Requires OPENAI_API_KEY.
 *   - Reads the fixture PDF path passed via --pdf=PATH (default:
 *     /home/user/workspace/Watergrill-wine-menu.pdf if present, else the
 *     packaged text fixture).
 *   - Calls extractWinesWithLlm and prints summary metrics.
 *
 * Usage:
 *   tsx scripts/validate-wine-llm.ts
 *   tsx scripts/validate-wine-llm.ts --live --pdf=/path/to/wine.pdf
 *   tsx scripts/validate-wine-llm.ts --target=/path/to/target.json
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  extractPdfPages,
  extractWinesWithLlm,
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

  // 2. Validator drops items without a wine string or any price.
  const polluted = {
    source_file: 'x',
    wines: [
      { wine: '', prices: { glass: 10 } }, // empty name
      { wine: 'Region heading', prices: {} }, // no prices
      { wine: 'Real Wine', prices: { glass: '15.00' } }, // string price OK
      { wine: 'Another Wine', prices: { bottle: 50 } }
    ]
  };
  const cleaned = validateAndNormalize(polluted, { sourceFile: 'x' });
  assert(cleaned.wines.length === 2, 'drops empty-name and no-price entries');
  assert(cleaned.wines[0].prices.glass === 15, 'parses numeric strings into numbers');

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
