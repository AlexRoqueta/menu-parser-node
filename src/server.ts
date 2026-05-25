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
};
type MenuSection = { section: string; items: MenuItem[] };
type ParsedMenu = { sourceFile: string; extractedAt: string; sections: MenuSection[] };
type TableSommDish = {
  id: string;
  name: string;
  category: string;
  protein: string;
  style: string;
  price: number | null;
  priceTiers?: PriceTier[];
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
// Promo/marketing section blocks — preserve as a section but mark items as non-dish
const PROMO_SECTIONS = new Set([
  'FIRST OF SEASON: WILD PACIFIC HALIBUT'
]);
// Steak-type sections where size/price line expansion logic applies
const STEAK_SECTION_RE = /STEAK|WAGYU|FILET|RIBEYE/i;
// Parent item names that can have size-variant children attached (uppercase parent line)
const STEAK_PARENT_RE = /^(?:FILET MIGNON|NEW YORK STEAK|WAGYU FLIGHT|PRIME NEW YORK STRIP|PRIME RIBEYE|RIBEYE)$/i;

const PRICE_RE = /(\$?\d+(?:\.\d{2})?)\s*$/;
const LEADER_DOTS_RE = /\.{3,}/g;
const GLUED_PRICES_RE = /(\d+\.\d{2})(?=\d)/g;
const DATE_STUB_RE = /\b(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),\s+\w+(?:\s+\d+(?:st|nd|rd|th)?)?\b/g;
const STEAK_SIZE_RE = /(\d+oz\s+[^*·]+?\*)/g;
// Matches a line like "6oz Petite Cut* 58" or "8oz Manhattan Cut* 92"
const SIZE_PRICE_LINE_RE = /^(\d+oz\s+[^*]+?\*)\s+(\$?\d+(?:\.\d{2})?)$/;
// Matches a line with multiple sizes separated by · and one price at the end: "3oz Ribeye* · 3oz New York* · 3oz Filet Mignon*  105"
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
  // Must be mostly uppercase at the start; lowercase-led lines are descriptions.
  const firstWord = line.split(/\s/)[0];
  if (!/^[A-Z0-9'"&\-\.()*]/.test(firstWord)) return false;
  const firstTokenMatch = line.match(/^[A-Z0-9'"&\-\.()*]+(?:\s+[A-Z0-9'"&\-\.()*]+)*/);
  if (!firstTokenMatch) return false;
  const heading = firstTokenMatch[0];
  // Skip lines that start with a parenthetical alone (e.g. "(MSC certified) ...")
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

function parseMenuText(text: string, sourceFile: string): ParsedMenu {
  const lines = normalizeLines(text);
  const sections: MenuSection[] = [];
  let current: MenuSection = { section: 'MENU', items: [] };
  // Track the most recent "parent" steak item name (e.g. "FILET MIGNON") so we can
  // attach sized children to it across multiple lines.
  let lastSteakParent: string | null = null;

  function flushCurrent() {
    if (current.items.length > 0 || current.section !== 'MENU') {
      const prev = sections[sections.length - 1];
      if (prev && prev.section === current.section) {
        prev.items.push(...current.items);
      } else {
        sections.push(current);
      }
    }
  }

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (isSection(line)) {
      flushCurrent();
      current = { section: extractSectionName(line), items: [] };
      lastSteakParent = null;
      continue;
    }

    if (INLINE_SECTION_NAMES.has(line.toUpperCase())) {
      flushCurrent();
      current = { section: line.toUpperCase(), items: [] };
      lastSteakParent = null;
      continue;
    }

    if (TOP_LEVEL_HEADINGS.has(line.toUpperCase())) continue;
    if (isJunk(line)) continue;

    const inSteakSection = STEAK_SECTION_RE.test(current.section);

    // STEAK HANDLING (inside steak/wagyu sections)
    if (inSteakSection) {
      // Case A: parent line by itself, e.g. "FILET MIGNON" or "NEW YORK STEAK"
      if (STEAK_PARENT_RE.test(line)) {
        lastSteakParent = line.toUpperCase();
        continue;
      }
      // Case B: multi-size shared price line, e.g.
      //   "3oz Ribeye* · 3oz New York* · 3oz Filet Mignon*  105"
      const multi = line.match(MULTI_SIZE_LINE_RE);
      if (multi && lastSteakParent) {
        const sizesPart = multi[1];
        const price = multi[2];
        const sizes = sizesPart.split(/\s*·\s*/).map((s) => s.trim()).filter(Boolean);
        for (let i = 0; i < sizes.length; i++) {
          current.items.push({
            name: `${lastSteakParent} — ${sizes[i]}`,
            // Only attach price to first variant — the price is shared/flight pricing
            price: i === 0 ? price : undefined
          });
        }
        continue;
      }
      // Case C: single size+price line, e.g. "6oz Petite Cut* 58"
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
      // Case D: standalone item with size baked into description (e.g. "PRIME RIBEYE" then "16oz Ribeye Steak*  72")
      // Falls through to the generic continuation/new-item logic below.
    }

    // Parenthetical-led continuation: "(MSC certified) ..."
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

    // New item — reset steak parent tracker so the next standalone item doesn't
    // accidentally inherit a stale parent name.
    if (inSteakSection && !STEAK_PARENT_RE.test(line)) {
      lastSteakParent = null;
    }
    current.items.push(parseItem(line));
  }

  flushCurrent();

  // Drop promo/marketing sections entirely (or keep them but flag — here we drop items but keep section)
  for (const section of sections) {
    if (PROMO_SECTIONS.has(section.section)) {
      section.items = section.items.filter((it) =>
        // Only keep items that look like actual dishes (UPPER CASE name, has a normal price)
        /^[A-Z]/.test(it.name) && it.name.length < 80 && it.price && Number(it.price) < 500
      );
    }
  }

  // Legacy steak-size expansion (still useful for items where sizes ended up in description)
  for (const section of sections) {
    if (!STEAK_SECTION_RE.test(section.section)) continue;
    const expanded: MenuItem[] = [];
    for (const item of section.items) {
      // Look for size variants in BOTH name and description
      const haystack = `${item.name} ${item.description ?? ''}`;
      const sizeMatches = [...haystack.matchAll(STEAK_SIZE_RE)].map((m) => m[1].trim());

      if (sizeMatches.length >= 2) {
        // Compute a clean base name = original name with size tokens stripped
        let baseName = item.name;
        for (const sz of sizeMatches) baseName = baseName.replace(sz, '').trim();
        baseName = baseName.replace(/\s{2,}/g, ' ').replace(/[—\-]\s*$/, '').trim();
        if (!baseName) baseName = item.name.split(/\s+/).slice(0, 2).join(' ');

        // Collect all candidate prices from priceTiers (preferred) or single price
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

  // Global dedup: merge same-named sections regardless of position (page-break splits)
  const merged: MenuSection[] = [];
  const indexByName = new Map<string, number>();
  for (const sec of sections) {
    const key = sec.section.trim().toUpperCase();
    if (indexByName.has(key)) {
      merged[indexByName.get(key)!].items.push(...sec.items);
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
      // Skip section-note lines (no price, very long, sentence-like)
      if (!item.price && name.length > 60 && /\s[a-z]/.test(name)) continue;

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
