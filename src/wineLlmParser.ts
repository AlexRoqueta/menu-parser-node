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

export const WINE_LLM_PARSER_VERSION = '2.1.0-llm-chunked';

const DEFAULT_MODEL = 'gpt-4o-mini';
const DEFAULT_EXTRACTION_SCOPE =
  'Only wines fully identified with a glass, half-bottle carafe, or bottle price; cocktails, beer, spirits, and non-wine items excluded.';

// Default chars-per-chunk target. The Water Grill PDF pages are ~2k chars each,
// so groups of ~2 pages keep each call well under the JSON response cap while
// still giving the LLM enough context per request. Configurable via env var.
const DEFAULT_CHUNK_CHAR_TARGET = 4500;
const DEFAULT_PAGES_PER_CHUNK = 2;

const SYSTEM_PROMPT = `You are an expert sommelier and structured-data extractor.
You are given the raw extracted text of a restaurant wine list (possibly with page markers).
Your task: extract EVERY item that can be fully identified as a WINE and that has at least
one price among glass, half-bottle carafe, or full bottle. Return raw JSON only.

THE LIST HAS MULTIPLE FORMATS — extract from ALL of them:

  FORMAT A — "By the glass" tables (usually one page):
    "Pinot Gris, Cooper Mountain, Willamette Valley, OR 2023 14.5 28"
    Numbers on the right are glass price and (when there are two numbers)
    half-bottle / carafe price. Column headers can read "glass" "½ bottle carafe".

  FORMAT B — Bottle list pages (Champagne, White, Reds, Cabernet, etc.):
    "1004 Gloria Ferrer Sonoma Brut, Sonoma, CA NV 66"
    "200 Stolpman Estate Syrah, Ballard Canyon, Santa Barbara, CA 2023 71"
    The leading number is the BIN number. After the wine descriptor comes the
    vintage (4-digit year or NV) and ONE price — that price is the BOTTLE price.
    These wines are bottle-only and MUST be included in the output.

STRICT RULES:
- Include bottle-only wines from FORMAT B. Do not skip a wine just because it
  lacks a glass price.
- Exclude cocktails, beer (ale/lager/pilsner/ipa/stout), spirits (whiskey/bourbon/
  vodka/gin/rum/tequila/mezcal/cognac/brandy/amaro/liqueur), sake (unless the
  surrounding section is clearly wine), spirit-free drinks, food items.
- Exclude section headings ("::SPARKLING::", "BORDEAUX & NEW WORLD 'BORDEAUX'"),
  column headers ("glass", "½ bottle carafe", "bottle"), page footers (long
  numeric strings like "13520260516"), and any line that does not identify a
  complete wine with at least one price.
- Do NOT invent entries. If unsure, omit.
- Preserve diacritics. Preserve apostrophes and quoted cuvée names.
- The "wine" field is a single human-readable string describing the wine
  identity, e.g. "Varietal, Producer 'Cuvée', Region/Appellation, Country" or
  the producer-led form used on the bottle pages
  ("Gloria Ferrer Sonoma Brut, Sonoma, CA"). Keep it on one line. Do NOT collapse
  it to a region or category — it must identify a specific wine.
- "vintage" is a 4-digit year as a string, or "NV" for non-vintage, or null.
- "category" is one of: "Red", "White", "Rosé", "Sparkling", "Champagne",
  "Orange", "Dessert", "Fortified", or null when unclear. Use Rosé with the
  accent. Infer the category from the current section heading you have most
  recently seen (e.g. ":: CHARDONNAY ::" → White; ":: PINOT NOIR ::" → Red;
  ":: CHAMPAGNE & SPARKLING WINE ::" → Champagne if labelled "Champagne" else
  Sparkling).
- "bin" is the leading bin/list number when the line begins with one
  (FORMAT B), else null.
- "prices" is an object with optional numeric fields:
    glass, half_bottle_carafe, bottle
  (numbers, no currency symbol). Omit fields that are not present.
  FORMAT A: assign the first numeric trailing column to glass, the second to
  half_bottle_carafe.
  FORMAT B: the single trailing number is bottle.
- "source_pages" is the list of page numbers (1-indexed) where the wine appears.
  Use the "**page-N**" markers in the input when present. If the input contains
  no page markers, use an empty array.

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
      "bin": "1004" | null,
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
  /**
   * Override the page-chunking target. Set to 0 / negative to disable chunking
   * and send everything in one call (only useful for tiny inputs or tests).
   */
  pagesPerChunk?: number;
  chunkCharTarget?: number;
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

/**
 * Heuristic: does a page look like it contains wine entries? Used to skip
 * cocktails/spirits pages so we don't waste LLM tokens. We keep this loose —
 * any uncertainty is resolved by including the page.
 */
export function pageLooksLikeWine(pageText: string): boolean {
  if (!pageText || pageText.trim().length < 40) return false;
  const lc = pageText.toLowerCase();
  const wineCues = [
    'wine',
    'champagne',
    'sparkling',
    'chardonnay',
    'pinot',
    'cabernet',
    'merlot',
    'sauvignon',
    'riesling',
    'rosé',
    'rose',
    'malbec',
    'syrah',
    'zinfandel',
    'bordeaux',
    'burgundy',
    'barolo',
    'rioja',
    'nebbiolo'
  ];
  const wineHits = wineCues.reduce((n, kw) => n + (lc.includes(kw) ? 1 : 0), 0);
  // Pages that are clearly non-wine: dominated by cocktail/spirit/beer cues
  const nonWineCues = [
    ':: cocktails ::',
    ':: spirits ::',
    ':: whiskey ::',
    ':: bourbon ::',
    ':: vodka ::',
    ':: gin ::',
    ':: rum ::',
    ':: tequila ::',
    ':: draughts ::',
    ':: spirit free ::',
    ':: cans and bottles ::'
  ];
  const nonWineHit = nonWineCues.some((s) => lc.includes(s));
  if (nonWineHit && wineHits < 3) return false;
  return wineHits >= 1;
}

export type PageChunk = { pageNumbers: number[]; text: string };

/**
 * Group pages into chunks small enough for a single LLM JSON-mode call.
 * Each chunk carries the **page-N** marker for every page it contains so the
 * model can populate source_pages.
 */
export function chunkPages(
  pages: string[],
  opts: { pagesPerChunk?: number; chunkCharTarget?: number } = {}
): PageChunk[] {
  const pagesPerChunk = Math.max(1, opts.pagesPerChunk ?? DEFAULT_PAGES_PER_CHUNK);
  const charTarget = Math.max(500, opts.chunkCharTarget ?? DEFAULT_CHUNK_CHAR_TARGET);
  const chunks: PageChunk[] = [];

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
    if (!pageLooksLikeWine(text)) continue;
    // If adding this page would blow past the char target (and we already have
    // something buffered), flush first. We still always include at least one
    // page per chunk, even an oversized one — the LLM can handle it.
    if (buf.length > 0 && (buf.length >= pagesPerChunk || bufChars + text.length > charTarget)) {
      flush();
    }
    buf.push({ idx: i, text });
    bufChars += text.length;
  }
  flush();
  return chunks;
}

/** Build the user message for a single chunk. */
export function buildUserPrompt(opts: {
  sourceFile: string;
  pages?: string[];
  pageNumbers?: number[];
  rawText?: string;
}): string {
  const header = `Source file: ${opts.sourceFile}\n\nExtract wines per the rules. Return raw JSON only.\n`;
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
    const rec = normalizeOneWine(w);
    if (rec) wines.push(rec);
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

function normalizeOneWine(w: any): WineLlmRecord | null {
  if (!w || typeof w !== 'object') return null;
  const wineName = typeof w.wine === 'string' ? w.wine.trim() : '';
  if (!wineName) return null;

  const pricesIn = (w.prices ?? {}) as any;
  const glass = coerceMoney(pricesIn.glass ?? pricesIn.by_glass ?? pricesIn.glassPrice);
  const half = coerceMoney(
    pricesIn.half_bottle_carafe ??
      pricesIn.halfBottleCarafe ??
      pricesIn.half_bottle ??
      pricesIn.carafe
  );
  const bottle = coerceMoney(pricesIn.bottle ?? pricesIn.full_bottle ?? pricesIn.bottlePrice);
  if (glass == null && half == null && bottle == null) return null;

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

  return {
    wine: wineName,
    vintage,
    category,
    bin,
    prices,
    source_pages: pages
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

/**
 * Build a dedup key from a wine record. Same producer+wine descriptor at the
 * same vintage with the same price set should not appear twice — but a wine
 * that legitimately appears on both the by-glass page and the bottle list IS
 * a different listing (different prices) and we keep both.
 */
function dedupKey(rec: WineLlmRecord): string {
  const name = rec.wine.toLowerCase().replace(/[\s'"]+/g, ' ').trim();
  const vintage = (rec.vintage ?? '').toLowerCase();
  const g = rec.prices.glass ?? '';
  const h = rec.prices.half_bottle_carafe ?? '';
  const b = rec.prices.bottle ?? '';
  return `${name}|${vintage}|${g}|${h}|${b}`;
}

/**
 * Merge several extractions into one, deduping wines and unioning source_pages
 * for entries that match on (name, vintage, prices).
 */
export function mergeExtractions(
  parts: WineLlmExtraction[],
  opts: { sourceFile: string; extractionScope?: string }
): WineLlmExtraction {
  const byKey = new Map<string, WineLlmRecord>();
  for (const part of parts) {
    for (const w of part.wines) {
      const key = dedupKey(w);
      const existing = byKey.get(key);
      if (!existing) {
        byKey.set(key, { ...w, source_pages: [...(w.source_pages ?? [])] });
      } else {
        const pages = new Set([...(existing.source_pages ?? []), ...(w.source_pages ?? [])]);
        existing.source_pages = Array.from(pages).sort((a, b) => a - b);
        if (!existing.bin && w.bin) existing.bin = w.bin;
        if (!existing.category && w.category) existing.category = w.category;
      }
    }
  }
  const wines = Array.from(byKey.values());
  return {
    source_file: opts.sourceFile,
    extraction_scope: opts.extractionScope ?? DEFAULT_EXTRACTION_SCOPE,
    wine_count: wines.length,
    wines
  };
}

/** Top-level: call the LLM (chunked when pages are provided) and merge results. */
export async function extractWinesWithLlm(opts: ExtractOptions): Promise<WineLlmExtraction> {
  const { pages, pagesPerChunk, chunkCharTarget } = opts;
  const useChunking = pages && pages.length > 0 && (pagesPerChunk ?? DEFAULT_PAGES_PER_CHUNK) > 0;

  if (!useChunking) {
    const userPrompt = buildUserPrompt({
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
    return validateAndNormalize(parsed, {
      sourceFile: opts.sourceFile,
      extractionScope: opts.extractionScope
    });
  }

  const chunks = chunkPages(pages, { pagesPerChunk, chunkCharTarget });
  if (chunks.length === 0) {
    return {
      source_file: opts.sourceFile,
      extraction_scope: opts.extractionScope ?? DEFAULT_EXTRACTION_SCOPE,
      wine_count: 0,
      wines: []
    };
  }

  const partials: WineLlmExtraction[] = [];
  for (const chunk of chunks) {
    const chunkPagesText = chunk.pageNumbers.map((n) => pages[n - 1] ?? '');
    const userPrompt = buildUserPrompt({
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
    const part = validateAndNormalize(parsed, {
      sourceFile: opts.sourceFile,
      extractionScope: opts.extractionScope
    });
    // If the LLM did not populate source_pages, infer them from the chunk.
    for (const w of part.wines) {
      if (!w.source_pages || w.source_pages.length === 0) {
        w.source_pages = [...chunk.pageNumbers];
      }
    }
    partials.push(part);
  }
  return mergeExtractions(partials, {
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

export {
  DEFAULT_EXTRACTION_SCOPE,
  DEFAULT_MODEL,
  DEFAULT_CHUNK_CHAR_TARGET,
  DEFAULT_PAGES_PER_CHUNK,
  SYSTEM_PROMPT
};
