import pdf from 'pdf-parse';
import {
  callOpenAiJson,
  parseLlmJson as sharedParseLlmJson,
  coerceMoney as sharedCoerceMoney,
  type ChatMessage,
  type LlmCallOptions as SharedLlmCallOptions
} from './llmClient.js';

export type WineLlmPrices = {
  glass?: number;
  half_bottle_carafe?: number;
  bottle?: number;
};

export type WineLlmRecord = {
  wine: string;
  vintage?: string | null;
  category?: string | null;
  bin?: string | null;
  prices: WineLlmPrices;
  source_pages?: number[];
};

export type WineLlmExtraction = {
  source_file: string;
  extraction_scope: string;
  wine_count: number;
  wines: WineLlmRecord[];
};

export type TableSommWine = {
  id: string;
  name: string;
  producer?: string;
  varietal?: string;
  region?: string;
  country?: string;
  vintage?: number | null;
  price?: number | null;
  glassPrice?: number | null;
  bottlePrice?: number | null;
  halfBottlePrice?: number | null;
  priceTiers?: { label?: string; price: number }[];
  category?: string;
  binNumber?: string;
  tags: string[];
  notes?: string;
  sourcePages?: number[];
  section: string;
};

export const WINE_LLM_PARSER_VERSION = '2.0.0-llm';

const DEFAULT_MODEL = 'gpt-4o-mini';
const DEFAULT_EXTRACTION_SCOPE =
  'Only wines fully identified with a glass, half-bottle carafe, or bottle price; cocktails, beer, spirits, and non-wine items excluded.';

const SYSTEM_PROMPT = `You are an expert sommelier and structured-data extractor.
You are given the raw extracted text of a restaurant wine list (possibly with page markers).
Your task: extract every item that can be fully identified as a WINE and that has at least
one price among glass, half-bottle carafe, or full bottle. Return raw JSON only.

STRICT RULES:
- Exclude cocktails, beer, spirits, sake (unless clearly a wine listing), spirit-free drinks,
  food items, headings, geographic regions without a wine name, and any line that does not
  identify a complete wine with at least one price.
- A wine entry must include enough information to be a real wine listing: producer and/or
  varietal/appellation and at least one of glass / half-bottle carafe / bottle price.
- Do NOT invent entries. If unsure, omit.
- Preserve diacritics. Preserve apostrophes and quoted cuvée names.
- The "wine" field is a single human-readable string: typically
  "Varietal, Producer 'Cuvée', Region/Appellation, Country" or whatever full descriptor
  the menu uses. Keep it on one line.
- "vintage" is a 4-digit year as a string, or "NV" for non-vintage, or null.
- "category" is one of: "Red", "White", "Rosé", "Sparkling", "Champagne", "Orange",
  "Dessert", "Fortified", or null when unclear. Use Rosé with the accent.
- "bin" is the bin/list number if present, else null.
- "prices" is an object with optional numeric fields:
    glass, half_bottle_carafe, bottle
  (numbers, no currency symbol). Omit fields that are not present.
- "source_pages" is the list of page numbers (1-indexed) where the wine appears, if the
  input contains page markers of the form "**page-N**" or you are told the page number.
  If pages are unknown, use an empty array.

OUTPUT FORMAT (raw JSON, no markdown fences, no commentary):
{
  "source_file": "<the file name you were given>",
  "extraction_scope": "Only wines fully identified with a glass, half-bottle carafe, or bottle price; cocktails, beer, spirits, and non-wine items excluded.",
  "wine_count": <number>,
  "wines": [
    {
      "wine": "...",
      "vintage": "2022" | "NV" | null,
      "category": "Red" | "White" | "Rosé" | "Sparkling" | "Champagne" | "Orange" | "Dessert" | "Fortified" | null,
      "bin": "12" | null,
      "prices": { "glass": 15.0, "half_bottle_carafe": 29.0, "bottle": 120.0 },
      "source_pages": [3]
    }
  ]
}`;

export type LlmCallOptions = SharedLlmCallOptions;

export type ExtractOptions = LlmCallOptions & {
  sourceFile: string;
  extractionScope?: string;
  /**
   * Page-keyed text. When provided, each page is sent labeled so the model can
   * report source_pages. If omitted, the full text is sent unlabeled.
   */
  pages?: string[];
  rawText?: string;
};

/** Public: extract per-page text from a PDF buffer (1-indexed). */
export async function extractPdfPages(buffer: Buffer): Promise<string[]> {
  const pages: string[] = [];
  await pdf(buffer, {
    pagerender: async (pageData: any) => {
      const textContent = await pageData.getTextContent();
      const lines: string[] = [];
      let lastY: number | null = null;
      let current: string[] = [];
      for (const item of textContent.items) {
        const y = item.transform?.[5];
        if (lastY !== null && y !== undefined && Math.abs(y - lastY) > 2) {
          lines.push(current.join(' '));
          current = [];
        }
        current.push(item.str);
        lastY = y ?? lastY;
      }
      if (current.length) lines.push(current.join(' '));
      const text = lines.join('\n').replace(/[ \t]+/g, ' ').trim();
      pages.push(text);
      return text;
    }
  });
  return pages;
}

/** Build the user message: include page markers when pages are available. */
export function buildUserPrompt(opts: {
  sourceFile: string;
  pages?: string[];
  rawText?: string;
}): string {
  const header = `Source file: ${opts.sourceFile}\n\nExtract wines per the rules. Return raw JSON only.\n`;
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
    modelEnvVar: 'WINE_PARSER_MODEL'
  });
}

export const parseLlmJson = sharedParseLlmJson;

/** Normalize and validate an arbitrary LLM payload into WineLlmExtraction. */
export function validateAndNormalize(
  payload: unknown,
  opts: { sourceFile: string; extractionScope?: string }
): WineLlmExtraction {
  const obj = (payload ?? {}) as any;
  const winesIn: any[] = Array.isArray(obj.wines)
    ? obj.wines
    : Array.isArray(obj.items)
      ? obj.items
      : [];

  const wines: WineLlmRecord[] = [];
  for (const w of winesIn) {
    if (!w || typeof w !== 'object') continue;
    const wineName = typeof w.wine === 'string' ? w.wine.trim() : '';
    if (!wineName) continue;

    const pricesIn = (w.prices ?? {}) as any;
    const glass = coerceMoney(pricesIn.glass ?? pricesIn.by_glass ?? pricesIn.glassPrice);
    const half = coerceMoney(
      pricesIn.half_bottle_carafe ??
        pricesIn.halfBottleCarafe ??
        pricesIn.half_bottle ??
        pricesIn.carafe
    );
    const bottle = coerceMoney(pricesIn.bottle ?? pricesIn.full_bottle ?? pricesIn.bottlePrice);
    if (glass == null && half == null && bottle == null) continue;

    const prices: WineLlmPrices = {};
    if (glass != null) prices.glass = glass;
    if (half != null) prices.half_bottle_carafe = half;
    if (bottle != null) prices.bottle = bottle;

    let vintage: string | null = null;
    if (w.vintage != null) {
      const v = String(w.vintage).trim();
      if (/^\d{4}$/.test(v) || /^nv$/i.test(v)) {
        vintage = /^nv$/i.test(v) ? 'NV' : v;
      } else if (v) {
        const m = v.match(/(\d{4})/);
        vintage = m ? m[1] : null;
      }
    }

    let category: string | null = null;
    if (typeof w.category === 'string' && w.category.trim()) {
      category = normalizeCategory(w.category.trim());
    }

    let bin: string | null = null;
    if (w.bin != null) {
      const b = String(w.bin).trim();
      if (b) bin = b;
    }

    const pages = Array.isArray(w.source_pages)
      ? w.source_pages
          .map((p: any) => Number(p))
          .filter((n: number) => Number.isInteger(n) && n > 0)
      : [];

    wines.push({
      wine: wineName,
      vintage,
      category,
      bin,
      prices,
      source_pages: pages
    });
  }

  return {
    source_file: typeof obj.source_file === 'string' ? obj.source_file : opts.sourceFile,
    extraction_scope:
      typeof obj.extraction_scope === 'string' && obj.extraction_scope.trim()
        ? obj.extraction_scope
        : (opts.extractionScope ?? DEFAULT_EXTRACTION_SCOPE),
    wine_count: wines.length,
    wines
  };
}

const coerceMoney = sharedCoerceMoney;

function normalizeCategory(input: string): string | null {
  const lc = input.toLowerCase();
  if (/sparkl/.test(lc)) return 'Sparkling';
  if (/champagne/.test(lc)) return 'Champagne';
  if (/ros/.test(lc)) return 'Rosé';
  if (/orange|skin/.test(lc)) return 'Orange';
  if (/dessert|sweet|late harvest|sauternes|ice ?wine/.test(lc)) return 'Dessert';
  if (/port|sherry|madeira|fortified|marsala/.test(lc)) return 'Fortified';
  if (/red/.test(lc)) return 'Red';
  if (/white/.test(lc)) return 'White';
  return input.charAt(0).toUpperCase() + input.slice(1);
}

/** Top-level: call the LLM and return validated extraction. */
export async function extractWinesWithLlm(opts: ExtractOptions): Promise<WineLlmExtraction> {
  const userPrompt = buildUserPrompt({
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
  return validateAndNormalize(parsed, {
    sourceFile: opts.sourceFile,
    extractionScope: opts.extractionScope
  });
}

/** Map an LLM record into the TableSomm wine shape used by the frontend. */
export function toTableSommWine(rec: WineLlmRecord, index: number): TableSommWine {
  const tags: string[] = [];
  if (rec.prices.glass != null) tags.push('by-the-glass');
  if (rec.prices.half_bottle_carafe != null) tags.push('half-bottle-carafe');
  if (rec.prices.bottle != null) tags.push('bottle');

  const vintageNum =
    rec.vintage && /^\d{4}$/.test(rec.vintage) ? Number.parseInt(rec.vintage, 10) : null;

  const priceTiers: { label: string; price: number }[] = [];
  if (rec.prices.glass != null) priceTiers.push({ label: 'Glass', price: rec.prices.glass });
  if (rec.prices.half_bottle_carafe != null)
    priceTiers.push({ label: 'Half Bottle / Carafe', price: rec.prices.half_bottle_carafe });
  if (rec.prices.bottle != null) priceTiers.push({ label: 'Bottle', price: rec.prices.bottle });

  const primaryPrice =
    rec.prices.bottle ?? rec.prices.half_bottle_carafe ?? rec.prices.glass ?? null;

  const notes = rec.source_pages && rec.source_pages.length > 0
    ? `Source page${rec.source_pages.length > 1 ? 's' : ''}: ${rec.source_pages.join(', ')}`
    : undefined;

  return {
    id: `wine-${index + 1}`,
    name: rec.wine,
    vintage: vintageNum,
    price: primaryPrice,
    glassPrice: rec.prices.glass ?? null,
    halfBottlePrice: rec.prices.half_bottle_carafe ?? null,
    bottlePrice: rec.prices.bottle ?? null,
    priceTiers,
    category: rec.category ?? undefined,
    binNumber: rec.bin ?? undefined,
    tags,
    notes,
    sourcePages: rec.source_pages,
    section: rec.category ?? 'Wine'
  };
}

export function toTableSommWines(extraction: WineLlmExtraction): TableSommWine[] {
  return extraction.wines.map((rec, i) => toTableSommWine(rec, i));
}

export { DEFAULT_EXTRACTION_SCOPE, DEFAULT_MODEL, SYSTEM_PROMPT };
