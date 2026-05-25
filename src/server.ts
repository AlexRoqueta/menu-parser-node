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
// Section-like names that often appear inline (no :: markers) — promote them
const INLINE_SECTION_NAMES = new Set([
  'ICED SHELLFISH PLATTERS', 'WHOLE FISH', 'ENTREES', 'USDA PRIME STEAKS',
  'WAGYU GOLD', 'SIDES', 'CRUSTACEANS', 'SALADS & SANDWICHES'
]);

const PRICE_RE = /(\$?\d+(?:\.\d{2})?)\s*$/;
const LEADER_DOTS_RE = /\.{3,}/g;
// Splits glued price columns like "3.9022.4043.80" → ["3.90","22.40","43.80"]
const GLUED_PRICES_RE = /(\d+\.\d{2})(?=\d)/g;
// Date stub like "Monday, May" / "Monday, May 18th"
const DATE_STUB_RE = /\b(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),\s+\w+(?:\s+\d+(?:st|nd|rd|th)?)?\b/g;
// Steak size: "6oz Petite Cut*" or "8oz Center Cut*" or "12oz Thick Cut NY Strip*"
const STEAK_SIZE_RE = /(\d+oz\s+[^*]+?\*)/g;
// Junk patterns
const JUNK_RE = /^(?:\*+|[½¼¾]+|th|nd|rd|st|EACH½ DOZEN1 DOZEN|EACH½ POUND1 POUND|HALFWHOLE|½WHOLE|½½WHOLE|[\s\W]+)$/i;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }
});

function normalizeLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    // Strip date stubs like "Monday, May 18th"
    .map((line) => line.replace(DATE_STUB_RE, '').trim())
    // Replace leader dots with a space
    .map((line) => line.replace(LEADER_DOTS_RE, ' ').replace(/\s+/g, ' ').trim())
    // Separate glued price columns
    .map((line) => line.replace(GLUED_PRICES_RE, '$1 ').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function isSection(line: string): boolean {
  return SECTION_RE.test(line);
}

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
  // Ranch/farm location subheaders (e.g. "DOUBLE R RANCH · LOOMIS, WASHINGTON")
  if (/^[A-Z][A-Z\s&]+(?:RANCH|FARMS?|RANCHES)\b.*·/i.test(line)) return true;
  if (/^SNAKE RIVER FARMS\b/i.test(line)) return true;
  return false;
}

function looksLikeNewItem(line: string): boolean {
  const firstTokenMatch = line.match(/^[A-Z0-9'"&\-\.()*]+(?:\s+[A-Z0-9'"&\-\.()*]+)*/);
  if (!firstTokenMatch) return false;
  const heading = firstTokenMatch[0];
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
  // Multi-column → store all
  const numericTiers: PriceTier[] = prices.map((p) => ({
    price: Number(p.replace(/\$/g, ''))
  }));
  return { name, price: prices[0], priceTiers: numericTiers };
}

function parseMenuText(text: string, sourceFile: string): ParsedMenu {
  const lines = normalizeLines(text);
  const sections: MenuSection[] = [];
  let current: MenuSection = { section: 'MENU', items: [] };

  function flushCurrent() {
    if (current.items.length > 0 || current.section !== 'MENU') {
      // Merge with previous section if same name
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

    // Explicit "::" section header
    if (isSection(line)) {
      flushCurrent();
      current = { section: extractSectionName(line), items: [] };
      continue;
    }

    // Inline section names without :: markers
    if (INLINE_SECTION_NAMES.has(line.toUpperCase())) {
      flushCurrent();
      current = { section: line.toUpperCase(), items: [] };
      continue;
    }

    if (TOP_LEVEL_HEADINGS.has(line.toUpperCase())) continue;
    if (isJunk(line)) continue;

    // Continuation line → append to previous item
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

    // Special case: parenthetical line like "(MSC certified)" → merge into previous
    if (/^\(.+\)$/.test(line.split(' ')[0]) && current.items.length > 0) {
      const prev = current.items[current.items.length - 1];
      prev.description = prev.description ? `${prev.description} ${line}` : line;
      continue;
    }

    current.items.push(parseItem(line));
  }

  flushCurrent();

  // Post-process: expand steak-size variants
  for (const section of sections) {
    const expanded: MenuItem[] = [];
    for (const item of section.items) {
      const desc = item.description ?? '';
      const sizeMatches = [...desc.matchAll(STEAK_SIZE_RE)];
      if (sizeMatches.length >= 2 && item.priceTiers && item.priceTiers.length === sizeMatches.length) {
        for (let i = 0; i < sizeMatches.length; i++) {
          expanded.push({
            name: `${item.name} — ${sizeMatches[i][1].trim()}`,
            price: String(item.priceTiers[i].price)
          });
        }
      } else if (sizeMatches.length >= 2 && item.price) {
        // Only one price collected but multiple sizes in desc — keep base item
        expanded.push(item);
      } else {
        expanded.push(item);
      }
    }
    section.items = expanded;
  }

  return { sourceFile, extractedAt: new Date().toISOString(), sections };
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