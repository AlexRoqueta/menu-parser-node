/**
 * Validate the LLM meal-menu extraction pipeline.
 *
 * Default (no LLM call): asserts the post-processing layer
 *   (validateAndNormalizeMenu + toTableSommDishes) faithfully round-trips a
 *   representative target JSON (the Water Grill full-meals fixture) and that
 *   the noise filters drop beverages, raw-bar items, appetizers, sushi,
 *   shellfish platters, soups, sides, and other non-entree content.
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
  type DishLlmRecord,
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
  path.resolve('scripts/fixtures/water_grill_full_meals.json'),
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

type RawTarget = {
  source_file?: string;
  meal_count?: number;
  meals?: any[];
  dishes?: any[];
};

function getTargetMeals(target: RawTarget): any[] {
  if (Array.isArray(target.meals)) return target.meals;
  if (Array.isArray(target.dishes)) return target.dishes;
  return [];
}

// Items the screenshot showed leaking through TableSomm — none of these
// should ever appear when the fixture is Water Grill's full-meals JSON.
const FORBIDDEN_NAME_PATTERNS = [
  /lobster\s+bisque/i,
  /oysters?\s+rockefeller/i,
  /\bsushi\b/i,
  /\bsashimi\b/i,
  /\bnigiri\b/i,
  /\bmaki\b/i,
  /\bhand\s*roll/i,
  /shellfish\s+(?:platter|tower)/i,
  /seafood\s+(?:platter|tower|plateau)/i,
  /shrimp\s+cocktail/i,
  /\btartare\b/i,
  /\bcrudo\b/i,
  /\bceviche\b/i
];

function priceSnapshot(p: DishLlmRecord['price']): string {
  if (p == null) return 'null';
  if (typeof p === 'number') return String(p);
  if (typeof p === 'string') return p;
  return JSON.stringify(p);
}

async function runPostProcessingTests(targetPath: string) {
  console.log(`\n== Post-processing tests (target: ${targetPath}) ==`);
  const raw = await fs.readFile(targetPath, 'utf8');
  const target = JSON.parse(raw) as RawTarget;
  const targetMeals = getTargetMeals(target);
  const declaredCount = target.meal_count ?? targetMeals.length;

  // 1. Round-trip through validator: should preserve every target meal.
  const normalized = validateAndNormalizeMenu(target, {
    sourceFile: target.source_file ?? 'unknown'
  });
  assert(
    normalized.meals.length === targetMeals.length,
    `validateAndNormalizeMenu preserves meal count (${normalized.meals.length}/${targetMeals.length})`
  );
  assert(
    normalized.meal_count === declaredCount,
    `meal_count matches declared (${normalized.meal_count}/${declaredCount})`
  );
  assert(
    normalized.dish_count === normalized.meal_count,
    'dish_count alias equals meal_count'
  );
  assert(
    normalized.extraction_scope.toLowerCase().includes('full meal'),
    'extraction_scope mentions full meals'
  );

  // 2. Every target meal name must survive verbatim.
  const targetNames = targetMeals.map((m: any) => String(m.name).trim());
  const normalizedNames = normalized.meals.map((m) => m.name);
  const missingNames = targetNames.filter((n: string) => !normalizedNames.includes(n));
  assert(missingNames.length === 0, `every target meal name preserved (missing: ${missingNames.length})`);

  // 3. Every target meal price must round-trip (number stays number,
  //    string stays string, object stays object with same keys).
  let priceMismatches = 0;
  for (const tm of targetMeals) {
    const norm = normalized.meals.find((m) => m.name === String(tm.name).trim());
    if (!norm) continue;
    const before = priceSnapshot(tm.price);
    const after = priceSnapshot(norm.price);
    if (before !== after) {
      priceMismatches++;
      console.error(`    price drift for "${tm.name}": ${before} -> ${after}`);
    }
  }
  assert(priceMismatches === 0, 'all target prices round-trip exactly');

  // 4. Every target description preserved.
  let descMismatches = 0;
  for (const tm of targetMeals) {
    const norm = normalized.meals.find((m) => m.name === String(tm.name).trim());
    if (!norm) continue;
    const wanted = typeof tm.description === 'string' ? tm.description.trim() : null;
    if (wanted && norm.description !== wanted) {
      descMismatches++;
      console.error(`    description drift for "${tm.name}"`);
    }
  }
  assert(descMismatches === 0, 'all target descriptions round-trip');

  // 5. Validator drops noise: beverages, raw bar, appetizers, sushi,
  //    shellfish platters, soups, sides, headings, disclaimers.
  const polluted = {
    source_file: 'x',
    meals: [
      { name: '', price: 10 },
      { name: '*', price: 1 },
      { name: 'ENTREES', price: null },
      { name: 'DRINKS' },
      { name: 'Cabernet Sauvignon', price: 18, category: 'Wines by the Glass' },
      { name: 'Negroni Cocktail', price: 16, category: 'Cocktails' },
      { name: 'Old Fashioned', price: 16, category: 'Cocktails' },
      { name: 'Disclaimer: consuming raw shellfish', price: null },
      { name: 'Lobster Bisque', price: 18, category: 'Soups' },
      { name: 'Oysters Rockefeller', price: 22, category: 'Raw Bar' },
      { name: 'Kumamoto Oysters', price: 4.5, category: 'Raw Bar' },
      { name: 'Tuna Tartare', price: 24, category: 'Appetizers' },
      { name: 'Spicy Tuna Roll', price: 18, category: 'Sushi' },
      { name: 'California Roll', price: 16, category: 'Sushi Rolls' },
      { name: 'Shellfish Tower', price: 120, category: 'Raw Bar' },
      { name: 'Shrimp Cocktail', price: 22, category: 'Appetizers' },
      { name: 'French Fries', price: 9, category: 'Sides' },
      { name: 'Wild Eastern Sea Scallops', price: 49, category: 'Entrees', description: 'cauliflower puree' },
      { name: 'Filet Mignon 8oz', price: 62, category: 'USDA Prime Steaks' }
    ]
  };
  const cleaned = validateAndNormalizeMenu(polluted, { sourceFile: 'x' });
  const cleanedNames = cleaned.meals.map((d) => d.name);
  assert(
    cleanedNames.includes('Wild Eastern Sea Scallops') && cleanedNames.includes('Filet Mignon 8oz'),
    'keeps real full meals (Scallops, Filet Mignon)'
  );
  for (const pat of FORBIDDEN_NAME_PATTERNS) {
    assert(
      !cleanedNames.some((n) => pat.test(n)),
      `drops items matching ${pat}`
    );
  }
  assert(!cleanedNames.includes('ENTREES'), 'drops bare section heading ENTREES');
  assert(!cleanedNames.includes('French Fries'), 'drops sides (French Fries)');
  assert(
    !cleanedNames.some((n) => /cabernet|negroni|old fashioned/i.test(n)),
    'drops beverages (wine + cocktails)'
  );
  assert(
    !cleanedNames.some((n) => /disclaimer/i.test(n)),
    'drops disclaimer-style entries'
  );

  // 6. None of the screenshot false positives should appear in our normalized
  //    Water Grill output. (Guard against accidentally including them via
  //    the fixture itself.)
  for (const pat of FORBIDDEN_NAME_PATTERNS) {
    const inFixture = targetNames.some((n: string) => pat.test(n));
    if (inFixture) continue;
    assert(
      !normalizedNames.some((n) => pat.test(n)),
      `normalized output excludes ${pat}`
    );
  }

  // 7. Price-shape coercion: number / string / object.
  const shape = validateAndNormalizeMenu(
    {
      source_file: 'x',
      meals: [
        { name: 'Filet Mignon 6oz', category: 'Steaks', price: 58 },
        { name: 'Whole Dover Sole', category: 'Whole Fish', price: '55/lb' },
        {
          name: 'Live Spot Prawns',
          category: 'Crustaceans',
          price: { '3/4_pound': 62, '1_pound': 82, '1.5_pounds': 122 }
        }
      ]
    },
    { sourceFile: 'x' }
  );
  const filet = shape.meals.find((m) => m.name === 'Filet Mignon 6oz')!;
  const sole = shape.meals.find((m) => m.name === 'Whole Dover Sole')!;
  const prawns = shape.meals.find((m) => m.name === 'Live Spot Prawns')!;
  assert(filet.price === 58, 'number price preserved');
  assert(sole.price === '55/lb', 'by-the-pound string price preserved');
  assert(
    prawns.price &&
      typeof prawns.price === 'object' &&
      !Array.isArray(prawns.price) &&
      (prawns.price as any)['1_pound'] === 82,
    'multi-size object price preserved'
  );

  // 8. TableSomm mapping preserves every meal and assigns category/section.
  const dishes = toTableSommDishes(normalized);
  assert(dishes.length === normalized.meals.length, 'toTableSommDishes preserves count');
  const withoutCategory = dishes.filter((d) => !d.category || d.category === '');
  assert(withoutCategory.length === 0, 'every dish has a category');
  const leaked = dishes.filter((d) =>
    /^(menu|dinner|entrees?|raw bar|sides|desserts?|salads?|sandwiches?)$/i.test(d.name.trim())
  );
  assert(leaked.length === 0, 'no dish collapses to a bare section heading');

  // 9. Shellfish tag inference.
  const shellfish = dishes.filter((d) => d.containsShellfish);
  if (shellfish.length > 0) {
    assert(
      shellfish.every((d) => d.tags.includes('shellfish')),
      'every shellfish dish carries the shellfish tag'
    );
  }

  // 10. None of the kept meals should be flagged isRawBar.
  assert(
    dishes.every((d) => d.isRawBar === false),
    'no kept meal is flagged as raw-bar'
  );

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

  const extraction: MenuLlmExtraction = await extractMenuWithLlm({ sourceFile, pages, rawText });
  console.log(`  · LLM returned ${extraction.meals.length} meals`);
  if (args.out) {
    await fs.writeFile(args.out, JSON.stringify(extraction, null, 2));
    console.log(`  · Wrote ${args.out}`);
  }

  assert(extraction.meals.length > 0, 'live extraction returned at least one meal');
  const named = extraction.meals.filter((d) => d.name && d.name.length > 1);
  assert(named.length === extraction.meals.length, 'every meal has a real name');
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
