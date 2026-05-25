import express from 'express';
import cors from 'cors';
import multer from 'multer';
import pdf from 'pdf-parse';

type MenuItem = { name: string; description?: string; price?: string };
type MenuSection = { section: string; items: MenuItem[] };
type ParsedMenu = { sourceFile: string; extractedAt: string; sections: MenuSection[] };
type TableSommDish = {
  id: string;
  name: string;
  category: string;
  protein: string;
  style: string;
  price: number | null;
  tags: string[];
  notes: string;
  section: string;
};

// Real section headers in this menu are wrapped in "::" markers, e.g. ":: APPETIZERS ::"
const SECTION_RE = /^::\s*(.+?)\s*::$/;
// Headings like "MENU", "Dinner", "Pacific", "Eastern" — top-level page labels
const TOP_LEVEL_HEADINGS = new Set([
  'MENU', 'DINNER', 'LUNCH', 'BRUNCH', 'PACIFIC', 'EASTERN',
  'OYSTER SAMPLER', 'HALFWHOLE', 'WHOLE'
]);
// A dish "name" line is usually ALL CAPS (often with leader dots after it).
// We use this to detect new items vs continuation lines.
const ITEM_HEADING_RE = /^[A-Z0-9][A-Z0-9\s&/'"\-\.()*]*[A-Z0-9*)]\.{0,}\s*\$?\d*(?:\.\d+)?$/;
// Pull a trailing price off a line.
const PRICE_RE = /(\$?\d+(?:\.\d{2})?)\s*$/;
// Leader dots: ".........." used as visual fillers between name and price
const LEADER_DOTS_RE = /\.{3,}/g;
// Lines that are just noise
const JUNK_RE = /^(?:\*+|[½¼¾]+|th|nd|rd|st|EACH½ DOZEN1 DOZEN|EACH½ POUND1 POUND|[\s\W]+)$/i;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }
});

function normalizeLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    // Replace leader dots with a space so prices/columns aren't glued together
    .map((line) => line.replace(LEADER_DOTS_RE, ' ').replace(/\s+/g, ' ').trim())
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
  // Lone single character or just punctuation
  if (line.replace(/[^a-z0-9]/gi, '').length < 2) return true;
  // Footnote / disclaimer
  if (/consuming raw or undercooked/i.test(line)) return true;
  // Staff credits (treated as junk for now — could be captured separately)
  if (/^(general manager|executive chef|chef de cuisine|sous chef|owner)\b/i.test(line)) return true;
  return false;
}

function looksLikeNewItem(line: string): boolean {
  // Heuristic: line starts with multiple uppercase letters AND is mostly uppercase
  const firstTokenMatch = line.match(/^[A-Z0-9'"&\-\.()*]+(?:\s+[A-Z0-9'"&\-\.()*]+)*/);
  if (!firstTokenMatch) return false;
  const heading = firstTokenMatch[0];
  // Must have at least 2 uppercase letters
  const upperCount = (heading.match(/[A-Z]/g) || []).length;
  if (upperCount < 2) return false;
  // The heading should make up most of the start of the line (i.e., before any lowercase words)
  return heading.length >= Math.min(line.length, 4);
}

function splitMultiPriceLine(line: string): { name: string; prices: string[] } {
  // After leader-dot stripping we may have e.g. "JAMES RIVER (...) 3.90 22.40 43.80"
  // Capture all trailing price-like tokens.
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
  if (prices.length === 0) {
    return { name: line };
  }
  if (prices.length === 1) {
    return { name, price: prices[0] };
  }
  // Multiple columns (e.g. each / half-dozen / dozen) — keep all in the price field
  return { name, price: prices.join(' / ') };
}

function parseMenuText(text: string, sourceFile: string): ParsedMenu {
  const lines = normalizeLines(text);
  const sections: MenuSection[] = [];
  let current: MenuSection = { section: 'MENU', items: [] };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    // Section header (":: TEXT ::")
    if (isSection(line)) {
      if (current.items.length > 0 || current.section !== 'MENU') {
        sections.push(current);
      }
      current = { section: extractSectionName(line), items: [] };
      continue;
    }

    // Top-level page heading (MENU, Dinner, etc.) — ignore, don't add as item
    if (TOP_LEVEL_HEADINGS.has(line.toUpperCase())) continue;

    if (isJunk(line)) continue;

    // Continuation line: no leading uppercase heading → append to previous item
    if (!looksLikeNewItem(line) && current.items.length > 0) {
      const prev = current.items[current.items.length - 1];
      const priceMatch = line.match(PRICE_RE);
      const textPart = priceMatch ? line.replace(PRICE_RE, '').trim() : line;
      prev.description = prev.description
        ? `${prev.description} ${textPart}`.trim()
        : textPart;
      if (priceMatch && !prev.price) {
        prev.price = priceMatch[1];
      }
      continue;
    }

    current.items.push(parseItem(line));
  }

  if (current.items.length > 0 || sections.length === 0) {
    sections.push(current);
  }

  return { sourceFile, extractedAt: new Date().toISOString(), sections };
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

function inferProtein(text: string): string {
  const t = text.toLowerCase();
  if (/(tuna|salmon|halibut|cod|bass|swordfish|lobster|shrimp|crab|scallop|mussel|clam|oyster|octopus|urchin|sablefish|seafood|fish|cioppino|poke|hamachi|sashimi|sushi|prawn)/.test(t)) return 'seafood';
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
  if (/(salad|side|appetizer|sushi|raw bar|shellfish|chilled|tartare|poke|nachos|roll)/.test(t)) return 'starter';
  if (/(steak|usda prime|wagyu|entree|whole fish)/.test(t)) return 'main';
  return 'main';
}

function toNumber(price?: string): number | null {
  if (!price) return null;
  // For multi-column prices ("3.90 / 22.40 / 43.80") take the first
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
      // Skip section-marker stragglers
      if (/^::.+::$/.test(name)) continue;

      const combined = `${name} ${item.description ?? ''}`.trim();
      const protein = inferProtein(combined);
      const style = inferStyle(combined);

      dishes.push({
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
      });
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