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

const SECTION_RE = /^[A-Z][A-Z\s&/'-]{2,}$/;
const PRICE_RE = /(\$?\d+(?:\.\d{2})?)\s*$/;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }
});

function normalizeLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function isSection(line: string): boolean {
  return SECTION_RE.test(line) && line.length <= 48;
}

function parseItem(line: string): MenuItem {
  const priceMatch = line.match(PRICE_RE);
  const price = priceMatch?.[1];
  const cleaned = price ? line.replace(PRICE_RE, '').trim() : line;
  const parts = cleaned
    .split(/\s+-\s+|\s{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);

  if (parts.length >= 2) {
    return { name: parts[0], description: parts.slice(1).join(' '), price };
  }
  return { name: cleaned, price };
}

function parseMenuText(text: string, sourceFile: string): ParsedMenu {
  const lines = normalizeLines(text);
  const sections: MenuSection[] = [];
  let current: MenuSection = { section: 'MENU', items: [] };

  for (const line of lines) {
    if (isSection(line)) {
      if (current.items.length > 0 || current.section !== 'MENU') {
        sections.push(current);
      }
      current = { section: line, items: [] };
      continue;
    }
    current.items.push(parseItem(line));
  }

  if (current.items.length > 0 || sections.length === 0) {
    sections.push(current);
  }

  return {
    sourceFile,
    extractedAt: new Date().toISOString(),
    sections
  };
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

function inferProtein(text: string): string {
  const t = text.toLowerCase();
  if (/(tuna|salmon|halibut|cod|bass|swordfish|lobster|shrimp|crab|scallop|mussels|clam|oyster|octopus|sea urchin|seafood|fish)/.test(t)) return 'seafood';
  if (/(chicken|duck|turkey)/.test(t)) return 'chicken';
  if (/(beef|steak|filet|ribeye|wagyu|burger|mignon|strip)/.test(t)) return 'beef';
  if (/(pork|ham|bacon|chorizo)/.test(t)) return 'pork';
  if (/(vegetable|vegan|vegetarian|greens|beets|caesar|salad|yam|avocado|cucumber)/.test(t)) return 'vegetarian';
  return 'seafood';
}

function inferStyle(text: string): string {
  const t = text.toLowerCase();
  if (/(light|citrus|crudo|vinaigrette)/.test(t)) return 'light';
  if (/(bold|smoked|rosemary|pepper|spiced|harissa|curry)/.test(t)) return 'bold';
  if (/(fruit|mango|papaya|pineapple|berry)/.test(t)) return 'fruit';
  return 'classic';
}

function inferCategory(section: string, itemName: string): string {
  const t = `${section} ${itemName}`.toLowerCase();
  if (/(cocktail|spirit|wine|beer)/.test(t)) return 'drink';
  if (/(dessert|sorbet|cake|ice cream)/.test(t)) return 'dessert';
  if (/(salad|side|appetizer|sushi|raw bar|shellfish)/.test(t)) return 'starter';
  return 'main';
}

function toNumber(price?: string): number | null {
  if (!price) return null;
  const n = Number(price.replace(/\$/g, ''));
  return Number.isFinite(n) ? n : null;
}

function toTableSommDishes(parsed: ParsedMenu): TableSommDish[] {
  const dishes: TableSommDish[] = [];
  for (const section of parsed.sections) {
    for (const item of section.items) {
      const name = item.name.trim();
      if (!name || name.length < 2) continue;
      if (/^(menu|dinner|lunch|brunch)$/i.test(name)) continue;

      const combined = `${name} ${item.description ?? ''}`.trim();

      dishes.push({
        id: slugify(`${section.section}-${name}`) || `dish-${dishes.length + 1}`,
        name,
        category: inferCategory(section.section, combined),
        protein: inferProtein(combined),
        style: inferStyle(combined),
        price: toNumber(item.price),
        tags: [section.section.toLowerCase(), inferProtein(combined), inferStyle(combined)].filter(
          (v, i, a) => v && a.indexOf(v) === i
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

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'tablesomm-menu-parser-api' });
});

app.post('/parse-menu', upload.single('file'), async (req, res) => {
  try {
    const file = req.file;
    if (!file) {
      return res.status(400).json({ error: 'Missing file upload. Use form field name \"file\".' });
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