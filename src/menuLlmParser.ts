/**
 * LLM-backed extractor for restaurant FOOD menus (the `/parse-menu` endpoint).
 *
 * Mirrors the architecture of wineLlmParser.ts: take the raw text extracted
 * from a PDF or image upload, send it to OpenAI with a strict structured
 * prompt, then validate and map the response into the TableSomm dish shape
 * used by the frontend. Designed to be restaurant-agnostic — the prompt
 * describes general categories (Raw Bar / Appetizers / Entrees / Sides /
 * Desserts / etc.) and the validator drops anything that is clearly a
 * beverage, heading, disclaimer, or empty placeholder.
 */
import {
  callOpenAiJson,
  parseLlmJson,
  coerceMoney,
  type ChatMessage,
  type LlmCallOptions
} from './llmClient.js';

export type DishLlmRecord = {
  name: string;
  section?: string | null;
  description?: string | null;
  price?: number | null;
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
  dish_count: number;
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
  price: number | null;
  priceTiers?: { label?: string; price: number }[];
  tags: string[];
  ingredients?: string[];
  isRawBar?: boolean;
  containsShellfish?: boolean;
  notes: string;
  sourcePages?: number[];
};

export const MENU_LLM_PARSER_VERSION = '2.0.0-llm';
const DEFAULT_MODEL = 'gpt-4o-mini';
const DEFAULT_EXTRACTION_SCOPE =
  'Only actual food/menu dishes with a real name; wine, cocktails, beer, spirits, section headings, disclaimers, and program notes excluded.';

const SYSTEM_PROMPT = `You are an expert restaurant menu parser and structured-data extractor.
You are given the raw extracted text of a restaurant FOOD menu (possibly with page markers).
Your task: extract every distinct DISH or food item that has a real dish name. Return raw JSON only.

STRICT RULES:
- Include only food/menu dishes: appetizers, raw bar items (oysters, clams, shellfish platters,
  crudo, tartare, ceviche), salads, soups, sandwiches, entrees, steaks, sides, desserts,
  bread, charcuterie, cheese, pasta, pizza, sushi/sashimi, and similar food items.
- EXCLUDE anything that is a beverage: wine, beer, cocktails, spirits, sake, mocktails,
  juice, coffee, tea, water.
- EXCLUDE section headings on their own line (e.g. "ENTREES", "RAW BAR", "SIDES",
  "FROM THE GRILL"). The heading should populate the "section" of dishes that follow,
  not become a dish itself.
- EXCLUDE disclaimers, footnotes, corkage/program notes, allergen warnings, hours of
  operation, addresses, social handles, gratuity/tax notes, and similar non-dish text.
- EXCLUDE entries with no usable dish name (empty, single punctuation, "*", page numbers).
- A dish entry MUST have a "name" that is the actual menu name of the dish. Do not invent.
- Preserve diacritics and apostrophes exactly as printed.
- "section" is the menu section the dish belongs to (e.g. "Raw Bar", "Appetizers",
  "Entrees", "Sides", "Desserts", "Sandwiches", "Salads", "Steaks", "Whole Fish",
  "Crustaceans", "Pasta"). Use the heading nearest above the dish in the source text.
  If unknown, use null.
- "description" is the short prose describing the dish (ingredients, preparation). If
  no description text exists in the menu, use null. Do not echo the dish name.
- "price" is the primary numeric price in dollars without currency symbol. If the dish
  has multiple sizes/tiers, set "price" to the lowest tier and populate "price_tiers"
  with { label, price } for each, e.g. [{ "label": "Each", "price": 4.5 },
  { "label": "½ Dozen", "price": 24 }]. If the dish has no listed price (a market-price
  whole fish, for instance) use null.
- "protein" is the dominant protein when obvious from the name or description: one of
  "beef", "pork", "lamb", "chicken", "duck", "fish", "shellfish", "vegetable", "egg",
  "cheese", "pasta", "other", or null when unclear.
- "style" is a short qualitative descriptor when obvious: e.g. "grilled", "raw",
  "roasted", "fried", "braised", "smoked", "cured", "baked", "steamed", or null.
- "tags" is a small array of short lowercase tags inferable from name/description:
  e.g. "raw-bar", "shellfish", "gluten-free", "vegetarian", "vegan", "spicy",
  "shared-plate". Only include tags you are confident about.
- "ingredients" is a small array of notable ingredients listed in the menu description
  (e.g. ["scallop", "yuzu", "olive oil"]). Skip if the description is empty.
- "is_raw_bar" true when the dish is from a raw bar / iced shellfish section
  (oysters, clams, raw shellfish platters, crudo, tartare, ceviche).
- "contains_shellfish" true when the dish obviously contains shellfish (shrimp, crab,
  lobster, oyster, clam, mussel, scallop, prawn, langoustine, crayfish, calamari).
- "source_pages" is the list of page numbers (1-indexed) where the dish appears, if
  the input contains page markers of the form "**page-N**". Use an empty array if
  pages are unknown.

OUTPUT FORMAT (raw JSON, no markdown fences, no commentary):
{
  "source_file": "<the file name you were given>",
  "extraction_scope": "Only actual food/menu dishes with a real name; wine, cocktails, beer, spirits, section headings, disclaimers, and program notes excluded.",
  "dish_count": <number>,
  "dishes": [
    {
      "name": "Maine Lobster Roll",
      "section": "Sandwiches",
      "description": "Warm butter, brioche bun, lemon",
      "price": 32.0,
      "price_tiers": [],
      "protein": "shellfish",
      "style": "warm",
      "tags": ["shellfish"],
      "ingredients": ["lobster", "butter", "brioche", "lemon"],
      "is_raw_bar": false,
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
};

export function buildMenuUserPrompt(opts: {
  sourceFile: string;
  pages?: string[];
  rawText?: string;
}): string {
  const header = `Source file: ${opts.sourceFile}\n\nExtract dishes per the rules. Return raw JSON only.\n`;
  if (opts.pages && opts.pages.length > 0) {
    const blocks = opts.pages
      .map((p, i) => `**page-${i + 1}**\n${p.trim()}`)
      .join('\n\n');
    return `${header}\n${blocks}`;
  }
  return `${header}\n${opts.rawText ?? ''}`;
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
const NON_DISH_RE =
  /^(?:menu|dinner|lunch|brunch|breakfast|drinks?|beverages?|wine list|cocktails?|specials?|tonight|today|seasonal|hours?|address|tel|phone|email|website|copyright|gratuity|tip|tax|corkage|the chef|consult|all rights reserved|page\s*\d+|entrees?|appetizers?|sides?|desserts?|salads?|sandwiches?|soups?|mains?|starters?|small plates?|shared plates?|raw bar|crustaceans|whole fish|steaks?|sushi|sashimi|charcuterie|cheese)\s*$/i;
const DISCLAIMER_RE =
  /^\s*(disclaimer|notice|warning|allergen|consuming raw|consumer advisory|consumption of raw|gratuity|service charge|please note)\b/i;
const SHELLFISH_RE =
  /\b(shrimp|prawn|crab|lobster|oyster|clam|mussel|scallop|langoustine|crayfish|crawfish|calamari|squid|octopus|cockle|whelk)\b/i;
const RAW_BAR_RE =
  /\b(raw bar|crudo|tartare|tartar|ceviche|sashimi|carpaccio|oyster|oysters)\b/i;

export function validateAndNormalizeMenu(
  payload: unknown,
  opts: { sourceFile: string; extractionScope?: string }
): MenuLlmExtraction {
  const obj = (payload ?? {}) as any;
  const dishesIn: any[] = Array.isArray(obj.dishes)
    ? obj.dishes
    : Array.isArray(obj.items)
      ? obj.items
      : [];

  const dishes: DishLlmRecord[] = [];
  for (const d of dishesIn) {
    if (!d || typeof d !== 'object') continue;
    const name = typeof d.name === 'string' ? d.name.trim() : '';
    if (!name) continue;
    if (name.length < 2) continue;
    if (NON_DISH_RE.test(name)) continue;
    if (DISCLAIMER_RE.test(name)) continue;
    if (BEVERAGE_RE.test(name)) continue;

    const section = typeof d.section === 'string' && d.section.trim() ? d.section.trim() : null;
    if (section && BEVERAGE_RE.test(section)) continue;

    const description =
      typeof d.description === 'string' && d.description.trim() ? d.description.trim() : null;

    const price = coerceMoney(d.price);

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

    const haystack = `${name} ${description ?? ''} ${section ?? ''}`;
    const inferredShellfish = SHELLFISH_RE.test(haystack);
    const inferredRawBar = RAW_BAR_RE.test(haystack) || /raw\s*bar|crudo|ceviche|tartare/i.test(section ?? '');
    const containsShellfish = Boolean(d.contains_shellfish) || inferredShellfish;
    const isRawBar = Boolean(d.is_raw_bar) || inferredRawBar;

    const pages = Array.isArray(d.source_pages)
      ? d.source_pages
          .map((p: any) => Number(p))
          .filter((n: number) => Number.isInteger(n) && n > 0)
      : [];

    dishes.push({
      name,
      section,
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
    dish_count: dishes.length,
    dishes
  };
}

export async function extractMenuWithLlm(opts: ExtractMenuOptions): Promise<MenuLlmExtraction> {
  const userPrompt = buildMenuUserPrompt({
    sourceFile: opts.sourceFile,
    pages: opts.pages,
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

function inferCategory(rec: DishLlmRecord): string {
  if (rec.is_raw_bar) return 'Raw Bar';
  if (rec.section) return rec.section;
  return 'Menu';
}

export function toTableSommDish(rec: DishLlmRecord, index: number): TableSommDishLlm {
  const tags = Array.from(new Set([...(rec.tags ?? [])]));
  if (rec.is_raw_bar && !tags.includes('raw-bar')) tags.push('raw-bar');
  if (rec.contains_shellfish && !tags.includes('shellfish')) tags.push('shellfish');

  const section = rec.section ?? 'Menu';
  const category = inferCategory(rec);

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
    style: rec.style ?? '',
    description: rec.description ?? undefined,
    price: rec.price ?? null,
    priceTiers: rec.price_tiers && rec.price_tiers.length > 0 ? rec.price_tiers : undefined,
    tags,
    ingredients: rec.ingredients && rec.ingredients.length > 0 ? rec.ingredients : undefined,
    isRawBar: rec.is_raw_bar,
    containsShellfish: rec.contains_shellfish,
    notes,
    sourcePages: rec.source_pages
  };
}

export function toTableSommDishes(extraction: MenuLlmExtraction): TableSommDishLlm[] {
  return extraction.dishes.map((d, i) => toTableSommDish(d, i));
}

export { DEFAULT_EXTRACTION_SCOPE, DEFAULT_MODEL, SYSTEM_PROMPT };
