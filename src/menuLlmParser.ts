/**
 * LLM-backed extractor for restaurant FOOD menus (the `/parse-menu` endpoint).
 *
 * Mirrors the architecture of wineLlmParser.ts: take the raw text extracted
 * from a PDF or image upload, send it to OpenAI with a strict structured
 * prompt, then validate and map the response into the TableSomm dish shape
 * used by the frontend.
 *
 * Scope (full meals only, wine-pairable):
 * The extractor returns only full meal items reasonably pairable with wine —
 * entrees, whole fish, steaks, large composed plates such as cioppino,
 * lobster rolls, sandwiches, composed entree salads, and "live" / by-the-pound
 * crustaceans served as a main. It EXCLUDES cocktails and other drinks,
 * appetizers, sushi / sashimi / nigiri / rolls, snacks, raw bar items
 * (oysters, clams, crudo, tartare, ceviche), shellfish platters / towers,
 * sides, soups (incl. lobster bisque), and other non-entree content.
 */
import {
  callOpenAiJson,
  parseLlmJson,
  coerceMoney,
  type ChatMessage,
  type LlmCallOptions
} from './llmClient.js';

export type MealPrice = number | string | Record<string, number | string> | null;

export type DishLlmRecord = {
  name: string;
  category?: string | null;
  section?: string | null;
  description?: string | null;
  price?: MealPrice;
  price_tiers?: { label?: string; price: number }[];
  protein?: string | null;
  style?: string | null;
  tags?: string[];
  ingredients?: string[];
  is_raw_bar?: boolean;
  contains_shellfish?: boolean;
  source_pages?: number[];
};

export type MenuLlmExtraction = {
  source_file: string;
  extraction_scope: string;
  meal_count: number;
  /** Alias of meal_count, retained for backwards compatibility. */
  dish_count: number;
  /** Target name for the list of meals. */
  meals: DishLlmRecord[];
  /** Alias of meals, retained for backwards compatibility. */
  dishes: DishLlmRecord[];
};

export type TableSommDishLlm = {
  id: string;
  name: string;
  section: string;
  category: string;
  protein: string;
  style: string;
  description?: string;
  price: MealPrice;
  priceTiers?: { label?: string; price: number }[];
  tags: string[];
  ingredients?: string[];
  isRawBar?: boolean;
  containsShellfish?: boolean;
  notes: string;
  sourcePages?: number[];
};

export const MENU_LLM_PARSER_VERSION = '2.2.0-llm-chunked';
const DEFAULT_MODEL = 'gpt-4o-mini';
const DEFAULT_EXTRACTION_SCOPE =
  'Only full meal items reasonably pairable with wine. Excludes cocktails, drinks, appetizers, sushi, snacks, raw bar items, shellfish platters, sides, soups, desserts, and other non-entree content.';

// Chunking defaults — small dinner menus are typically 3-4 pages of ~3-4k chars.
// One LLM call per food-relevant page keeps each prompt small and lets the model
// focus on a single section family at a time (Crustaceans, Whole Fish, Entrees,
// Steaks) instead of mixing them with the cocktail / sushi / raw-bar pages.
const DEFAULT_PAGES_PER_CHUNK = 1;
const DEFAULT_CHUNK_CHAR_TARGET = 5000;
const DEFAULT_CHUNK_CONCURRENCY = 3;

const SYSTEM_PROMPT = `You are an expert restaurant menu parser and structured-data extractor.
You are given the raw extracted text of a restaurant FOOD menu (possibly with page markers).
Your task: extract every distinct FULL MEAL item that could reasonably be paired with a glass
or bottle of wine. Return raw JSON only.

EXHAUSTIVE EXTRACTION — return EVERY qualifying meal you see in the input.
Restaurants typically print 25-40 full meals across categories. Do not stop early.
If a section is present (e.g. "ENTREES", "USDA PRIME STEAKS", "WAGYU GOLD",
"WHOLE FISH", "CRUSTACEANS", "SALADS & SANDWICHES", "FIRST OF SEASON"),
extract every distinct dish printed under that heading, including each numbered
cut (e.g. each Filet Mignon size, each Wagyu Gold Filet Mignon size, each
size/cut variation of Ribeye or New York). Each printed cut is a separate meal.

INCLUDE — full meals such as:
- Entrees and mains (fish, seafood, poultry, meat, pasta).
- Whole fish offered as a main course (one entry per fish species printed).
- Steaks (Filet Mignon, NY Strip, Ribeye, Wagyu, etc.). Treat every printed
  cut/size as its own meal — "Filet Mignon 6oz Petite Cut" and "Filet Mignon
  8oz Center Cut" are two distinct meals.
- Composed seafood mains (Cioppino, Shrimp Scampi, Scallops over puree, etc.).
- Live / by-the-pound crustaceans served as a main (whole lobster, king crab,
  spot prawns, soft shell crab, etc.).
- Sandwiches and burgers served as a main (lobster roll, cheeseburger, etc.).
- Composed entree salads sized as a meal (Cobb, Louie, Roasted Chicken & Kale salad).

EXCLUDE — never include:
- Cocktails, beer, wine, spirits, sake, mocktails, coffee, tea, juice, water,
  or any beverage.
- Appetizers, small plates, snacks, shared starters.
- Sushi, sashimi, nigiri, maki, hand rolls, sushi rolls of any kind.
- Raw bar items: oysters, clams, mussels on the half-shell, crudo, tartare,
  ceviche, carpaccio.
- Shellfish platters / towers / "plateau" / iced seafood plateaus.
- Soups (including lobster bisque, clam chowder, gazpacho, French onion).
- Side dishes (fries, mashed potatoes, creamed spinach, broccolini, etc.).
- Desserts and pastries (unless the menu pairs the dessert as a course).
- Section headings on their own line ("ENTREES", "RAW BAR", "SIDES").
- Disclaimers, footnotes, allergen warnings, addresses, hours, gratuity notes.
- "Oysters Rockefeller", "Lobster Bisque", "Shrimp Cocktail", "Tuna Tartare",
  and other classically appetizer / raw-bar dishes even if they sound elaborate.

For each included meal, return:
- "name": the exact menu name of the dish. Preserve diacritics, apostrophes,
  capitalization. Do not invent.
- "category": the menu section the dish belongs to as printed (e.g.
  "Crustaceans", "Whole Fish", "Salads & Sandwiches", "Entrees", "First of
  Season", "USDA Prime Steaks", "Wagyu Gold"). Use the heading nearest above
  the dish in the source text. Required.
- "description": the short prose describing the dish (ingredients,
  preparation). null if the menu has no description. Do not echo the name.
- "price": the price as printed.
  - If a single flat numeric price, return it as a NUMBER (e.g. 46).
  - If priced by weight or with a unit suffix (e.g. "38/pound", "55/lb"),
    return the exact STRING ("38/pound", "55/lb").
  - If multiple sizes are listed, return an OBJECT mapping size label to
    numeric price, using snake_case keys (e.g.
    { "3/4_pound": 62, "1_pound": 82, "1.5_pounds": 122 } or
    { "1_pound": 150, "1.5_pounds": 195 }).
  - If no price is listed, use null.
- "protein": dominant protein when obvious: one of "beef", "pork", "lamb",
  "chicken", "duck", "fish", "shellfish", "vegetable", "pasta", "other", or
  null.
- "style": short qualitative descriptor when obvious: e.g. "grilled",
  "roasted", "seared", "fried", "braised", "steamed", "raw", or null.
- "tags": small array of short lowercase tags ("shellfish", "steak",
  "whole-fish", "sandwich", "salad", "spicy"). Only confident tags.
- "ingredients": small array of notable ingredients from the description.
- "contains_shellfish": true when the dish obviously contains shellfish.
- "source_pages": list of 1-indexed page numbers if "**page-N**" markers
  appear in the input.

OUTPUT FORMAT (raw JSON, no markdown fences, no commentary):
{
  "source_file": "<the file name you were given>",
  "meal_count": <number>,
  "meals": [
    {
      "name": "Wild Eastern Sea Scallops",
      "category": "Entrees",
      "description": "cauliflower puree, curried roasted cauliflower, pickled golden raisins, soy brown butter",
      "price": 49,
      "protein": "shellfish",
      "style": "seared",
      "tags": ["shellfish"],
      "ingredients": ["scallop", "cauliflower", "soy brown butter"],
      "contains_shellfish": true,
      "source_pages": [1]
    }
  ]
}`;

export type ExtractMenuOptions = LlmCallOptions & {
  sourceFile: string;
  extractionScope?: string;
  pages?: string[];
  rawText?: string;
  /**
   * Override the page-chunking target. Set to 0 / negative to disable chunking
   * and send everything in one call (only useful for tiny inputs or tests).
   */
  pagesPerChunk?: number;
  chunkCharTarget?: number;
  /** Max concurrent LLM calls when processing chunks. */
  concurrency?: number;
};

export function buildMenuUserPrompt(opts: {
  sourceFile: string;
  pages?: string[];
  pageNumbers?: number[];
  rawText?: string;
}): string {
  const header = `Source file: ${opts.sourceFile}\n\nExtract full meal items per the rules. Return raw JSON only.\n`;
  if (opts.pages && opts.pages.length > 0) {
    const blocks = opts.pages
      .map((p, i) => {
        const pageNum = opts.pageNumbers ? opts.pageNumbers[i] : i + 1;
        return `**page-${pageNum}**\n${p.trim()}`;
      })
      .join('\n\n');
    return `${header}\n${blocks}`;
  }
  return `${header}\n${opts.rawText ?? ''}`;
}

/**
 * Heuristic: does a page look like it contains full-meal entries (entrees,
 * steaks, whole fish, composed seafood mains, lobster rolls, etc.)? Used to
 * skip pages dominated by cocktails, spirits, raw-bar oysters, sushi rolls,
 * and shellfish platters so we don't waste LLM tokens or invite false
 * positives on those categories. Any uncertainty is resolved by INCLUDING
 * the page.
 */
export function pageLooksLikeMeal(pageText: string): boolean {
  if (!pageText || pageText.trim().length < 40) return false;
  const lc = pageText.toLowerCase();

  const mealCues = [
    'entree',
    'entrees',
    'whole fish',
    'crustacean',
    'steak',
    'wagyu',
    'filet mignon',
    'ribeye',
    'ny strip',
    'new york strip',
    'salads & sandwiches',
    'sandwiches',
    'cioppino',
    'scampi',
    'scallops',
    'halibut',
    'salmon',
    'sea bass',
    'lobster roll',
    'cheeseburger',
    'first of season',
    'usda prime'
  ];
  const mealHits = mealCues.reduce((n, kw) => n + (lc.includes(kw) ? 1 : 0), 0);

  const nonMealCues = [
    ':: cocktails ::',
    ':: spirits ::',
    ':: whiskey ::',
    ':: bourbon ::',
    ':: vodka ::',
    ':: gin ::',
    ':: rum ::',
    ':: tequila ::',
    ':: spirit free ::',
    ':: spirits free ::',
    ':: cans and bottles ::',
    ':: draughts ::',
    ':: raw bar ::',
    ':: sushi ::',
    ':: sushi rolls ::',
    'iced shellfish platters',
    'iced shellfish platter',
    'chilled shellfish',
    ':: chilled shellfish ::'
  ];
  const nonMealHits = nonMealCues.reduce((n, kw) => n + (lc.includes(kw) ? 1 : 0), 0);

  // Reject if the page is dominated by drink/raw-bar/sushi headings and has
  // no real entree cues.
  if (nonMealHits >= 1 && mealHits === 0) return false;
  return true;
}

export type MenuPageChunk = { pageNumbers: number[]; text: string };

/**
 * Group meal-relevant pages into chunks small enough for a single LLM JSON-mode
 * call. Pages dominated by cocktails / raw bar / sushi are filtered out.
 */
export function chunkMenuPages(
  pages: string[],
  opts: { pagesPerChunk?: number; chunkCharTarget?: number } = {}
): MenuPageChunk[] {
  const pagesPerChunk = Math.max(1, opts.pagesPerChunk ?? DEFAULT_PAGES_PER_CHUNK);
  const charTarget = Math.max(500, opts.chunkCharTarget ?? DEFAULT_CHUNK_CHAR_TARGET);
  const chunks: MenuPageChunk[] = [];

  let buf: { idx: number; text: string }[] = [];
  let bufChars = 0;
  const flush = () => {
    if (buf.length === 0) return;
    chunks.push({
      pageNumbers: buf.map((b) => b.idx + 1),
      text: buf.map((b) => `**page-${b.idx + 1}**\n${b.text.trim()}`).join('\n\n')
    });
    buf = [];
    bufChars = 0;
  };

  for (let i = 0; i < pages.length; i++) {
    const text = pages[i] ?? '';
    if (!pageLooksLikeMeal(text)) continue;
    if (buf.length > 0 && (buf.length >= pagesPerChunk || bufChars + text.length > charTarget)) {
      flush();
    }
    buf.push({ idx: i, text });
    bufChars += text.length;
  }
  flush();
  return chunks;
}

export async function callOpenAi(
  messages: ChatMessage[],
  options: LlmCallOptions = {}
): Promise<string> {
  return callOpenAiJson(messages, {
    ...options,
    defaultModel: DEFAULT_MODEL,
    modelEnvVar: 'MENU_PARSER_MODEL'
  });
}

const BEVERAGE_RE =
  /\b(wine|wines|champagne|prosecco|cava|cocktail|cocktails|aperitif|aperitivo|spritz|martini|mojito|margarita|negroni|manhattan|old fashioned|whiskey|whisky|bourbon|scotch|rye|vodka|gin|tequila|mezcal|rum|sake|beer|lager|ale|ipa|stout|pilsner|cider|liqueur|amaro|amari|vermouth|cabernet|merlot|pinot noir|pinot grigio|chardonnay|sauvignon blanc|riesling|syrah|shiraz|malbec|tempranillo|sangiovese|grenache|zinfandel|gewurztraminer|gew(ü|u)rztraminer|chenin blanc|viognier|nebbiolo|barolo|barbaresco|chianti|brunello|rioja|ribera|bordeaux|burgundy|beaujolais|c(ô|o)tes du rh(ô|o)ne|rh(ô|o)ne)\b/i;
const SECTION_HEADING_RE =
  /^(?:menu|dinner|lunch|brunch|breakfast|drinks?|beverages?|wine list|cocktails?|specials?|tonight|today|seasonal|hours?|address|tel|phone|email|website|copyright|gratuity|tip|tax|corkage|page\s*\d+|entrees?|appetizers?|sides?|desserts?|salads?|sandwiches?|soups?|mains?|starters?|small plates?|shared plates?|raw bar|crustaceans|whole fish|steaks?|sushi|sashimi|charcuterie|cheese|wagyu(?: gold)?|usda prime steaks?|first of season)\s*$/i;
const DISCLAIMER_RE =
  /^\s*(disclaimer|notice|warning|allergen|consuming raw|consumer advisory|consumption of raw|gratuity|service charge|please note)\b/i;
const SHELLFISH_RE =
  /\b(shrimp|prawn|crab|lobster|oyster|clam|mussel|scallop|langoustine|crayfish|crawfish|calamari|squid|octopus|cockle|whelk)\b/i;
const RAW_BAR_RE =
  /\braw\s*bar\b/i;

// Categories/sections we treat as non-entree (their items are filtered out).
const EXCLUDED_CATEGORY_RE =
  /\b(raw\s*bar|appetizer|appetizers|starter|starters|small\s*plate|shared\s*plate|snack|snacks|sushi|sashimi|nigiri|maki|hand\s*roll|hand-roll|sushi\s*roll|side|sides|dessert|desserts|soup|soups|cocktail|cocktails|drinks?|beverages?|beer|wine|spirits?|sake|chilled\s*seafood|seafood\s*plateau|plateau|tower|shellfish\s*platter|shellfish\s*tower)\b/i;

// Dish-name patterns for excluded items even when miscategorized by the LLM.
const EXCLUDED_NAME_RE =
  /\b(bisque|chowder|gazpacho|consomm[ée]|french\s*onion|oysters?\s+rockefeller|shrimp\s+cocktail|tuna\s+tartare|tartare|crudo|ceviche|carpaccio|sashimi|nigiri|maki|hand\s*roll|sushi\s*roll|spicy\s+tuna\s+roll|california\s+roll|rainbow\s+roll|dragon\s+roll|oysters?\s+on\s+the\s+half|kumamoto\s+oysters?|kusshi\s+oysters?|fanny\s+bay\s+oysters?|plateau|seafood\s+tower|shellfish\s+(?:platter|tower)|king\s+crab\s+cocktail|jumbo\s+shrimp\s+cocktail|caesar\s+salad\s+\(half\))\b/i;

// Coerce a meal price into the target shape: number | string | object | null.
function normalizeMealPrice(v: unknown): MealPrice {
  if (v == null || v === '') return null;
  if (typeof v === 'number' && Number.isFinite(v)) return Math.round(v * 100) / 100;
  if (typeof v === 'string') {
    const trimmed = v.trim();
    if (!trimmed) return null;
    // Keep "by-the-pound" / unit-suffix prices as strings.
    if (/\/(?:lb|pound|oz|kg|each|ea|piece|pc)\b/i.test(trimmed)) return trimmed;
    // Plain numeric string → number.
    if (/^\$?\s*\d+(?:\.\d+)?$/.test(trimmed)) {
      const n = Number.parseFloat(trimmed.replace(/[^0-9.\-]/g, ''));
      if (Number.isFinite(n)) return Math.round(n * 100) / 100;
    }
    return trimmed;
  }
  if (typeof v === 'object' && !Array.isArray(v)) {
    const out: Record<string, number | string> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (typeof val === 'number' && Number.isFinite(val)) {
        out[k] = Math.round(val * 100) / 100;
      } else if (typeof val === 'string' && val.trim()) {
        const coerced = coerceMoney(val);
        out[k] = coerced ?? val.trim();
      }
    }
    return Object.keys(out).length > 0 ? out : null;
  }
  return null;
}

function shouldExcludeDish(d: any, name: string): boolean {
  if (!name || name.length < 2) return true;
  if (SECTION_HEADING_RE.test(name)) return true;
  if (DISCLAIMER_RE.test(name)) return true;
  if (EXCLUDED_NAME_RE.test(name)) return true;

  const category =
    (typeof d.category === 'string' && d.category) ||
    (typeof d.section === 'string' && d.section) ||
    '';
  if (category) {
    if (BEVERAGE_RE.test(category)) return true;
    if (EXCLUDED_CATEGORY_RE.test(category)) return true;
  }

  // Only reject by beverage-name match if there's no category telling us
  // this is a real food section. Names like "Wagyu Gold New York Steak ...
  // Manhattan Cut" would otherwise be dropped on the cocktail keyword.
  if (BEVERAGE_RE.test(name) && (!category || EXCLUDED_CATEGORY_RE.test(category))) {
    return true;
  }

  if (d.is_raw_bar === true) return true;
  return false;
}

export function validateAndNormalizeMenu(
  payload: unknown,
  opts: { sourceFile: string; extractionScope?: string }
): MenuLlmExtraction {
  const obj = (payload ?? {}) as any;
  const mealsIn: any[] = Array.isArray(obj.meals)
    ? obj.meals
    : Array.isArray(obj.dishes)
      ? obj.dishes
      : Array.isArray(obj.items)
        ? obj.items
        : [];

  const meals: DishLlmRecord[] = [];
  for (const d of mealsIn) {
    if (!d || typeof d !== 'object') continue;
    const name = typeof d.name === 'string' ? d.name.trim() : '';
    if (shouldExcludeDish(d, name)) continue;

    const category =
      typeof d.category === 'string' && d.category.trim()
        ? d.category.trim()
        : typeof d.section === 'string' && d.section.trim()
          ? d.section.trim()
          : null;

    const description =
      typeof d.description === 'string' && d.description.trim() ? d.description.trim() : null;

    const price = normalizeMealPrice(d.price);

    const tiersIn: any[] = Array.isArray(d.price_tiers) ? d.price_tiers : [];
    const priceTiers: { label?: string; price: number }[] = [];
    for (const t of tiersIn) {
      if (!t || typeof t !== 'object') continue;
      const p = coerceMoney(t.price);
      if (p == null) continue;
      const label = typeof t.label === 'string' && t.label.trim() ? t.label.trim() : undefined;
      priceTiers.push(label ? { label, price: p } : { price: p });
    }

    const protein =
      typeof d.protein === 'string' && d.protein.trim() ? d.protein.trim().toLowerCase() : null;
    const style =
      typeof d.style === 'string' && d.style.trim() ? d.style.trim().toLowerCase() : null;

    const tagsIn: any[] = Array.isArray(d.tags) ? d.tags : [];
    const tags = tagsIn
      .map((t) => (typeof t === 'string' ? t.trim().toLowerCase() : ''))
      .filter((t) => t.length > 0);

    const ingredientsIn: any[] = Array.isArray(d.ingredients) ? d.ingredients : [];
    const ingredients = ingredientsIn
      .map((t) => (typeof t === 'string' ? t.trim() : ''))
      .filter((t) => t.length > 0);

    const haystack = `${name} ${description ?? ''} ${category ?? ''}`;
    const inferredShellfish = SHELLFISH_RE.test(haystack);
    const containsShellfish = Boolean(d.contains_shellfish) || inferredShellfish;
    // Full-meal scope explicitly excludes raw-bar items, so is_raw_bar is
    // always false for entries we kept.
    const isRawBar = false;

    const pages = Array.isArray(d.source_pages)
      ? d.source_pages
          .map((p: any) => Number(p))
          .filter((n: number) => Number.isInteger(n) && n > 0)
      : [];

    meals.push({
      name,
      category,
      section: category,
      description,
      price,
      price_tiers: priceTiers,
      protein,
      style,
      tags,
      ingredients,
      is_raw_bar: isRawBar,
      contains_shellfish: containsShellfish,
      source_pages: pages
    });
  }

  return {
    source_file: typeof obj.source_file === 'string' ? obj.source_file : opts.sourceFile,
    extraction_scope:
      typeof obj.extraction_scope === 'string' && obj.extraction_scope.trim()
        ? obj.extraction_scope
        : (opts.extractionScope ?? DEFAULT_EXTRACTION_SCOPE),
    meal_count: meals.length,
    dish_count: meals.length,
    meals,
    dishes: meals
  };
}

/** Build a dedup key for a meal record so chunked extractions don't double up. */
function mealDedupKey(rec: DishLlmRecord): string {
  const name = rec.name.toLowerCase().replace(/[\s'"]+/g, ' ').trim();
  const category = (rec.category ?? rec.section ?? '').toLowerCase().trim();
  return `${name}|${category}`;
}

/**
 * Merge several extractions into one, deduping meals by (name, category) and
 * unioning source_pages for matching entries.
 */
export function mergeMenuExtractions(
  parts: MenuLlmExtraction[],
  opts: { sourceFile: string; extractionScope?: string }
): MenuLlmExtraction {
  const byKey = new Map<string, DishLlmRecord>();
  for (const part of parts) {
    for (const m of part.meals) {
      const key = mealDedupKey(m);
      const existing = byKey.get(key);
      if (!existing) {
        byKey.set(key, { ...m, source_pages: [...(m.source_pages ?? [])] });
      } else {
        const pages = new Set([...(existing.source_pages ?? []), ...(m.source_pages ?? [])]);
        existing.source_pages = Array.from(pages).sort((a, b) => a - b);
        if (!existing.description && m.description) existing.description = m.description;
        if (!existing.category && m.category) existing.category = m.category;
        if (!existing.section && m.section) existing.section = m.section;
        if (existing.price == null && m.price != null) existing.price = m.price;
      }
    }
  }
  const meals = Array.from(byKey.values());
  return {
    source_file: opts.sourceFile,
    extraction_scope: opts.extractionScope ?? DEFAULT_EXTRACTION_SCOPE,
    meal_count: meals.length,
    dish_count: meals.length,
    meals,
    dishes: meals
  };
}

async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const max = Math.max(1, limit);
  const runners: Promise<void>[] = [];
  for (let r = 0; r < Math.min(max, items.length); r++) {
    runners.push(
      (async () => {
        while (true) {
          const i = next++;
          if (i >= items.length) return;
          results[i] = await worker(items[i], i);
        }
      })()
    );
  }
  await Promise.all(runners);
  return results;
}

export async function extractMenuWithLlm(opts: ExtractMenuOptions): Promise<MenuLlmExtraction> {
  const { pages, pagesPerChunk, chunkCharTarget } = opts;
  const useChunking =
    pages && pages.length > 0 && (pagesPerChunk ?? DEFAULT_PAGES_PER_CHUNK) > 0;

  if (!useChunking) {
    const userPrompt = buildMenuUserPrompt({
      sourceFile: opts.sourceFile,
      pages,
      rawText: opts.rawText
    });
    const content = await callOpenAi(
      [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt }
      ],
      opts
    );
    const parsed = parseLlmJson(content);
    return validateAndNormalizeMenu(parsed, {
      sourceFile: opts.sourceFile,
      extractionScope: opts.extractionScope
    });
  }

  const chunks = chunkMenuPages(pages, { pagesPerChunk, chunkCharTarget });
  if (chunks.length === 0) {
    return {
      source_file: opts.sourceFile,
      extraction_scope: opts.extractionScope ?? DEFAULT_EXTRACTION_SCOPE,
      meal_count: 0,
      dish_count: 0,
      meals: [],
      dishes: []
    };
  }

  const partials = await runWithConcurrency(
    chunks,
    opts.concurrency ?? DEFAULT_CHUNK_CONCURRENCY,
    async (chunk) => {
      const chunkPagesText = chunk.pageNumbers.map((n) => pages[n - 1] ?? '');
      const userPrompt = buildMenuUserPrompt({
        sourceFile: opts.sourceFile,
        pages: chunkPagesText,
        pageNumbers: chunk.pageNumbers
      });
      const content = await callOpenAi(
        [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userPrompt }
        ],
        opts
      );
      const parsed = parseLlmJson(content);
      const part = validateAndNormalizeMenu(parsed, {
        sourceFile: opts.sourceFile,
        extractionScope: opts.extractionScope
      });
      for (const m of part.meals) {
        if (!m.source_pages || m.source_pages.length === 0) {
          m.source_pages = [...chunk.pageNumbers];
        }
      }
      return part;
    }
  );

  return mergeMenuExtractions(partials, {
    sourceFile: opts.sourceFile,
    extractionScope: opts.extractionScope
  });
}

function inferStyleFromCategory(category: string | null): string {
  if (!category) return '';
  const c = category.toLowerCase();
  if (/steak|wagyu|filet|ribeye|ny\s*strip/.test(c)) return 'steak';
  if (/whole\s*fish/.test(c)) return 'whole-fish';
  if (/sandwich/.test(c)) return 'sandwich';
  if (/salad/.test(c)) return 'salad';
  if (/crustacean/.test(c)) return 'crustacean';
  return '';
}

export function toTableSommDish(rec: DishLlmRecord, index: number): TableSommDishLlm {
  const tags = Array.from(new Set([...(rec.tags ?? [])]));
  if (rec.contains_shellfish && !tags.includes('shellfish')) tags.push('shellfish');
  const styleHint = inferStyleFromCategory(rec.category ?? rec.section ?? null);
  if (styleHint && !tags.includes(styleHint)) tags.push(styleHint);

  const category = rec.category ?? rec.section ?? 'Entrees';
  const section = rec.section ?? rec.category ?? 'Entrees';

  const notes =
    rec.source_pages && rec.source_pages.length > 0
      ? `Source page${rec.source_pages.length > 1 ? 's' : ''}: ${rec.source_pages.join(', ')}`
      : '';

  return {
    id: `dish-${index + 1}`,
    name: rec.name,
    section,
    category,
    protein: rec.protein ?? '',
    style: rec.style ?? styleHint,
    description: rec.description ?? undefined,
    price: rec.price ?? null,
    priceTiers: rec.price_tiers && rec.price_tiers.length > 0 ? rec.price_tiers : undefined,
    tags,
    ingredients: rec.ingredients && rec.ingredients.length > 0 ? rec.ingredients : undefined,
    isRawBar: false,
    containsShellfish: rec.contains_shellfish,
    notes,
    sourcePages: rec.source_pages
  };
}

export function toTableSommDishes(extraction: MenuLlmExtraction): TableSommDishLlm[] {
  return extraction.meals.map((d, i) => toTableSommDish(d, i));
}

export {
  DEFAULT_EXTRACTION_SCOPE,
  DEFAULT_MODEL,
  DEFAULT_PAGES_PER_CHUNK,
  DEFAULT_CHUNK_CHAR_TARGET,
  DEFAULT_CHUNK_CONCURRENCY,
  SYSTEM_PROMPT
};
