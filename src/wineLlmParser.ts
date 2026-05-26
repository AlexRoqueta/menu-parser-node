import pdf from 'pdf-parse';
import {
  callOpenAiJson,
  callOpenAiVisionJson,
  parseLlmJson as sharedParseLlmJson,
  coerceMoney as sharedCoerceMoney,
  type ChatMessage,
  type LlmCallOptions as SharedLlmCallOptions,
  type VisionImage
} from './llmClient.js';
import { imageBufferToDataUrl } from './pdfRender.js';
import { tileTallImage, type TileImageOptions } from './imageTiler.js';

export type WineLlmPrices = {
  glass?: number;
  carafe?: number;
  half_bottle?: number;
  bottle?: number;
};

export type WineLlmRecord = {
  page?: number | null;
  section?: string | null;
  category?: string | null;
  bin?: string | null;
  wine: string;
  vintage?: string | null;
  prices: WineLlmPrices;
  source_pages?: number[];
};

export type WineLlmCounts = {
  unique_wine_offerings: number;
  price_records: number;
  glass_prices: number;
  carafe_prices: number;
  half_bottle_prices: number;
  bottle_prices: number;
};

export type WineLlmExtraction = {
  source_file: string;
  extraction_scope: string;
  counts: WineLlmCounts;
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

export const WINE_LLM_PARSER_VERSION = '2.2.0-llm-chunked-counts';
/** Parser version reported when the wine vision pipeline is used. */
export const WINE_LLM_PARSER_VERSION_VISION = '2.3.0-llm-vision';

const DEFAULT_MODEL = 'gpt-4o-mini';
const DEFAULT_EXTRACTION_SCOPE =
  'Every wine offering with at least one price (glass, carafe, half-bottle, or bottle). Same wine appearing in both Wines-by-the-Glass and Bottle List sections is counted as two separate offerings. Cocktails, beer, spirits, food, and non-wine items excluded.';

// Default chars-per-chunk target. The Water Grill PDF pages are ~2k chars each,
// so groups of ~2 pages keep each call well under the JSON response cap while
// still giving the LLM enough context per request. Configurable via env var.
const DEFAULT_CHUNK_CHAR_TARGET = 4500;
const DEFAULT_PAGES_PER_CHUNK = 2;
// Cap concurrent LLM calls so we don't slam the API but still parallelize.
const DEFAULT_CHUNK_CONCURRENCY = 3;

const SYSTEM_PROMPT = `You are an expert sommelier and structured-data extractor.
You are given the raw extracted text of a restaurant wine list (possibly with page markers).
Your task: extract EVERY wine OFFERING with at least one price among glass, carafe,
half-bottle, or bottle. Return raw JSON only.

THE LIST HAS MULTIPLE FORMATS — extract from ALL of them:

  FORMAT A — "Wines by the Glass" section (typically one page):
    "Pinot Gris, Cooper Mountain, Willamette Valley, OR 2023 14.5 28"
    Two columns of prices appear. The FIRST number is the glass price; the
    SECOND number (when present) is the carafe price (NOT a half-bottle).
    Column headers can read "glass" "carafe".
    For these entries: section = "Wines by the Glass". The category should be
    inferred from sub-headings on the page ("Sparkling", "White", "Rose",
    "Red") — use a short capitalized form: "Sparkling", "White", "Rose",
    "Red".

  FORMAT B — Bottle List pages (Champagne, Chardonnay, Pinot Noir, etc.):
    "1004 Gloria Ferrer Sonoma Brut, Sonoma, CA NV 66"
    "200 Stolpman Estate Syrah, Ballard Canyon, Santa Barbara, CA 2023 71"
    The leading number is the BIN number. After the wine descriptor comes the
    vintage (4-digit year or NV) and ONE price — that price is the BOTTLE price.
    These wines are bottle-only and MUST be included.
    For these entries: section = "Bottle List". The category should be the
    EXACT current section heading as printed on the page, preserved in its
    original ALL-CAPS form, e.g. "CHAMPAGNE & SPARKLING WINE", "CHARDONNAY",
    "PINOT NOIR", "CABERNET SAUVIGNON", "BORDEAUX & NEW WORLD 'BORDEAUX'",
    "SOUTHERN RHÔNE & NEW WORLD 'RHÔNE'", etc.

DUPLICATE / OFFERING RULES:
- If a wine appears on the Wines-by-the-Glass page AND in the Bottle List,
  emit TWO separate records — one per offering. They differ by section,
  category, and prices, and both must be counted.

STRICT RULES:
- Include bottle-only wines from FORMAT B. Do not skip a wine just because it
  lacks a glass price.
- Exclude cocktails, beer (ale/lager/pilsner/ipa/stout), spirits (whiskey/bourbon/
  vodka/gin/rum/tequila/mezcal/cognac/brandy/amaro/liqueur), sake (unless the
  surrounding section is clearly wine), spirit-free drinks, food items.
- Exclude section/category HEADINGS themselves ("CHAMPAGNE & SPARKLING WINE",
  "BORDEAUX & NEW WORLD 'BORDEAUX'", "Wines by the Glass"), column headers
  ("glass", "carafe", "bottle"), page footers (long numeric strings like
  "13520260516"), and any line that does not identify a complete wine with at
  least one price.
- Do NOT collapse a wine to its region/country/appellation. The "wine" field
  must identify a specific producer/varietal offering.
- Do NOT invent entries. If unsure, omit.
- Preserve diacritics. Preserve apostrophes and quoted cuvée names.
- The "wine" field is a single human-readable string describing the wine
  identity. Include the trailing vintage token in the string as printed on the
  page (e.g. "Saracco Moscato d'Asti, Piedmont, Italy 2024").
- "vintage" is a 4-digit year as a string, or "NV" for non-vintage, or null.
- "page" is the integer page number (from the **page-N** marker) where the
  wine appears.
- "bin" is the leading bin/list number when the line begins with one
  (FORMAT B), else null.
- "prices" is an object with optional numeric fields:
    glass, carafe, half_bottle, bottle
  (numbers, no currency symbol). Omit fields that are not present. Use
  "carafe" for Wines-by-the-Glass second-column prices on this menu — it is a
  carafe pour, not a half-bottle. Reserve "half_bottle" for entries the menu
  explicitly labels as "½ bottle" or "half bottle".

OUTPUT FORMAT (raw JSON, no markdown fences, no commentary):
{
  "source_file": "<the file name you were given>",
  "wines": [
    {
      "page": 3,
      "section": "Wines by the Glass" | "Bottle List",
      "category": "Sparkling" | "White" | "Rose" | "Red" | "CHAMPAGNE & SPARKLING WINE" | "CHARDONNAY" | ...,
      "bin": "1004" | null,
      "wine": "Saracco Moscato d'Asti, Piedmont, Italy 2024",
      "vintage": "2024" | "NV" | null,
      "prices": { "glass": 13.0, "carafe": 28.0, "half_bottle": 0, "bottle": 66.0 }
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
  /** Max concurrent LLM calls when processing chunks. */
  concurrency?: number;
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

export function computeCounts(wines: WineLlmRecord[]): WineLlmCounts {
  let glass = 0;
  let carafe = 0;
  let half = 0;
  let bottle = 0;
  for (const w of wines) {
    if (w.prices.glass != null) glass += 1;
    if (w.prices.carafe != null) carafe += 1;
    if (w.prices.half_bottle != null) half += 1;
    if (w.prices.bottle != null) bottle += 1;
  }
  return {
    unique_wine_offerings: wines.length,
    price_records: glass + carafe + half + bottle,
    glass_prices: glass,
    carafe_prices: carafe,
    half_bottle_prices: half,
    bottle_prices: bottle
  };
}

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
    counts: computeCounts(wines),
    wine_count: wines.length,
    wines
  };
}

function normalizeOneWine(w: any): WineLlmRecord | null {
  if (!w || typeof w !== 'object') return null;
  const wineName = typeof w.wine === 'string' ? w.wine.trim() : '';
  if (!wineName) return null;
  if (isHeadingOrNoise(wineName)) return null;

  const pricesIn = (w.prices ?? {}) as any;
  const glass = coerceMoney(pricesIn.glass ?? pricesIn.by_glass ?? pricesIn.glassPrice);
  // Accept legacy "half_bottle_carafe" by mapping it to carafe (this menu uses
  // carafe, not half-bottle). Caller can still send distinct carafe/half_bottle.
  const carafe = coerceMoney(pricesIn.carafe);
  const half = coerceMoney(
    pricesIn.half_bottle ?? pricesIn.halfBottle ?? pricesIn.half_bottle_carafe
  );
  const bottle = coerceMoney(pricesIn.bottle ?? pricesIn.full_bottle ?? pricesIn.bottlePrice);
  if (glass == null && carafe == null && half == null && bottle == null) return null;

  const prices: WineLlmPrices = {};
  if (glass != null) prices.glass = glass;
  if (carafe != null) prices.carafe = carafe;
  if (half != null) prices.half_bottle = half;
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
    category = w.category.trim();
  }

  let section: string | null = null;
  if (typeof w.section === 'string' && w.section.trim()) {
    section = w.section.trim();
  }

  let bin: string | null = null;
  if (w.bin != null) {
    const b = String(w.bin).trim();
    if (b) bin = b;
  }

  let page: number | null = null;
  if (w.page != null) {
    const n = Number(w.page);
    if (Number.isInteger(n) && n > 0) page = n;
  }

  const pages = Array.isArray(w.source_pages)
    ? w.source_pages
        .map((p: any) => Number(p))
        .filter((n: number) => Number.isInteger(n) && n > 0)
    : page != null
      ? [page]
      : [];

  return {
    page,
    section,
    category,
    bin,
    wine: wineName,
    vintage,
    prices,
    source_pages: pages
  };
}

const coerceMoney = sharedCoerceMoney;

// Filter out lines the LLM may have accidentally emitted as wines but which are
// actually section headings, column labels, or non-wine drink categories.
const HEADING_NAME_PATTERNS = [
  /^(red|white|rose|rosé|sparkling|champagne|orange|by the glass|wines by the glass|bottle list|france|italy|usa|california|napa|sonoma|spain|chile|argentina|australia|new zealand|portugal|germany|austria)$/i,
  /^(cocktails?|spirits?|whiskey|bourbon|vodka|gin|rum|tequila|mezcal|cognac|brandy|amaro|liqueur|sake|beer|ale|lager|pilsner|ipa|stout|draughts?|spirit ?free|cans and bottles)$/i,
  /^(glass|carafe|half bottle|½ bottle carafe|bottle)$/i,
  /^chardonnay$/i,
  /^pinot (noir|gris|grigio)$/i,
  /^cabernet sauvignon$/i,
  /^merlot$/i,
  /^malbec$/i,
  /^riesling$/i,
  /^sauvignon blanc$/i,
  /^syrah( & shiraz)?$/i,
  /^bold reds$/i,
  /^bordeaux( & new world.*)?$/i,
  /^southern rh[oô]ne.*$/i,
  /^adventure in white wine$/i,
  /^champagne & sparkling( wine)?$/i,
  /^ros[eé] wine$/i,
  /^pinot grigio & pinot gris$/i
];

function isHeadingOrNoise(name: string): boolean {
  const trimmed = name.trim();
  if (trimmed.length < 4) return true;
  if (/^\d+$/.test(trimmed)) return true;
  if (/^[:*•\-_–—]+$/.test(trimmed)) return true;
  for (const re of HEADING_NAME_PATTERNS) {
    if (re.test(trimmed)) return true;
  }
  return false;
}

/**
 * Normalize a wine name for dedupe: lower-case, collapse whitespace/quotes, and
 * strip any trailing vintage / "NV" token that the LLM may have appended. The
 * vintage is tracked separately on the record, so keeping it in the dedupe
 * name causes overlap-induced duplicates where one tile saw the vintage and
 * another didn't.
 */
function normalizeWineName(raw: string): string {
  let s = (raw ?? '').toLowerCase().replace(/[\s'’"`]+/g, ' ').trim();
  // Strip trailing 4-digit year, "NV", or "n.v." — vintage is on its own field.
  s = s.replace(/[\s,]+(?:nv|n\.v\.|\d{4})\s*$/i, '').trim();
  // Drop trailing punctuation noise.
  s = s.replace(/[.,;:\-–—]+$/g, '').trim();
  return s;
}

/**
 * Stable dedup key: normalized name + section + vintage. We intentionally do
 * NOT include the price fingerprint because overlapping tiles / adjacent
 * rendered pages routinely see the same wine and pick up slightly different
 * prices for the same offering (e.g. one tile crops the bottle column).
 * Vintage IS part of the key because the same producer's wine in two
 * different vintages (e.g. Duckhorn 2022 vs 2024) is two distinct offerings
 * on the bottle list. A record without a vintage is matched against records
 * that share name+section regardless of vintage — this absorbs overlap
 * duplicates where one tile cropped the year off without conflating two
 * concrete vintages.
 */
function dedupKey(rec: WineLlmRecord): string {
  const name = normalizeWineName(rec.wine);
  const section = (rec.section ?? '').toLowerCase().trim();
  const vintage = (rec.vintage ?? '').toLowerCase().trim();
  return `${name}|${section}|${vintage}`;
}

/** Key used to absorb a vintage-less duplicate into an existing entry. */
function dedupKeyVintageless(rec: WineLlmRecord): string {
  const name = normalizeWineName(rec.wine);
  const section = (rec.section ?? '').toLowerCase().trim();
  return `${name}|${section}|`;
}

function priceSlotCount(rec: WineLlmRecord): number {
  let n = 0;
  if (rec.prices.glass != null) n += 1;
  if (rec.prices.carafe != null) n += 1;
  if (rec.prices.half_bottle != null) n += 1;
  if (rec.prices.bottle != null) n += 1;
  return n;
}

/** Returns true when at least one priced offering is present on the record. */
function hasAnyPrice(rec: WineLlmRecord): boolean {
  return priceSlotCount(rec) > 0;
}

/**
 * Merge two records that match on (name, section). We keep the one with the
 * most price slots populated as the base, then union pages and back-fill
 * empty fields. Prices that are present on one record but missing on the
 * other are copied in — this recovers e.g. a bottle price from a later tile
 * when the earlier tile only saw the glass column.
 */
function mergeRecords(a: WineLlmRecord, b: WineLlmRecord): WineLlmRecord {
  const base = priceSlotCount(a) >= priceSlotCount(b) ? a : b;
  const other = base === a ? b : a;
  const pages = new Set([...(base.source_pages ?? []), ...(other.source_pages ?? [])]);
  const merged: WineLlmRecord = {
    ...base,
    prices: { ...base.prices },
    source_pages: Array.from(pages).sort((x, y) => x - y)
  };
  if (merged.prices.glass == null && other.prices.glass != null)
    merged.prices.glass = other.prices.glass;
  if (merged.prices.carafe == null && other.prices.carafe != null)
    merged.prices.carafe = other.prices.carafe;
  if (merged.prices.half_bottle == null && other.prices.half_bottle != null)
    merged.prices.half_bottle = other.prices.half_bottle;
  if (merged.prices.bottle == null && other.prices.bottle != null)
    merged.prices.bottle = other.prices.bottle;
  if (!merged.bin && other.bin) merged.bin = other.bin;
  if (!merged.category && other.category) merged.category = other.category;
  if (!merged.section && other.section) merged.section = other.section;
  if (!merged.page && other.page) merged.page = other.page;
  if (!merged.vintage && other.vintage) merged.vintage = other.vintage;
  return merged;
}

/**
 * Merge several extractions into one, deduping wines on (normalized name,
 * section) and unioning prices/pages. Records that lack any price are dropped
 * defensively — `normalizeOneWine` already enforces this, but a merge can be
 * called on records produced by callers that bypass that path.
 */
export function mergeExtractions(
  parts: WineLlmExtraction[],
  opts: { sourceFile: string; extractionScope?: string }
): WineLlmExtraction {
  const byKey = new Map<string, WineLlmRecord>();
  // Track every key that shares a (name, section) prefix so a vintage-less
  // copy can be absorbed into the existing vintage'd record.
  const keysByNameSection = new Map<string, string[]>();

  for (const part of parts) {
    for (const w of part.wines) {
      if (!hasAnyPrice(w)) continue;
      const key = dedupKey(w);
      const vintageless = (w.vintage ?? '').trim() === '';
      let target = byKey.get(key);

      // Vintage-less record arriving after a vintage'd record exists for the
      // same name+section → absorb into the existing one (only when exactly
      // one candidate exists, to avoid ambiguous matches).
      if (!target && vintageless) {
        const candidates = keysByNameSection.get(dedupKeyVintageless(w)) ?? [];
        if (candidates.length === 1) {
          target = byKey.get(candidates[0]);
        }
      }

      if (!target) {
        const copy: WineLlmRecord = {
          ...w,
          prices: { ...w.prices },
          source_pages: [...(w.source_pages ?? [])]
        };
        byKey.set(key, copy);
        const list = keysByNameSection.get(dedupKeyVintageless(w)) ?? [];
        list.push(key);
        keysByNameSection.set(dedupKeyVintageless(w), list);
      } else {
        const merged = mergeRecords(target, w);
        // Find which key target lives at and update in place.
        for (const [k, v] of byKey) {
          if (v === target) {
            byKey.set(k, merged);
            break;
          }
        }
      }
    }
  }

  // Second pass: a vintage'd record may have been written before a
  // vintage-less duplicate arrived (when the vintage-less one came first
  // there was no key to anchor on, so it took its own slot). Collapse any
  // remaining vintage-less entries that share name+section with exactly one
  // vintage'd sibling.
  const final = new Map<string, WineLlmRecord>();
  for (const [k, v] of byKey) final.set(k, v);
  for (const [k, v] of byKey) {
    const vintage = (v.vintage ?? '').trim();
    if (vintage !== '') continue;
    const siblings: string[] = [];
    for (const [k2, v2] of final) {
      if (k2 === k) continue;
      if ((v2.vintage ?? '').trim() === '') continue;
      if (dedupKeyVintageless(v2) === dedupKeyVintageless(v)) siblings.push(k2);
    }
    if (siblings.length === 1) {
      const sibling = final.get(siblings[0])!;
      final.set(siblings[0], mergeRecords(sibling, v));
      final.delete(k);
    }
  }

  const wines = Array.from(final.values()).filter(hasAnyPrice);
  return {
    source_file: opts.sourceFile,
    extraction_scope: opts.extractionScope ?? DEFAULT_EXTRACTION_SCOPE,
    counts: computeCounts(wines),
    wine_count: wines.length,
    wines
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
      counts: computeCounts([]),
      wine_count: 0,
      wines: []
    };
  }

  const partials = await runWithConcurrency(
    chunks,
    opts.concurrency ?? DEFAULT_CHUNK_CONCURRENCY,
    async (chunk) => {
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
      // If the LLM did not populate source_pages or page, infer them from the chunk.
      for (const w of part.wines) {
        if (!w.source_pages || w.source_pages.length === 0) {
          w.source_pages = [...chunk.pageNumbers];
        }
        if (w.page == null && chunk.pageNumbers.length === 1) {
          w.page = chunk.pageNumbers[0];
        }
      }
      return part;
    }
  );
  return mergeExtractions(partials, {
    sourceFile: opts.sourceFile,
    extractionScope: opts.extractionScope
  });
}

/** Map an LLM record into the TableSomm wine shape used by the frontend. */
export function toTableSommWine(rec: WineLlmRecord, index: number): TableSommWine {
  const tags: string[] = [];
  if (rec.prices.glass != null) tags.push('by-the-glass');
  if (rec.prices.carafe != null) tags.push('carafe');
  if (rec.prices.half_bottle != null) tags.push('half-bottle');
  if (rec.prices.bottle != null) tags.push('bottle');

  const vintageNum =
    rec.vintage && /^\d{4}$/.test(rec.vintage) ? Number.parseInt(rec.vintage, 10) : null;

  const priceTiers: { label: string; price: number }[] = [];
  if (rec.prices.glass != null) priceTiers.push({ label: 'Glass', price: rec.prices.glass });
  if (rec.prices.carafe != null) priceTiers.push({ label: 'Carafe', price: rec.prices.carafe });
  if (rec.prices.half_bottle != null)
    priceTiers.push({ label: 'Half Bottle', price: rec.prices.half_bottle });
  if (rec.prices.bottle != null) priceTiers.push({ label: 'Bottle', price: rec.prices.bottle });

  // halfBottlePrice exposes either carafe or half_bottle to the frontend (they
  // share the "mid-pour" slot on the TableSomm card). Prefer half_bottle when
  // both are present (unusual on this menu, but defensible).
  const halfBottle = rec.prices.half_bottle ?? rec.prices.carafe ?? null;

  const primaryPrice =
    rec.prices.bottle ?? halfBottle ?? rec.prices.glass ?? null;

  const sourcePages = rec.source_pages && rec.source_pages.length > 0
    ? rec.source_pages
    : rec.page != null
      ? [rec.page]
      : [];
  const notes = sourcePages.length > 0
    ? `Source page${sourcePages.length > 1 ? 's' : ''}: ${sourcePages.join(', ')}`
    : undefined;

  return {
    id: `wine-${index + 1}`,
    name: rec.wine,
    vintage: vintageNum,
    price: primaryPrice,
    glassPrice: rec.prices.glass ?? null,
    halfBottlePrice: halfBottle,
    bottlePrice: rec.prices.bottle ?? null,
    priceTiers,
    category: rec.category ?? undefined,
    binNumber: rec.bin ?? undefined,
    tags,
    notes,
    sourcePages,
    section: rec.section ?? rec.category ?? 'Wine'
  };
}

export function toTableSommWines(extraction: WineLlmExtraction): TableSommWine[] {
  return extraction.wines.map((rec, i) => toTableSommWine(rec, i));
}

/**
 * Vision counterpart to {@link extractWinesWithLlm}. Takes one or more PNG/JPEG
 * buffers (each representing a single menu page or a single uploaded image)
 * and asks the LLM to extract wines directly from the rendered pixels.
 *
 * Used by the server when:
 *   - the upload is an image; or
 *   - the upload is a PDF that produced no extractable text (image-only PDF).
 */
export type ExtractWinesWithVisionOptions = LlmCallOptions & {
  sourceFile: string;
  extractionScope?: string;
  /** Raw image bytes. Each entry is treated as one menu page. */
  images: Buffer[];
  /** Optional page numbers for `images[i]` (1-indexed). */
  pageNumbers?: number[];
  /** Detail hint forwarded to the model. */
  detail?: 'low' | 'high' | 'auto';
  /** Optional override of the underlying vision call (mostly for tests). */
  callVision?: (
    input: { system: string; userText: string; images: VisionImage[] },
    options: LlmCallOptions & { defaultModel: string; modelEnvVar?: string }
  ) => Promise<string>;
};

export function buildWineVisionUserPrompt(opts: {
  sourceFile: string;
  pageNumbers?: number[];
  imageCount: number;
}): string {
  const labels =
    opts.pageNumbers && opts.pageNumbers.length === opts.imageCount
      ? opts.pageNumbers.map((n) => `page-${n}`).join(', ')
      : Array.from({ length: opts.imageCount }, (_, i) => `image-${i + 1}`).join(', ');
  return [
    `Source file: ${opts.sourceFile}`,
    '',
    'You are looking at one or more rendered pages of a restaurant wine list.',
    `The attached images correspond to ${labels}.`,
    'Extract wines per the rules in your system prompt. Use the same JSON',
    'schema you would for text input. Populate `source_pages` with the page',
    'number(s) printed on the image when visible, otherwise leave it empty.',
    'Return raw JSON only.'
  ].join('\n');
}

/**
 * Single vision call for a batch of images. Used internally; prefer
 * {@link extractWinesWithVision} which runs one call per image and merges so
 * the PDF page path and the tall-image tile path share identical behaviour.
 */
async function callVisionOnce(
  images: Buffer[],
  pageNumbers: number[] | undefined,
  opts: ExtractWinesWithVisionOptions
): Promise<WineLlmExtraction> {
  const userText = buildWineVisionUserPrompt({
    sourceFile: opts.sourceFile,
    pageNumbers,
    imageCount: images.length
  });
  const visionImages: VisionImage[] = images.map((buf) => ({
    url: imageBufferToDataUrl(buf),
    detail: opts.detail ?? 'high'
  }));
  const caller = opts.callVision ?? callOpenAiVisionJson;
  const content = await caller(
    { system: SYSTEM_PROMPT, userText, images: visionImages },
    {
      apiKey: opts.apiKey,
      model: opts.model,
      baseUrl: opts.baseUrl,
      fetchImpl: opts.fetchImpl,
      defaultModel: DEFAULT_MODEL,
      modelEnvVar: 'WINE_PARSER_MODEL'
    }
  );
  const parsed = sharedParseLlmJson(content);
  const part = validateAndNormalize(parsed, {
    sourceFile: opts.sourceFile,
    extractionScope: opts.extractionScope
  });
  // Backfill source_pages / page from the provided page numbers when the
  // model didn't report them.
  if (pageNumbers && pageNumbers.length === images.length) {
    const all = [...pageNumbers].sort((a, b) => a - b);
    for (const w of part.wines) {
      if (!w.source_pages || w.source_pages.length === 0) {
        w.source_pages = [...all];
      }
      if (w.page == null && all.length === 1) {
        w.page = all[0];
      }
    }
  }
  return part;
}

/**
 * Run the vision LLM over one or more images and return a merged extraction.
 *
 * Behaviour:
 *  - One image: a single vision call (back-compat with prior behaviour).
 *  - Multiple images: one vision call per image, executed with
 *    {@link DEFAULT_CHUNK_CONCURRENCY} concurrency, then merged via
 *    {@link mergeExtractions}. This matches the tall-image tiling path so the
 *    rendered-PDF-page route and the direct tall-image route share the same
 *    extract-then-merge logic.
 */
export async function extractWinesWithVision(
  opts: ExtractWinesWithVisionOptions
): Promise<WineLlmExtraction> {
  if (!opts.images || opts.images.length === 0) {
    throw new Error('extractWinesWithVision requires at least one image buffer');
  }

  if (opts.images.length === 1) {
    return callVisionOnce(opts.images, opts.pageNumbers, opts);
  }

  const concurrency = Math.max(1, DEFAULT_CHUNK_CONCURRENCY);
  const pageNums =
    opts.pageNumbers && opts.pageNumbers.length === opts.images.length
      ? opts.pageNumbers
      : opts.images.map((_, i) => i + 1);
  const partials = await runWithConcurrency(opts.images, concurrency, async (buf, i) =>
    callVisionOnce([buf], [pageNums[i]], opts)
  );
  return mergeExtractions(partials, {
    sourceFile: opts.sourceFile,
    extractionScope: opts.extractionScope
  });
}

/**
 * Convenience wrapper for the `/parse-wine-list` direct image-upload path.
 *
 * Mirrors {@link extractMenuFromImageUpload}: if the uploaded image is
 * unusually tall (a stitched multi-page wine list) it's sliced into
 * overlapping vertical tiles which are extracted in parallel and merged.
 * Normal-aspect images and missing ImageMagick gracefully fall back to a
 * single-image call so behavior matches the previous implementation.
 */
export type ExtractWinesFromImageUploadOptions = SharedLlmCallOptions & {
  sourceFile: string;
  extractionScope?: string;
  imageBuffer: Buffer;
  detail?: 'low' | 'high' | 'auto';
  concurrency?: number;
  tileOptions?: TileImageOptions;
  disableTiling?: boolean;
  callVision?: ExtractWinesWithVisionOptions['callVision'];
};

export async function extractWinesFromImageUpload(
  opts: ExtractWinesFromImageUploadOptions
): Promise<WineLlmExtraction & { tileCount: number }> {
  const singleCall = async (
    images: Buffer[],
    pageNumbers?: number[]
  ): Promise<WineLlmExtraction> =>
    extractWinesWithVision({
      sourceFile: opts.sourceFile,
      extractionScope: opts.extractionScope,
      images,
      pageNumbers,
      detail: opts.detail,
      apiKey: opts.apiKey,
      model: opts.model,
      baseUrl: opts.baseUrl,
      fetchImpl: opts.fetchImpl,
      callVision: opts.callVision
    });

  if (opts.disableTiling) {
    const e = await singleCall([opts.imageBuffer]);
    return { ...e, tileCount: 1 };
  }

  const tiled = await tileTallImage(opts.imageBuffer, opts.tileOptions);
  if (!tiled || tiled.tiles.length < 2) {
    const e = await singleCall([opts.imageBuffer]);
    return { ...e, tileCount: 1 };
  }

  const concurrency = Math.max(1, opts.concurrency ?? DEFAULT_CHUNK_CONCURRENCY);
  const tilePageNumbers = tiled.tiles.map((_, i) => i + 1);
  const partials = await runWithConcurrency(tiled.tiles, concurrency, async (buf, i) =>
    singleCall([buf], [tilePageNumbers[i]])
  );
  const merged = mergeExtractions(partials, {
    sourceFile: opts.sourceFile,
    extractionScope: opts.extractionScope
  });
  return { ...merged, tileCount: tiled.tiles.length };
}

export {
  DEFAULT_EXTRACTION_SCOPE,
  DEFAULT_MODEL,
  DEFAULT_CHUNK_CHAR_TARGET,
  DEFAULT_PAGES_PER_CHUNK,
  DEFAULT_CHUNK_CONCURRENCY,
  SYSTEM_PROMPT
};
