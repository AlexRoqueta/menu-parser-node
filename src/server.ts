import express from 'express';
import cors from 'cors';
import multer from 'multer';
import pdf from 'pdf-parse';

type PriceTier = { label?: string; price: number };
type MenuItem = {
  name: string;
  description?: string;
  price?: string;
  priceTiers?: PriceTier[];
  pieceCounts?: number[]; // For platter items: pieces per platter tier
};
type MenuSection = {
  section: string;
  items: MenuItem[];
  notes?: string;
  platterTiers?: { label: string; price: number }[]; // For ICED SHELLFISH PLATTERS
};
type ParsedMenu = { sourceFile: string; extractedAt: string; sections: MenuSection[] };
type TableSommDish = {
  id: string;
  name: string;
  category: string;
  protein: string;
  style: string;
  price: number | null;
  priceTiers?: PriceTier[];
  pieceCounts?: number[];
  tags: string[];
  notes: string;
  section: string;
};

const SECTION_RE = /^::\s*(.+?)\s*::$/;
const TOP_LEVEL_HEADINGS = new Set([
  'MENU', 'DINNER', 'LUNCH', 'BRUNCH', 'PACIFIC', 'EASTERN',
  'OYSTER SAMPLER', 'HALFWHOLE', 'WHOLE', 'EACH', '½ DOZEN', '1 DOZEN',
  'EACH½ DOZEN1 DOZEN', 'EACH½ POUND1 POUND'
]);
const INLINE_SECTION_NAMES = new Set([
  'ICED SHELLFISH PLATTERS', 'WHOLE FISH', 'ENTREES', 'USDA PRIME STEAKS',
  'WAGYU GOLD', 'SIDES', 'CRUSTACEANS', 'SALADS & SANDWICHES'
]);
const PROMO_SECTIONS = new Set([
  'FIRST OF SEASON: WILD PACIFIC HALIBUT'
]);
const STEAK_SECTION_RE = /STEAK|WAGYU|FILET|RIBEYE/i;
const STEAK_PARENT_RE = /^(?:FILET MIGNON|NEW YORK STEAK|WAGYU FLIGHT|PRIME NEW YORK STRIP|PRIME RIBEYE|RIBEYE)$/i;

// Platter section helpers
const PLATTER_SECTION = 'ICED SHELLFISH PLATTERS';
const PLATTER_TIER_RE = /^THE (GRAND|DELUXE|KING)$/i;
const PLATTER_SERVES_RE = /^serves\s+\d+(?:-\d+)?$/i;
// Row format examples after normalization:
//   "KUMAMOTO 246"               -> name=KUMAMOTO, counts=[2,4,6]
//   "WILD JUMBO WHITE SHRIMP mexico 4714" -> name=..., counts=[4,7,14]
//   "WHOLE 62.00 112.00 215.00"  -> platter totals
const PRICE_RE = /(\$?\d+(?:\.\d{2})?)\s*$/;
const LEADER_DOTS_RE = /\.{3,}/g;
const GLUED_PRICES_RE = /(\d+\.\d{2})(?=\d)/g;
const DATE_STUB_RE = /\b(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),\s+\w+(?:\s+\d+(?:st|nd|rd|th)?)?\b/g;
const STEAK_SIZE_RE = /(\d+oz\s+[^*·]+?\*)/g;
const SIZE_PRICE_LINE_RE = /^(\d+oz\s+[^*]+?\*)\s+(\$?\d+(?:\.\d{2})?)$/;
const MULTI_SIZE_LINE_RE = /^((?:\d+oz\s+[^*·]+?\*\s*·\s*)+\d+oz\s+[^*]+?\*)\s+(\$?\d+(?:\.\d{2})?)$/;
const JUNK_RE = /^(?:\*+|[½¼¾]+|th|nd|rd|st|EACH½ DOZEN1 DOZEN|EACH½ POUND1 POUND|HALFWHOLE|½WHOLE|½½WHOLE|[\s\W]+)$/i;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }
});

function normalizeLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .map((line) => line.replace(DATE_STUB_RE, '').trim())
    .map((line) => line.replace(LEADER_DOTS_RE, ' ').replace(/\s+/g, ' ').trim())
    .map((line) => line.replace(GLUED_PRICES_RE, '$1 ').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function isSection(line: string): boolean { return SECTION_RE.test(line); }

function extractSectionName(line: string): string {
  const m = line.match(SECTION_RE);
  return m ? m[1].trim() : line;
}

function isJunk(line: string): boolean {
  if (JUNK_RE.test(line)) return true;
  if (line.replace(/[^a-z0-9]/gi, '').length < 2) return true;
  if (/consuming raw or undercooked/i.test(line)) return true;
  if (/^(general manager|executive chef|chef de cuisine|sous chef|owner|head chef)\b/i.test(line)) return true;
  if (/^first of season!?$/i.test(line)) return true;
  if (/^[A-Z][A-Z\s&]+(?:RANCH|FARMS?|RANCHES)\b.*·/i.test(line)) return true;
  if (/^SNAKE RIVER FARMS\b/i.test(line)) return true;
  if (/^DOUBLE R RANCH\b/i.test(line)) return true;
  return false;
}

function looksLikeNewItem(line: string): boolean {
  const firstWord = line.split(/\s/)[0];
  if (!/^[A-Z0-9'"&\-\.()*]/.test(firstWord)) return false;
  const firstTokenMatch = line.match(/^[A-Z0-9'"&\-\.()*]+(?:\s+[A-Z0-9'"&\-\.()*]+)*/);
  if (!firstTokenMatch) return false;
  const heading = firstTokenMatch[0];
  if (/^\([^)]+\)$/.test(heading.trim())) return false;
  const upperCount = (heading.match(/[A-Z]/g) || []).length;
  if (upperCount < 2) return false;
  return heading.length >= Math.min(line.length, 4);
}

function splitMultiPriceLine(line: string): { name: string; prices: string[] } {
  const tokens = line.split(/\s+/);
  const prices: string[] = [];
  while (tokens.length > 0) {
    const last = tokens[tokens.length - 1];
    if (/^\$?\d+(?:\.\d{2})?$/.test(last)) {
      prices.unshift(last);
      tokens.pop();
    } else {
      break;
    }
  }
  return { name: tokens.join(' ').trim(), prices };
}

function parseItem(line: string): MenuItem {
  const { name, prices } = splitMultiPriceLine(line);
  if (prices.length === 0) return { name: line };
  if (prices.length === 1) return { name, price: prices[0] };
  const numericTiers: PriceTier[] = prices.map((p) => ({ price: Number(p.replace(/\$/g, '')) }));
  return { name, price: prices[0], priceTiers: numericTiers };
}

/**
 * Split a glued run of digits into 3 piece counts for platter rows.
 * Strategy: try to find a split into 3 numbers where each is reasonable (1-99).
 * Prefer splits where counts are non-decreasing (typical for Grand < Deluxe < King).
 * Examples:
 *   "246"   -> [2, 4, 6]
 *   "4714"  -> [4, 7, 14]
 *   "61218" -> [6, 12, 18]
 */
function splitGluedCounts(digits: string): number[] | null {
  if (!/^\d+$/.test(digits) || digits.length < 3) return null;
  const candidates: number[][] = [];
  // Try all ways to split into 3 numbers where each is 1 or 2 digits
  for (let i = 1; i <= 2 && i < digits.length; i++) {
    for (let j = i + 1; j <= i + 2 && j < digits.length; j++) {
      const a = parseInt(digits.slice(0, i), 10);
      const b = parseInt(digits.slice(i, j), 10);
      const c = parseInt(digits.slice(j), 10);
      if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(c)) continue;
      if (a < 1 || b < 1 || c < 1) continue;
      if (a > 99 || b > 99 || c > 99) continue;
      candidates.push([a, b, c]);
    }
  }
  if (candidates.length === 0) return null;
  // Prefer non-decreasing sequences (Grand < Deluxe < King)
  const ndec = candidates.filter((c) => c[0] <= c[1] && c[1] <= c[2]);
  if (ndec.length > 0) {
    // Among non-decreasing, prefer the one with smallest total span (most "natural")
    ndec.sort((x, y) => (x[2] - x[0]) - (y[2] - y[0]));
    return ndec[0];
  }
  return candidates[0];
}

function parseMenuText(text: string, sourceFile: string): ParsedMenu {
  const lines = normalizeLines(text);
  const sections: MenuSection[] = [];
  let current: MenuSection = { section: 'MENU', items: [] };
  let lastSteakParent: string | null = null;
  // Platter section state
  let platterCollectingTiers = false;
  let platterTierLabels: string[] = []; // ["GRAND","DELUXE","KING"]
  let platterTotalsCaptured = false;

  function flushCurrent() {
    if (current.items.length > 0 || current.section !== 'MENU' || current.notes) {
      const prev = sections[sections.length - 1];
      if (prev && prev.section === current.section) {
        prev.items.push(...current.items);
        if (current.notes) {
          prev.notes = prev.notes ? `${prev.notes} ${current.notes}` : current.notes;
        }
        if (current.platterTiers && !prev.platterTiers) prev.platterTiers = current.platterTiers;
      } else {
        sections.push(current);
      }
    }
  }

  function resetPlatterState() {
    platterCollectingTiers = false;
    platterTierLabels = [];
    platterTotalsCaptured = false;
  }

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (isSection(line)) {
      flushCurrent();
      current = { section: extractSectionName(line), items: [] };
      lastSteakParent = null;
      resetPlatterState();
      continue;
    }

    if (INLINE_SECTION_NAMES.has(line.toUpperCase())) {
      flushCurrent();
      current = { section: line.toUpperCase(), items: [] };
      lastSteakParent = null;
      resetPlatterState();
      if (current.section === PLATTER_SECTION) platterCollectingTiers = true;
      continue;
    }

    if (TOP_LEVEL_HEADINGS.has(line.toUpperCase())) {
      // In platters section the WHOLE 62.00 112.00 215.00 line is the platter totals.
      // The TOP_LEVEL "WHOLE" alone (header) we skip; but the next line will be the totals.
      if (current.section === PLATTER_SECTION && line.toUpperCase() === 'WHOLE') {
        platterCollectingTiers = false; // tier labels done, totals come next
      }
      continue;
    }
    if (isJunk(line)) continue;

    // ============ PLATTER SECTION HANDLING ============
    if (current.section === PLATTER_SECTION) {
      // Collect tier labels: "THE GRAND" / "THE DELUXE" / "THE KING"
      const tierMatch = line.match(PLATTER_TIER_RE);
      if (tierMatch) {
        platterTierLabels.push(tierMatch[1].toUpperCase());
        continue;
      }
      // "serves 1-2" annotation — skip
      if (PLATTER_SERVES_RE.test(line)) continue;

      // Platter totals line: 3 prices on one line, e.g. "62.00 112.00 215.00"
      if (!platterTotalsCaptured) {
        const totalsTokens = line.split(/\s+/);
        const allPrices = totalsTokens.every((t) => /^\$?\d+(?:\.\d{2})?$/.test(t));
        if (allPrices && totalsTokens.length === 3 && platterTierLabels.length === 3) {
          current.platterTiers = totalsTokens.map((p, i) => ({
            label: platterTierLabels[i],
            price: Number(p.replace(/\$/g, ''))
          }));
          platterTotalsCaptured = true;
          continue;
        }
      }

      // Item row with glued piece counts at the end. Examples:
      //   "KUMAMOTO 246"
      //   "WILD JUMBO WHITE SHRIMP mexico 4714"
      // Strategy: take the last token; if it's a glued-digit run, split into 3 counts.
      const tokens = line.split(/\s+/);
      const last = tokens[tokens.length - 1];
      if (/^\d{3,6}$/.test(last)) {
        const counts = splitGluedCounts(last);
        if (counts) {
          const itemName = tokens.slice(0, -1).join(' ').trim();
          current.items.push({
            name: itemName,
            pieceCounts: counts,
            description: `pieces per platter: ${platterTierLabels[0] || 'Grand'} ${counts[0]}, ${platterTierLabels[1] || 'Deluxe'} ${counts[1]}, ${platterTierLabels[2] || 'King'} ${counts[2]}`
          });
          continue;
        }
      }
      // 3 separate price tokens on one line, e.g. "WHOLE 62.00 112.00 215.00" wasn't caught above
      // Or a normal item with a single trailing price
      if (looksLikeNewItem(line)) {
        current.items.push(parseItem(line));
        continue;
      }
      // Continuation (lowercase-led description like " pistachio, citrus pesto")
      if (!looksLikeNewItem(line) && current.items.length > 0) {
        const prev = current.items[current.items.length - 1];
        prev.description = prev.description ? `${prev.description} ${line}`.trim() : line;
        continue;
      }
      continue;
    }
    // ============ END PLATTER HANDLING ============

    const inSteakSection = STEAK_SECTION_RE.test(current.section);

    if (inSteakSection) {
      if (STEAK_PARENT_RE.test(line)) {
        lastSteakParent = line.toUpperCase();
        continue;
      }
      const multi = line.match(MULTI_SIZE_LINE_RE);
      if (multi && lastSteakParent) {
        const sizesPart = multi[1];
        const price = multi[2];
        const sizes = sizesPart.split(/\s*·\s*/).map((s) => s.trim()).filter(Boolean);
        for (let i = 0; i < sizes.length; i++) {
          current.items.push({
            name: `${lastSteakParent} — ${sizes[i]}`,
            price: i === 0 ? price : undefined
          });
        }
        continue;
      }
      const sp = line.match(SIZE_PRICE_LINE_RE);
      if (sp && lastSteakParent) {
        const size = sp[1].trim();
        const price = sp[2];
        current.items.push({
          name: `${lastSteakParent} — ${size}`,
          price
        });
        continue;
      }
    }

    // Section-level note: line starts with "served with" or "with " right after section header
    // and current section has no items yet.
    if (current.items.length === 0 && /^(served with|with |topped with)\b/i.test(line)) {
      current.notes = current.notes ? `${current.notes} ${line}` : line;
      continue;
    }

    // Parenthetical-led continuation
    if (/^\(/.test(line) && current.items.length > 0) {
      const prev = current.items[current.items.length - 1];
      const priceMatch = line.match(PRICE_RE);
      const textPart = priceMatch ? line.replace(PRICE_RE, '').trim() : line;
      prev.description = prev.description
        ? `${prev.description} ${textPart}`.trim()
        : textPart;
      if (priceMatch && !prev.price) prev.price = priceMatch[1];
      continue;
    }

    if (!looksLikeNewItem(line) && current.items.length > 0) {
      const prev = current.items[current.items.length - 1];
      const priceMatch = line.match(PRICE_RE);
      const textPart = priceMatch ? line.replace(PRICE_RE, '').trim() : line;
      prev.description = prev.description
        ? `${prev.description} ${textPart}`.trim()
        : textPart;
      if (priceMatch && !prev.price) prev.price = priceMatch[1];
      continue;
    }

    if (inSteakSection && !STEAK_PARENT_RE.test(line)) {
      lastSteakParent = null;
    }
    current.items.push(parseItem(line));
  }

  flushCurrent();

  // Drop promo sections to only real dishes
  for (const section of sections) {
    if (PROMO_SECTIONS.has(section.section)) {
      section.items = section.items.filter((it) =>
        /^[A-Z]/.test(it.name) && it.name.length < 80 && it.price && Number(it.price) < 500
      );
    }
  }

  // Legacy steak-size expansion (for items where sizes ended up in description)
  for (const section of sections) {
    if (!STEAK_SECTION_RE.test(section.section)) continue;
    const expanded: MenuItem[] = [];
    for (const item of section.items) {
      const haystack = `${item.name} ${item.description ?? ''}`;
      const sizeMatches = [...haystack.matchAll(STEAK_SIZE_RE)].map((m) => m[1].trim());

      if (sizeMatches.length >= 2) {
        let baseName = item.name;
        for (const sz of sizeMatches) baseName = baseName.replace(sz, '').trim();
        baseName = baseName.replace(/\s{2,}/g, ' ').replace(/[—\-]\s*$/, '').trim();
        if (!baseName) baseName = item.name.split(/\s+/).slice(0, 2).join(' ');

        const prices: (string | undefined)[] = [];
        if (item.priceTiers && item.priceTiers.length > 0) {
          for (const t of item.priceTiers) prices.push(String(t.price));
        } else if (item.price) {
          prices.push(item.price);
        }

        for (let i = 0; i < sizeMatches.length; i++) {
          expanded.push({
            name: `${baseName} — ${sizeMatches[i]}`,
            price: prices[i] ?? undefined
          });
        }
        continue;
      }
      expanded.push(item);
    }
    section.items = expanded;
  }

  // Global dedup: merge same-named sections
  const merged: MenuSection[] = [];
  const indexByName = new Map<string, number>();
  for (const sec of sections) {
    const key = sec.section.trim().toUpperCase();
    if (indexByName.has(key)) {
      const idx = indexByName.get(key)!;
      merged[idx].items.push(...sec.items);
      if (sec.notes) merged[idx].notes = merged[idx].notes ? `${merged[idx].notes} ${sec.notes}` : sec.notes;
      if (sec.platterTiers && !merged[idx].platterTiers) merged[idx].platterTiers = sec.platterTiers;
    } else {
      indexByName.set(key, merged.length);
      merged.push(sec);
    }
  }

  return { sourceFile, extractedAt: new Date().toISOString(), sections: merged };
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

function inferProtein(text: string): string {
  const t = text.toLowerCase();
  if (/(tuna|salmon|halibut|cod|bass|swordfish|lobster|shrimp|crab|scallop|mussel|clam|oyster|octopus|urchin|sablefish|seafood|fish|cioppino|poke|hamachi|sashimi|sushi|prawn|calamari|anchovy|toro)/.test(t)) return 'seafood';
  if (/(chicken|duck|turkey|poultry)/.test(t)) return 'chicken';
  if (/(beef|steak|filet|ribeye|wagyu|burger|mignon|ny strip|new york strip|porterhouse|t-bone)/.test(t)) return 'beef';
  if (/(pork|ham|bacon|chorizo|prosciutto|pancetta)/.test(t)) return 'pork';
  if (/(vegetable|vegan|vegetarian|greens|beet|salad|yam|avocado|cucumber|kale|asparagus|mushroom|potato)/.test(t)) return 'vegetarian';
  if (/(vodka|gin|tequila|whiskey|whisky|rum|mezcal|bourbon|cocktail|prosecco|wine|aperol|amaro|spritz|tonic|bitters)/.test(t)) return 'n/a';
  return 'unknown';
}

function inferStyle(text: string): string {
  const t = text.toLowerCase();
  if (/(light|citrus|crudo|vinaigrette|fresh)/.test(t)) return 'light';
  if (/(bold|smoked|rosemary|pepper|spiced|harissa|curry|chili|jalape)/.test(t)) return 'bold';
  if (/(mango|papaya|pineapple|berry|strawberry|grapefruit|passion fruit|elderflower)/.test(t)) return 'fruit';
  return 'classic';
}

function inferCategory(section: string, itemName: string, protein: string): string {
  const t = `${section} ${itemName}`.toLowerCase();
  if (protein === 'n/a' || /(cocktail|spirit free|wine|beer|bartender)/.test(t)) return 'drink';
  if (/(dessert|sorbet|cake|ice cream|panna cotta)/.test(t)) return 'dessert';
  if (/(side)/.test(t)) return 'side';
  if (/(salad|appetizer|sushi|raw bar|shellfish|chilled|tartare|poke|nachos|roll|platter)/.test(t)) return 'starter';
  return 'main';
}

function toNumber(price?: string): number | null {
  if (!price) return null;
  const first = price.split('/')[0].trim();
  const n = Number(first.replace(/\$/g, ''));
  return Number.isFinite(n) ? n : null;
}

function toTableSommDishes(parsed: ParsedMenu): TableSommDish[] {
  const dishes: TableSommDish[] = [];
  for (const section of parsed.sections) {
    for (const item of section.items) {
      const name = item.name.trim();
      if (!name || name.length < 3) continue;
      if (/^(menu|dinner|lunch|brunch|pacific|eastern)$/i.test(name)) continue;
      if (/^::.+::$/.test(name)) continue;
      if (!item.price && !item.pieceCounts && name.length > 60 && /\s[a-z]/.test(name)) continue;

      const combined = `${name} ${item.description ?? ''}`.trim();
      const protein = inferProtein(combined);
      const style = inferStyle(combined);

      const dish: TableSommDish = {
        id: slugify(`${section.section}-${name}`) || `dish-${dishes.length + 1}`,
        name,
        category: inferCategory(section.section, combined, protein),
        protein,
        style,
        price: toNumber(item.price),
        tags: [section.section.toLowerCase(), protein, style].filter(
          (v, i, a) => v && v !== 'unknown' && a.indexOf(v) === i
        ),
        notes: item.description ?? '',
        section: section.section
      };
      if (item.priceTiers) dish.priceTiers = item.priceTiers;
      if (item.pieceCounts) dish.pieceCounts = item.pieceCounts;
      dishes.push(dish);
    }
  }
  return dishes;
}

const app = express();
app.use(cors({ origin: true }));
app.use(express.json({ limit: '1mb' }));

app.get('/', (_req, res) => {
  res.json({
    ok: true,
    service: 'tablesomm-menu-parser-api',
    endpoints: ['GET /health', 'POST /parse-menu (multipart, field=file)']
  });
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'tablesomm-menu-parser-api' });
});

app.post('/parse-menu', upload.single('file'), async (req, res) => {
  try {
    const file = req.file;
    if (!file) {
      return res.status(400).json({ error: 'Missing file upload. Use form field name "file".' });
    }
    if (!/\.pdf$/i.test(file.originalname) && file.mimetype !== 'application/pdf') {
      return res.status(400).json({ error: 'Only PDF files are supported.' });
    }

    const result = await pdf(file.buffer);
    const parsed = parseMenuText(result.text, file.originalname);
    const dishes = toTableSommDishes(parsed);

    res.json({ parsed, dishes, count: dishes.length });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown parse error';
    res.status(500).json({ error: message });
  }
});

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  console.log(`tablesomm-menu-parser-api listening on ${port}`);
});
