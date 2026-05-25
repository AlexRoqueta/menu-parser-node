import fs from 'node:fs/promises';
import path from 'node:path';
import pdf from 'pdf-parse';

type MenuItem = {
  name: string;
  description?: string;
  price?: string;
};

type MenuSection = {
  section: string;
  items: MenuItem[];
};

type ParsedMenu = {
  sourceFile: string;
  extractedAt: string;
  sections: MenuSection[];
};

const MONEY_ONLY_RE = /^(?:US\$?\s*)?(\d+(?:\.\d{2})?)$/i;
const EMBEDDED_MONEY_RE = /\b(?:US\$?\s*)?(\d+(?:\.\d{2})?)\s*$/i;
const LEADING_COUNT_RE = /^\(?\d+\)?\s+/;
const PAGE_MARKER_RE = /^\*\*page-\d+\*\*$/i;

const SECTION_HEADER_HINTS = [
  'food - ',
  'lunch menu - ',
  'drinks - ',
  'drinks special - ',
  'kids - ',
  'candy - ',
  'favorite new dishes - ',
  'platos especial - ',
  'todays special - ',
  'today special - '
];

const SECTION_STOPWORDS = [
  'menu static',
  'prices subject to change',
  'menustatic.com',
  'signature dishes',
  'informations',
  'opening times',
  'address:',
  'phone:'
];

const EXCLUDED_SECTION_PATTERNS: RegExp[] = [
  /\bdrink/i,
  /\bsoft drinks?\b/i,
  /\bcocktail/i,
  /\bbeer\b/i,
  /\bwine\b/i,
  /\bmargarita\b/i,
  /\bappetizer/i,
  /\bdips?\b/i,
  /\bsides?\b/i,
  /\bdessert/i,
  /\bcandy\b/i,
  /\bkids?\b/i,
  /\ba la carte\b/i,
  /\bsalad/i,
  /\bnachos?\b/i,
  /\b1\/2 nachos?\b/i,
  /\braw bar\b/i,
  /\bshellfish\b/i,
  /\boyster/i,
  /\bsushi\b/i,
  /\bspirit free\b/i,
  /\bcocktails?\b/i,
  /\bbartender/i,
  /\bice[sd] shellfish/i
];

const INCLUDED_SECTION_PATTERNS: RegExp[] = [
  /\bentrees?\b/i,
  /\bfajitas?\b/i,
  /\bburritos?\b/i,
  /\btacos?\b/i,
  /\bsteak\b/i,
  /\bseafood\b/i,
  /\bchicken\b/i,
  /\bpork\b/i,
  /\bvegetarian/i,
  /\bcombinations?\b/i,
  /\bantojitos?\b/i,
  /\bon the grill\b/i,
  /\bgrill\b/i,
  /\bfavorite new dishes\b/i,
  /\bplatos? especial/i,
  /\btoday'?s special/i,
  /\blunch specialt/i,
  /\bexpress lunch\b/i
];

const NEGATIVE_ITEM_PATTERNS: RegExp[] = [
  /\bdrink\b/i,
  /\btea\b/i,
  /\bcoke\b/i,
  /\bsprite\b/i,
  /\blemonade\b/i,
  /\bcoffee\b/i,
  /\bmilk\b/i,
  /\bjuice\b/i,
  /\bwater\b/i,
  /\bsoda\b/i,
  /\bmilkshake/i,
  /\bmichelada\b/i,
  /\bmargarita\b/i,
  /\bvirgin\b/i,
  /\bbeer\b/i,
  /\bwine\b/i,
  /\bappetizer/i,
  /\bsampler\b/i,
  /\bwings?\b/i,
  /\bsoup\b/i,
  /\bdip\b/i,
  /\bsalsa\b/i,
  /\bchips?\b/i,
  /\bguacamole\b/i,
  /\bqueso\b/i,
  /\bside\b/i,
  /\bfries\b/i,
  /\brace\b/i,
  /\bbeans?\b/i,
  /\btortillas?\b/i,
  /\bsour cream\b/i,
  /\blettuce\b/i,
  /\btomato\b/i,
  /\bavocado\b/i,
  /\bjalape/i,
  /\bonions?\b/i,
  /\blemon\b/i,
  /\blime\b/i,
  /\bbroccoli\b/i,
  /\bcoleslaw\b/i,
  /\bspinach\b/i,
  /\bmushrooms?\b/i,
  /\bpineapple\b/i,
  /\bchorizo\b/i,
  /\bcandy\b/i,
  /\bice cream\b/i,
  /\bflan\b/i,
  /\bchurros?\b/i,
  /\bfunnel cake\b/i,
  /\bsopapilla\b/i,
  /\bxango\b/i,
  /\bkids?\b/i,
  /\bhot dog\b/i,
  /\bhotdog\b/i,
  /\bpizza bites\b/i,
  /\bmini corn dogs\b/i,
  /\bmac cheese\b/i,
  /\ba la carte\b/i,
  /\bcarta\b/i,
  /\bcarte\b/i,
  /\bsolo\b/i,
  /\bsmall\b/i,
  /\b1\/2\b/i,
  /^\(?\d+\)?\s*(taco|enchilada|burrito|quesadilla|tamale|chalupa|tostada)\b/i,
  /^#?\d+\s*$/i
];

const POSITIVE_ITEM_PATTERNS: RegExp[] = [
  /\bentree\b/i,
  /\bdinner\b/i,
  /\bfajitas?\b/i,
  /\bburritos?\b/i,
  /\bchimichanga\b/i,
  /\benchiladas?\b/i,
  /\bquesadilla rellena\b/i,
  /\bgrande quesadilla\b/i,
  /\bquesadilla grande\b/i,
  /\bpollo\b/i,
  /\bchicken\b/i,
  /\bsteak\b/i,
  /\bsirloin\b/i,
  /\bribeye\b/i,
  /\bt[- ]?bone\b/i,
  /\bcarne asada\b/i,
  /\bparrillada\b/i,
  /\balambre\b/i,
  /\bmolcajete\b/i,
  /\bmorcajete\b/i,
  /\bmar & tierra\b/i,
  /\bseafood combo\b/i,
  /\bshrimp\b/i,
  /\bfilet\b/i,
  /\bmojjarra\b/i,
  /\btilapia\b/i,
  /\bcarnitas\b/i,
  /\bchuletas?\b/i,
  /\bchile verde\b/i,
  /\bchile rojo\b/i,
  /\bchile colorado\b/i,
  /\bguiso\b/i,
  /\btampiqueno\b/i,
  /\bdeluxe\b/i,
  /\bspecial\b/i,
  /\btorta\b/i,
  /\btaquitos mexicanos\b/i,
  /\bflautas mexicanas\b/i,
  /\bchilaquiles\b/i,
  /\bentomatadas\b/i,
  /\bvegetarian\b/i,
  /^\([A-E]\)\s+vegetarian$/i,
  /^#\d+$/i
];

function fixMojibake(value: string): string {
  return value
    .replace(/Ã±/g, 'ñ')
    .replace(/Ã¡/g, 'á')
    .replace(/Ã©/g, 'é')
    .replace(/Ã­/g, 'í')
    .replace(/Ã³/g, 'ó')
    .replace(/Ãº/g, 'ú')
    .replace(/Ã¼/g, 'ü')
    .replace(/Â½/g, '½')
    .replace(/Â¾/g, '¾')
    .replace(/Â/g, '')
    .replace(/â€“/g, '–')
    .replace(/â€”/g, '—')
    .replace(/â€˜/g, "'")
    .replace(/â€™/g, "'")
    .replace(/â€œ/g, '"')
    .replace(/â€/g, '"');
}

function cleanText(text: string): string {
  return fixMojibake(text)
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

function cleanField(text?: string): string | undefined {
  if (!text) return undefined;

  const cleaned = cleanText(text)
    .replace(/^\*+\/?/, '')
    .replace(/^,+\/?\.?/, '')
    .replace(/\s+,/g, ',')
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .replace(/\s*&\s*/g, ' & ')
    .replace(/\s+/g, ' ')
    .trim();

  return cleaned || undefined;
}

function normalizeLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => cleanText(line))
    .filter(Boolean)
    .filter((line) => !PAGE_MARKER_RE.test(line));
}

function isNoise(line: string): boolean {
  if (!line) return true;
  if (SECTION_STOPWORDS.some((s) => line.toLowerCase().includes(s))) return true;
  if (/^menu$/i.test(line)) return true;
  if (/^opening times$/i.test(line)) return true;
  if (/^(monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/i.test(line)) return true;
  if (/^\d{1,2}:\d{2}-\d{1,2}:\d{2}$/i.test(line)) return true;
  if (/^\+?\d[\d\s\-()]{7,}$/.test(line)) return true;
  if (/^\d+\s+\w/.test(line) && /TN-\d+/.test(line)) return true;
  if (/^signature dishes\b/i.test(line)) return true;
  return false;
}

function looksLikeMoney(line: string): boolean {
  return MONEY_ONLY_RE.test(line);
}

function parseMoney(line: string): string | undefined {
  const match = line.match(MONEY_ONLY_RE);
  return match?.[1];
}

function extractTrailingMoney(line: string): { name: string; price?: string } {
  const cleaned = cleanText(line);
  const match = cleaned.match(EMBEDDED_MONEY_RE);

  if (!match || match.index === undefined) {
    return { name: cleaned };
  }

  const name = cleaned.slice(0, match.index).trim().replace(/[-,;:]+$/, '').trim();
  const price = match[1];

  if (!name) {
    return { name: cleaned };
  }

  return { name, price };
}

function looksLikeSectionHeader(line: string): boolean {
  const lower = line.toLowerCase();

  if (SECTION_HEADER_HINTS.some((hint) => lower.startsWith(hint))) return true;
  if (/^(entrees?|fajitas?|burritos?|tacos?|steak|seafood|chicken|pork|vegetarians?|combinations?|quesadillas?|antojitos tradicionales|on the grill|desserts|appetizers|dips|sides|salads|a la carte)$/i.test(line)) {
    return true;
  }

  if (/^[A-Z0-9\s'&\-:/()#.]+$/.test(line) && line.length <= 50 && !looksLikeMoney(line)) {
    return INCLUDED_SECTION_PATTERNS.some((re) => re.test(line)) || EXCLUDED_SECTION_PATTERNS.some((re) => re.test(line));
  }

  return false;
}

function normalizeSectionName(line: string): string {
  return cleanText(line)
    .replace(/^FOOD\s*-\s*/i, '')
    .replace(/^LUNCH MENU\s*-\s*/i, 'Lunch - ')
    .replace(/^FAVORITE NEW DISHES\s*-\s*/i, '')
    .replace(/^DRINKS SPECIAL\s*-\s*/i, '')
    .replace(/^PLATOS ESPECIAL\s*-\s*/i, '')
    .replace(/^TODAYS SPECIAL\s*-\s*/i, '')
    .trim();
}

function appendDescription(item: MenuItem, line: string) {
  const cleaned = cleanField(line);
  if (!cleaned) return;

  item.description = item.description
    ? `${item.description} ${cleaned}`.replace(/\s+/g, ' ').trim()
    : cleaned;
}

function scoreMealSection(sectionName: string): number {
  let score = 0;

  if (INCLUDED_SECTION_PATTERNS.some((re) => re.test(sectionName))) score += 3;
  if (EXCLUDED_SECTION_PATTERNS.some((re) => re.test(sectionName))) score -= 4;
  if (/\blunch\b/i.test(sectionName) && /\bnachos?\b/i.test(sectionName)) score -= 3;
  if (/\bexpress lunch\b/i.test(sectionName)) score += 1;
  if (/\bspecial/i.test(sectionName)) score += 1;

  return score;
}

function scoreMealItem(item: MenuItem, sectionName: string): number {
  const name = cleanField(item.name) ?? item.name;
  const description = cleanField(item.description) ?? '';
  const blob = `${name} ${description}`.trim();

  let score = 0;

  if (item.price) score += 2;
  if (POSITIVE_ITEM_PATTERNS.some((re) => re.test(blob))) score += 4;
  if (NEGATIVE_ITEM_PATTERNS.some((re) => re.test(blob))) score -= 5;
  if (/\bseafood\b|\bsteak\b|\bchicken\b|\bpork\b|\bvegetarian\b|\bfajitas?\b|\bburritos?\b|\btacos?\b/i.test(sectionName)) score += 2;
  if (/\bcombinations?\b/i.test(sectionName) && /^#\d+$/i.test(name)) score += 3;
  if (/\bvegetarian\b/i.test(sectionName) && /\bvegetarian\b/i.test(name)) score += 2;

  if (/^\(?\d+\)?\s+/.test(name) && !/\b(dinner|combo|special|fajita|burrito|taco|enchilada|quesadilla|tamale)\b/i.test(name)) {
    score -= 2;
  }

  if (/^1\/2\b/i.test(name) || /\bsmall\b/i.test(name)) score -= 3;
  if (/^no\b/i.test(name)) score -= 5;
  if (parseFloat(item.price ?? '0') === 0) score -= 5;

  return score;
}

function dedupeItems(items: MenuItem[]): MenuItem[] {
  const map = new Map<string, MenuItem>();

  for (const item of items) {
    const key = (cleanField(item.name) ?? item.name).toUpperCase();
    const existing = map.get(key);

    if (!existing) {
      map.set(key, item);
      continue;
    }

    const existingScore = (existing.price ? 2 : 0) + (existing.description ? 1 : 0);
    const nextScore = (item.price ? 2 : 0) + (item.description ? 1 : 0);

    if (nextScore > existingScore) {
      map.set(key, item);
    }
  }

  return [...map.values()];
}

function isLikelyDescriptionLine(line: string): boolean {
  if (looksLikeMoney(line)) return false;
  if (looksLikeSectionHeader(line)) return false;
  if (/^US\$?/i.test(line)) return false;
  if (/^[A-Z0-9\s'&\-:/()#.]+$/.test(line) && line.length < 60) return false;
  return /[a-z]/.test(line);
}

function parseMenuText(text: string, sourceFile: string): ParsedMenu {
  const lines = normalizeLines(text);
  const sections: MenuSection[] = [];

  let current: MenuSection = { section: 'MENU', items: [] };
  let pendingName: string | null = null;
  let lastItem: MenuItem | null = null;

  const flushSection = () => {
    const deduped = dedupeItems(current.items)
      .map((item) => ({
        name: cleanField(item.name) ?? item.name,
        price: cleanField(item.price),
        description: cleanField(item.description)
      }))
      .filter((item) => item.name);

    if (deduped.length > 0) {
      sections.push({
        section: cleanField(current.section) ?? current.section,
        items: deduped
      });
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (isNoise(line)) continue;

    if (looksLikeSectionHeader(line)) {
      if (pendingName) {
        current.items.push({ name: pendingName });
        pendingName = null;
      }

      flushSection();
      current = { section: normalizeSectionName(line), items: [] };
      lastItem = null;
      continue;
    }

    if (looksLikeMoney(line)) {
      const price = parseMoney(line);
      if (pendingName && price) {
        const item: MenuItem = { name: pendingName, price };
        current.items.push(item);
        lastItem = item;
        pendingName = null;
      }
      continue;
    }

    const embedded = extractTrailingMoney(line);
    if (embedded.price) {
      const item: MenuItem = {
        name: embedded.name,
        price: embedded.price
      };
      current.items.push(item);
      lastItem = item;
      pendingName = null;
      continue;
    }

    if (isLikelyDescriptionLine(line) && lastItem) {
      appendDescription(lastItem, line);
      continue;
    }

    if (pendingName) {
      current.items.push({ name: pendingName });
    }

    pendingName = cleanField(line) ?? line;
    lastItem = null;
  }

  if (pendingName) {
    current.items.push({ name: pendingName });
  }

  flushSection();

  const filteredSections = sections
    .map((section) => {
      const sectionScore = scoreMealSection(section.section);

      const keptItems = section.items.filter((item) => {
        const itemScore = scoreMealItem(item, section.section);

        if (sectionScore <= -2) return itemScore >= 4;
        if (sectionScore >= 2) return itemScore >= 1;
        return itemScore >= 3;
      });

      return {
        section: section.section,
        items: dedupeItems(keptItems)
      };
    })
    .filter((section) => {
      if (section.items.length === 0) return false;
      const score = scoreMealSection(section.section);
      return score >= -1 || section.items.length >= 2;
    });

  return {
    sourceFile,
    extractedAt: new Date().toISOString(),
    sections: filteredSections
  };
}

async function main() {
  const inputPath = process.argv[2];

  if (!inputPath) {
    console.error('Usage: npm run parse -- ./menu.pdf');
    process.exit(1);
  }

  const absoluteInput = path.resolve(process.cwd(), inputPath);
  const dataBuffer = await fs.readFile(absoluteInput);
  const result = await pdf(dataBuffer);
  const parsed = parseMenuText(result.text, path.basename(absoluteInput));

  const rawOut = path.resolve(process.cwd(), 'output.raw.txt');
  const jsonOut = path.resolve(process.cwd(), 'output.parsed.json');

  await fs.writeFile(rawOut, result.text, 'utf8');
  await fs.writeFile(jsonOut, JSON.stringify(parsed, null, 2), 'utf8');

  console.log(`Wrote ${rawOut}`);
  console.log(`Wrote ${jsonOut}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});