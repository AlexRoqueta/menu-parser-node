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
  chunkMenuPages,
  extractMenuWithLlm,
  mergeMenuExtractions,
  pageLooksLikeMeal,
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

  // 0. The Water Grill fixture must declare exactly 35 meals, matching the
  //    ChatGPT target extraction. Other fixtures use a flexible count.
  if (/water_grill_full_meals\.json$/i.test(targetPath)) {
    assert(declaredCount === 35, `Water Grill fixture meal_count is 35 (got ${declaredCount})`);
    assert(targetMeals.length === 35, `Water Grill fixture has 35 meals (got ${targetMeals.length})`);
  }

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

  // 8. TableSomm mapping preserves every meal and assigns name, category,
  //    section, description, and price for every dish.
  const dishes = toTableSommDishes(normalized);
  assert(dishes.length === normalized.meals.length, 'toTableSommDishes preserves count');
  const withoutCategory = dishes.filter((d) => !d.category || d.category === '');
  assert(withoutCategory.length === 0, 'every dish has a category');
  const withoutSection = dishes.filter((d) => !d.section || d.section === '');
  assert(withoutSection.length === 0, 'every dish has a section');
  const nameMismatch = dishes.filter((d, i) => d.name !== normalized.meals[i].name);
  assert(nameMismatch.length === 0, 'TableSomm dish name matches full meal name');
  const dishesWithTargetDesc = dishes.filter((d, i) => {
    const want = normalized.meals[i].description;
    if (!want) return true;
    return d.description === want;
  });
  assert(
    dishesWithTargetDesc.length === dishes.length,
    'every TableSomm dish carries the target description verbatim'
  );
  const dishesWithMatchedPrice = dishes.filter((d, i) => {
    return priceSnapshot(d.price as any) === priceSnapshot(normalized.meals[i].price);
  });
  assert(
    dishesWithMatchedPrice.length === dishes.length,
    'every TableSomm dish carries the meal price (number / string / object)'
  );
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

async function runChunkingTests() {
  console.log('\n== Chunking / page-relevance tests ==');

  // Mocked page text from a Water-Grill-style menu: cocktails page, raw bar
  // page, salads + crustaceans page, entrees + steaks page. Only pages 3 and
  // 4 should survive page-relevance filtering.
  const cocktailsPage = `:: SPIRIT FREE ::\nFREE SPIRITED 16.50\n:: COCKTAILS ::\nBRISTOL STREET 17.00\n:: APPETIZERS ::\nCLAM CHOWDER 16\n:: SUSHI ::\nGARDEN ROLL 19`;
  const rawBarPage = `ICED SHELLFISH PLATTERS\nKUMAMOTO OYSTERS 4.20\n:: RAW BAR ::\nWILD LITTLENECK CLAMS 3.40\n:: CHILLED SHELLFISH ::\nDUNGENESS CRAB 38`;
  const saladsCrustaceansPage = `:: SALADS & SANDWICHES ::\nROASTED CHICKEN & BABY KALE SALAD 32\nWILD JUMBO SHRIMP LOUIE SALAD 35\nBACON CHEDDAR CHEESEBURGER 25\nNEW ENGLAND LOBSTER ROLL 38\n:: CRUSTACEANS ::\nWILD MARYLAND SOFT SHELL CRAB 53\nLIVE WILD NORTH AMERICAN HARD SHELL LOBSTER 38/POUND\nLIVE WILD SANTA BARBARA SPOT PRAWNS 62/3⁄4 POUND 82/POUND 122/1½ POUNDS\n:: WHOLE FISH ::\nCHARCOAL GRILLED OR WHOLE CRISPY FRIED`;
  const entreesSteaksPage = `:: ENTREES ::\nWILD ICELANDIC COD FISH & CHIPS 37\nWILD PACIFIC BIGEYE TUNA 46\nCIOPPINO 45\n:: USDA PRIME STEAKS ::\nFILET MIGNON 6oz Petite Cut 58\nFILET MIGNON 8oz Center Cut 62\n:: WAGYU GOLD ::\nWAGYU FLIGHT 105`;

  assert(!pageLooksLikeMeal(cocktailsPage), 'pageLooksLikeMeal rejects cocktails / sushi page');
  assert(!pageLooksLikeMeal(rawBarPage), 'pageLooksLikeMeal rejects raw-bar / shellfish-platter page');
  assert(pageLooksLikeMeal(saladsCrustaceansPage), 'pageLooksLikeMeal keeps salads / crustaceans page');
  assert(pageLooksLikeMeal(entreesSteaksPage), 'pageLooksLikeMeal keeps entrees / steaks page');

  const pages = [cocktailsPage, rawBarPage, saladsCrustaceansPage, entreesSteaksPage];
  const chunks = chunkMenuPages(pages);
  assert(chunks.length === 2, `chunkMenuPages produces 2 chunks (got ${chunks.length})`);
  const chunkedPageNumbers = chunks.flatMap((c) => c.pageNumbers).sort();
  assert(
    chunkedPageNumbers.join(',') === '3,4',
    `chunkMenuPages keeps pages 3 and 4 (got ${chunkedPageNumbers.join(',')})`
  );
  for (const c of chunks) {
    assert(c.text.includes('**page-'), 'chunk text labels source page numbers');
  }

  // mergeMenuExtractions should dedupe by (name, category) and union source_pages.
  const a = validateAndNormalizeMenu(
    {
      source_file: 'x',
      meals: [
        { name: 'Wild Eastern Sea Scallops', category: 'Entrees', price: 49, source_pages: [3] },
        { name: 'Cioppino', category: 'Entrees', price: 45, source_pages: [3] }
      ]
    },
    { sourceFile: 'x' }
  );
  const b = validateAndNormalizeMenu(
    {
      source_file: 'x',
      meals: [
        // Same dish from another chunk — should merge by (name, category).
        { name: 'Wild Eastern Sea Scallops', category: 'Entrees', price: 49, source_pages: [4] },
        { name: 'Filet Mignon 6oz Petite Cut', category: 'USDA Prime Steaks', price: 58, source_pages: [4] }
      ]
    },
    { sourceFile: 'x' }
  );
  const merged = mergeMenuExtractions([a, b], { sourceFile: 'x' });
  assert(merged.meals.length === 3, `merge dedupes to 3 distinct meals (got ${merged.meals.length})`);
  const scallops = merged.meals.find((m) => m.name === 'Wild Eastern Sea Scallops')!;
  assert(
    (scallops.source_pages ?? []).join(',') === '3,4',
    'merge unions source_pages across chunks for duplicates'
  );
}

async function runMockedExtractionTest() {
  console.log('\n== Mocked end-to-end chunked extraction ==');
  // Fake OpenAI fetch that returns a per-chunk JSON payload keyed on page numbers
  // found in the prompt. This mirrors what the live LLM would emit for each
  // chunk and lets us assert the chunk plumbing + merge produce a 35-meal
  // result without making a real API call.
  const TARGET = JSON.parse(
    await fs.readFile(path.resolve('scripts/fixtures/water_grill_full_meals.json'), 'utf8')
  );
  const targetMeals: any[] = Array.isArray(TARGET.meals) ? TARGET.meals : [];

  // Synthetic 4-page input: pages 1+2 are noise; pages 3-4 contain meal text.
  // The mock fetch ignores text content and routes by the **page-N** markers,
  // emitting the matching slice of target meals per page.
  const pages = [
    ':: COCKTAILS ::\nBRISTOL STREET 17.00\n:: APPETIZERS ::\nCLAM CHOWDER 16\n:: SUSHI ::\nGARDEN ROLL 19',
    'ICED SHELLFISH PLATTERS\nKUMAMOTO 4.20\n:: RAW BAR ::\nWILD LITTLENECK CLAMS 3.40',
    ':: SALADS & SANDWICHES ::\nROASTED CHICKEN & BABY KALE SALAD 32\n:: CRUSTACEANS ::\nWILD MARYLAND SOFT SHELL CRAB 53\n:: WHOLE FISH ::\nWILD NEW ZEALAND PINK BREAM 38/lb',
    ':: ENTREES ::\nCIOPPINO 45\n:: USDA PRIME STEAKS ::\nFILET MIGNON 6oz Petite Cut 58\n:: WAGYU GOLD ::\nWAGYU FLIGHT 105'
  ];

  // Split the target meals across pages 3 and 4 the way they appear on the
  // real PDF: Crustaceans, Salads & Sandwiches, Whole Fish → page 3; First of
  // Season, Entrees, Steaks, Wagyu → page 4.
  const page3Categories = new Set(['Crustaceans', 'Salads & Sandwiches', 'Whole Fish']);
  const page3Meals = targetMeals.filter((m) => page3Categories.has(m.category));
  const page4Meals = targetMeals.filter((m) => !page3Categories.has(m.category));

  const mockFetch: any = async (_url: string, init: any) => {
    const body = JSON.parse(init.body);
    const userContent = body.messages.find((m: any) => m.role === 'user').content as string;
    const containsPage3 = /\*\*page-3\*\*/.test(userContent);
    const containsPage4 = /\*\*page-4\*\*/.test(userContent);
    const meals: any[] = [];
    if (containsPage3) for (const m of page3Meals) meals.push({ ...m, source_pages: [3] });
    if (containsPage4) for (const m of page4Meals) meals.push({ ...m, source_pages: [4] });
    const payload = {
      source_file: 'WaterGrillDinnermenu.pdf',
      meal_count: meals.length,
      meals
    };
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      async text() {
        return '';
      },
      async json() {
        return { choices: [{ message: { content: JSON.stringify(payload) } }] };
      }
    };
  };

  const extraction = await extractMenuWithLlm({
    sourceFile: 'WaterGrillDinnermenu.pdf',
    pages,
    apiKey: 'fake-test-key',
    fetchImpl: mockFetch
  });

  assert(extraction.meal_count === 35, `mocked extraction returns 35 meals (got ${extraction.meal_count})`);
  assert(extraction.meals.length === 35, 'mocked extraction meals array has 35 entries');
  const names = extraction.meals.map((m) => m.name);
  assert(names.includes('Wild Maryland Soft Shell Crab'), 'mocked extraction includes Crustaceans');
  assert(names.includes('Cioppino'), 'mocked extraction includes Entrees');
  assert(names.includes('Wagyu Flight'), 'mocked extraction includes Wagyu Gold');
  assert(names.includes('Wild New Zealand Pink Bream'), 'mocked extraction includes Whole Fish');
  const forbidden = ['Lobster Bisque', 'Oysters Rockefeller', 'Spicy Tuna Roll', 'Garden Roll', 'Bristol Street'];
  for (const f of forbidden) {
    assert(!names.includes(f), `mocked extraction excludes "${f}"`);
  }

  const dishes = toTableSommDishes(extraction);
  assert(dishes.length === 35, `TableSomm mapping yields 35 dishes (got ${dishes.length})`);
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
  await runChunkingTests();
  await runMockedExtractionTest();
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
