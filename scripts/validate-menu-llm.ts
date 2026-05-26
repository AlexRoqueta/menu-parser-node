/**
 * Validate the LLM meal-menu extraction pipeline.
 *
 * Default (no LLM call): asserts the post-processing layer
 *   (validateAndNormalizeMenu + toTableSommDishes) faithfully round-trips a
 *   representative target JSON and that the noise filters drop beverages,
 *   headings, disclaimers, and empty entries.
 *
 * Live mode (--live):
 *   - Requires OPENAI_API_KEY.
 *   - Reads --pdf=PATH or falls back to a packaged text fixture, then calls
 *     extractMenuWithLlm and prints summary metrics.
 *
 * Usage:
 *   tsx scripts/validate-menu-llm.ts
 *   tsx scripts/validate-menu-llm.ts --live --pdf=/path/to/menu.pdf
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  extractMenuWithLlm,
  toTableSommDishes,
  validateAndNormalizeMenu,
  type MenuLlmExtraction
} from '../src/menuLlmParser.js';
import { extractPdfPages } from '../src/wineLlmParser.js';

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
  path.resolve('scripts/fixtures/sample_menu_raw.json')
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
  const target = JSON.parse(raw) as MenuLlmExtraction;

  // 1. Round-trip through validator: should preserve every clean dish.
  const normalized = validateAndNormalizeMenu(target, {
    sourceFile: target.source_file ?? 'unknown'
  });
  assert(
    normalized.dishes.length === target.dishes.length,
    `validateAndNormalizeMenu preserves dish count (${normalized.dishes.length}/${target.dishes.length})`
  );
  assert(
    normalized.dish_count === normalized.dishes.length,
    `dish_count is recomputed (${normalized.dish_count})`
  );
  assert(
    normalized.extraction_scope.toLowerCase().includes('food'),
    'extraction_scope retained'
  );

  // 2. Validator drops beverages, headings, disclaimers, empty names.
  const polluted = {
    source_file: 'x',
    dishes: [
      { name: '', price: 10 }, // empty name
      { name: '*', price: 1 }, // junk
      { name: 'ENTREES', price: null }, // section heading
      { name: 'DRINKS' }, // beverage heading
      { name: 'Cabernet Sauvignon', price: 18 }, // wine
      { name: 'Negroni Cocktail', price: 16 }, // cocktail
      { name: 'Old Fashioned', price: 16, section: 'Cocktails' }, // beverage section
      { name: 'Disclaimer: consuming raw shellfish', price: null }, // disclaimer
      { name: 'Pan-Seared Scallops', price: 38, description: 'Cauliflower, capers' },
      { name: 'Caesar Salad', price: 18 }
    ]
  };
  const cleaned = validateAndNormalizeMenu(polluted, { sourceFile: 'x' });
  const cleanedNames = cleaned.dishes.map((d) => d.name);
  assert(
    cleanedNames.includes('Pan-Seared Scallops') && cleanedNames.includes('Caesar Salad'),
    'keeps real dishes (Pan-Seared Scallops, Caesar Salad)'
  );
  assert(!cleanedNames.includes('ENTREES'), 'drops bare section heading ENTREES');
  assert(!cleanedNames.includes('DRINKS'), 'drops beverage heading');
  assert(
    !cleanedNames.some((n) => /cabernet|negroni|old fashioned/i.test(n)),
    'drops beverages (wine + cocktails)'
  );
  assert(
    !cleanedNames.some((n) => /disclaimer/i.test(n)),
    'drops disclaimer-style entries'
  );
  assert(!cleanedNames.includes('*'), 'drops junk/punctuation-only entries');

  // 3. Shellfish + raw-bar inference.
  const inference = validateAndNormalizeMenu(
    {
      source_file: 'x',
      dishes: [
        { name: 'Steamed Lobster', section: 'Crustaceans' },
        { name: 'Bluefin Tuna Tartare', section: 'Raw Bar' },
        { name: 'Roasted Chicken', section: 'Entrees' }
      ]
    },
    { sourceFile: 'x' }
  );
  const lobster = inference.dishes.find((d) => d.name === 'Steamed Lobster')!;
  const tartare = inference.dishes.find((d) => d.name === 'Bluefin Tuna Tartare')!;
  const chicken = inference.dishes.find((d) => d.name === 'Roasted Chicken')!;
  assert(lobster.contains_shellfish === true, 'lobster inferred as shellfish');
  assert(tartare.is_raw_bar === true, 'tartare inferred as raw-bar');
  assert(chicken.contains_shellfish === false, 'chicken not flagged as shellfish');
  assert(chicken.is_raw_bar === false, 'chicken not flagged as raw-bar');

  // 4. Price tier coercion (strings ok).
  const tiers = validateAndNormalizeMenu(
    {
      source_file: 'x',
      dishes: [
        {
          name: 'Oysters',
          section: 'Raw Bar',
          price: '4.50',
          price_tiers: [
            { label: 'Each', price: '4.50' },
            { label: '½ Dozen', price: 24 },
            { label: '1 Dozen', price: '$46.00' }
          ]
        }
      ]
    },
    { sourceFile: 'x' }
  );
  const oys = tiers.dishes[0];
  assert(oys.price === 4.5, 'string price coerced to number');
  assert(oys.price_tiers!.length === 3, 'all tiers retained');
  assert(oys.price_tiers![2].price === 46, 'currency-symbol price coerced');

  // 5. TableSomm mapping.
  const dishes = toTableSommDishes(normalized);
  assert(dishes.length === normalized.dishes.length, 'toTableSommDishes preserves count');
  const rawBar = dishes.find((d) => d.isRawBar);
  assert(rawBar !== undefined, 'has at least one raw-bar dish');
  if (rawBar) {
    assert(rawBar.tags.includes('raw-bar'), 'raw-bar tag added');
    assert(typeof rawBar.name === 'string' && rawBar.name.length > 0, 'dish name preserved');
  }
  const shell = dishes.find((d) => d.containsShellfish);
  assert(shell !== undefined, 'has at least one shellfish dish');
  if (shell) assert(shell.tags.includes('shellfish'), 'shellfish tag added');

  // 6. No dish should be a beverage or heading after mapping.
  const leaked = dishes.filter((d) =>
    /^(menu|dinner|entrees?|raw bar|sides|desserts?|salads?|sandwiches?)$/i.test(d.name.trim())
  );
  assert(leaked.length === 0, 'no dishes collapse to bare section headings');

  // 7. Sanity on prices.
  const badPrices = dishes.filter(
    (d) => d.price != null && (d.price <= 0 || d.price > 100000)
  );
  assert(badPrices.length === 0, 'all dish prices in plausible range');

  return { normalized, dishes };
}

async function runLiveTest(args: Args) {
  console.log('\n== Live LLM test ==');
  if (!process.env.OPENAI_API_KEY) {
    console.log('  · OPENAI_API_KEY not set — skipping live test.');
    return;
  }
  const pdfPath = args.pdf;
  if (!pdfPath) {
    console.log('  · pass --pdf=/path/to/menu.pdf to run the live extractor');
    return;
  }

  const buf = await fs.readFile(pdfPath);
  const pages = await extractPdfPages(buf);
  const rawText = pages.join('\n\n');
  const sourceFile = path.basename(pdfPath);
  console.log(`  · Read PDF (${pages.length} pages, ${rawText.length} chars)`);

  const extraction = await extractMenuWithLlm({ sourceFile, pages, rawText });
  console.log(`  · LLM returned ${extraction.dishes.length} dishes`);
  if (args.out) {
    await fs.writeFile(args.out, JSON.stringify(extraction, null, 2));
    console.log(`  · Wrote ${args.out}`);
  }

  assert(extraction.dishes.length > 0, 'live extraction returned at least one dish');
  const named = extraction.dishes.filter((d) => d.name && d.name.length > 1);
  assert(named.length === extraction.dishes.length, 'every dish has a real name');
}

async function main() {
  const args = parseArgs(process.argv);
  const targetPath = args.target ?? (await findExisting(DEFAULT_TARGET_CANDIDATES));
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
