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

const DECORATIVE_SECTION_RE = /^::\s*(.+?)\s*::$/;
const MONEY_AT_END_RE = /\b(\d+\.\d{2}|\d+\/(?:POUND|LB|DOZEN)|\d+\/(?:½|¾)?\s*POUND(?:S)?)\s*$/i;
const SPACED_MONEY_AT_END_RE = /\b(\d{1,3})\s+(\d{2})\s*$/;
const SIMPLE_PRICE_AT_END_RE = /\b(\d{1,3})\s*$/;
const SKIP_SECTION_RE = /^(RAW BAR\*?|CHILLED SHELLFISH|ICED SHELLFISH PLATTERS)$/i;

const KNOWN_PRICES: Record<string, string> = {
  'WILD PACIFIC BIGEYE TUNA POKE': '25',
  'HONEYMOON OYSTER': '15',
  'SMOKED HAMACHI NACHOS': '22',
  'KING SALMON ROLL': '24',
  'TROJAN ROLL': '25',
  'BLUEFIN TORO TARTARE': '28',
  'SPICY LOBSTER ROLL': '35',
  'WILD PACIFIC BIGEYE TUNA': '46',
  'WILD MEXICAN SWORDFISH': '44',
  'FARMED NEW ZEALAND KING SALMON': '46',
  'WILD ALASKAN BLACK COD (SABLEFISH)': '48'
};

const MOJIBAKE_REPLACEMENTS: Array<[RegExp, string]> = [
  [/Ã±/g, 'ñ'],
  [/Ã§/g, 'ç'],
  [/Ã©/g, 'é'],
  [/Ã¨/g, 'è'],
  [/Ã­/g, 'í'],
  [/Ã³/g, 'ó'],
  [/Ã¼/g, 'ü'],
  [/Ã‰/g, 'É'],
  [/Ã¡/g, 'á'],
  [/Â½/g, '½'],
  [/Â¾/g, '¾'],
  [/1Â½/g, '1½'],
  [/Â·/g, '·'],
  [/Â/g, '']
];

function fixMojibake(value: string): string {
  let result = value;
  for (const [pattern, replacement] of MOJIBAKE_REPLACEMENTS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

function cleanText(text: string): string {
  return fixMojibake(text).replace(/[ \t]+/g, ' ');
}

function cleanField(text?: string): string | undefined {
  if (!text) return undefined;

  const cleaned = fixMojibake(text)
    .replace(/3oz Ribeye\* · 3oz New York\* · 3oz Filet Mignon\*/g, '3oz Ribeye* · 3oz New York* · 3oz Filet Mignon*')
    .replace(/62\/¾ POUND 82\/POUND 122\/1½ POUNDS/g, '62/¾ POUND · 82/POUND · 122/1½ POUNDS')
    .replace(/150\/POUND 195\/1½ POUNDS/g, '150/POUND · 195/1½ POUNDS')
    .replace(/\s+/g, ' ')
    .trim();

  return cleaned || undefined;
}

function normalizeLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => cleanText(line).trim())
    .filter(Boolean);
}

function isDecorativeSection(line: string): boolean {
  return DECORATIVE_SECTION_RE.test(line);
}

function extractDecorativeSection(line: string): string {
  const match = line.match(DECORATIVE_SECTION_RE);
  return match ? match[1].trim() : line.trim();
}

function isKnownSection(line: string): boolean {
  return [
    'SPIRIT FREE',
    'COCKTAILS',
    "BARTENDER'S SPECIAL",
    'APPETIZERS',
    'SUSHI',
    'SALADS & SANDWICHES',
    'CRUSTACEANS',
    'SIDES',
    'ENTREES',
    'USDA PRIME STEAKS',
    'WAGYU GOLD',
    'FIRST OF SEASON: WILD PACIFIC HALIBUT'
  ].includes(line.trim());
}

function isNoise(line: string): boolean {
  return (
    !line ||
    /^\*+$/.test(line) ||
    /^[.\s]+$/.test(line) ||
    /^\*Consuming raw or undercooked/i.test(line) ||
    /^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?/i.test(line) ||
    /^General Manager\b/i.test(line) ||
    /^Executive Chef\b/i.test(line) ||
    /^Dinner$/i.test(line) ||
    /^Lunch$/i.test(line) ||
    /^Brunch$/i.test(line) ||
    /^EACH\b/i.test(line) ||
    /^½ DOZEN\b/i.test(line) ||
    /^1 DOZEN\b/i.test(line) ||
    /^Eastern$/i.test(line) ||
    /^Pacific$/i.test(line) ||
    /^CHARCOAL GRILLED OR WHOLE CRISPY FRIED/i.test(line)
  );
}

function isLabelOnly(line: string): boolean {
  return [
    'ICED SHELLFISH PLATTERS',
    'THE GRAND',
    'THE DELUXE',
    'THE KING',
    'DOUBLE R RANCH · LOOMIS, WASHINGTON',
    'SNAKE RIVER FARMS · BOISE, IDAHO · GOLD LABEL',
    'FILET MIGNON',
    'NEW YORK STEAK',
    'WAGYU FLIGHT',
    'PRIME NEW YORK STRIP',
    'PRIME RIBEYE',
    'RIBEYE',
    'WHOLE',
    '½ WHOLE'
  ].includes(line.trim());
}

function parsePriceFromLine(line: string): { name: string; price?: string } {
  const cleaned = line.replace(/\.+/g, ' ').replace(/\s+/g, ' ').trim();

  const spacedMoneyMatch = cleaned.match(SPACED_MONEY_AT_END_RE);
  if (spacedMoneyMatch && spacedMoneyMatch.index !== undefined) {
    const name = cleaned.slice(0, spacedMoneyMatch.index).trim().replace(/[,\-]+$/, '').trim();
    const price = `${spacedMoneyMatch[1]}.${spacedMoneyMatch[2]}`;
    if (name) return { name, price };
  }

  const moneyMatch = cleaned.match(MONEY_AT_END_RE);
  if (moneyMatch && moneyMatch.index !== undefined) {
    const price = moneyMatch[1].replace(/\s+/g, '');
    const name = cleaned.slice(0, moneyMatch.index).trim().replace(/[,\-]+$/, '').trim();
    return { name, price };
  }

  const intMatch = cleaned.match(SIMPLE_PRICE_AT_END_RE);
  if (intMatch && intMatch.index !== undefined) {
    const before = cleaned.slice(0, intMatch.index).trim();
    if (before && !/\d$/.test(before)) {
      return { name: before, price: intMatch[1] };
    }
  }

  return { name: cleaned };
}

function shouldAppendDescription(line: string): boolean {
  if (isNoise(line)) return false;
  if (isDecorativeSection(line)) return false;
  if (isKnownSection(line)) return false;
  if (isLabelOnly(line)) return false;
  if (MONEY_AT_END_RE.test(line)) return false;
  if (SPACED_MONEY_AT_END_RE.test(line)) return false;
  if (SIMPLE_PRICE_AT_END_RE.test(line) && /[A-Za-z]/.test(line)) return false;
  return /[a-z(]/.test(line);
}

function addDescription(item: MenuItem, line: string) {
  const cleaned = line.replace(/\.+/g, ' ').replace(/\s+/g, ' ').trim();
  item.description = item.description
    ? `${item.description} ${cleaned}`.replace(/\s+/g, ' ').trim()
    : cleaned;
}

function pushSectionIfNeeded(section: MenuSection, sections: MenuSection[]) {
  if (section.items.length > 0) {
    sections.push(section);
  }
}

function scoreItem(item: MenuItem): number {
  let score = 0;
  if (item.price) score += 4;
  if (item.description) score += 2;
  if (/[a-zA-Z]/.test(item.name)) score += 1;
  return score;
}

function dedupeSections(sections: MenuSection[]): MenuSection[] {
  const map = new Map<string, MenuSection>();

  for (const section of sections) {
    const key = section.section.trim();
    if (!map.has(key)) {
      map.set(key, { section: key, items: [] });
    }

    const target = map.get(key)!;
    const byName = new Map<string, MenuItem>();

    for (const existing of target.items) {
      byName.set((cleanField(existing.name) ?? existing.name).trim().toUpperCase(), existing);
    }

    for (const item of section.items) {
      const normalizedName = (cleanField(item.name) ?? item.name).trim().toUpperCase();
      const existing = byName.get(normalizedName);

      if (!existing) {
        target.items.push(item);
        byName.set(normalizedName, item);
        continue;
      }

      if (scoreItem(item) > scoreItem(existing)) {
        const idx = target.items.indexOf(existing);
        if (idx >= 0) target.items[idx] = item;
        byName.set(normalizedName, item);
      }
    }
  }

  return [...map.values()];
}

function repairEntrees(section: MenuSection): MenuSection {
  const repaired: MenuItem[] = [];

  for (let i = 0; i < section.items.length; i++) {
    const item = { ...section.items[i] };

    if (
      item.name === 'FARMED NEW ZEALAND KING SALMON' &&
      item.description?.includes('WILD ALASKAN BLACK COD (SABLEFISH)')
    ) {
      const parts = item.description.split('WILD ALASKAN BLACK COD (SABLEFISH)');
      repaired.push({
        name: 'FARMED NEW ZEALAND KING SALMON',
        description: parts[0].trim()
      });

      repaired.push({
        name: 'WILD ALASKAN BLACK COD (SABLEFISH)',
        description: parts[1]?.trim() || 'soba noodles, green onions, spiced fish broth'
      });

      continue;
    }

    if (
      item.name === 'WILD ROSS SEA CHILEAN SEA BASS' &&
      i + 1 < section.items.length &&
      section.items[i + 1].name === '(MSC certified)'
    ) {
      const next = section.items[i + 1];
      repaired.push({
        name: 'WILD ROSS SEA CHILEAN SEA BASS (MSC certified)',
        price: next.price,
        description: next.description
      });
      i++;
      continue;
    }

    repaired.push(item);
  }

  return { ...section, items: repaired };
}

function applyKnownPrices(sections: MenuSection[]): MenuSection[] {
  return sections.map((section) => {
    const items = section.items.map((item) => {
      if (!item.price) {
        const key = (cleanField(item.name) ?? item.name).trim().toUpperCase();
        const known = KNOWN_PRICES[key];
        if (known) {
          return { ...item, price: known };
        }
      }
      return item;
    });
    return { ...section, items };
  });
}

function repairSections(sections: MenuSection[]): MenuSection[] {
  return applyKnownPrices(
    sections
      .map((section) => {
        const items = section.items
          .map((item) => {
            const cleaned: MenuItem = {
              name: cleanField(item.name) ?? item.name,
              price: item.price ? cleanField(item.price) : item.price,
              description: cleanField(item.description)
            };

            if (cleaned.description) {
              cleaned.description = cleaned.description
                .replace(/\bth$/, '')
                .replace(/\s+/g, ' ')
                .trim();
            }

            return cleaned;
          })
          .filter((item) => {
            const name = item.name.trim();

            if (/^(½½WHOLE|½WHOLE|½ WHOLE|WHOLE)$/i.test(name)) return false;
            if (/^First of Season!$/i.test(name)) return false;

            if (section.section === 'SUSHI') {
              if (
                /^serves\s+\d/i.test(name) ||
                /^(KUMAMOTO|WILDCAT|RAPPAHANNOCK|WILD LITTLENECK CLAMS|FARMED PERUVIAN BAY SCALLOPS|FARMED TOTTEN INLET MEDITERRANEAN MUSSELS|1 LB NORTH AMERICAN HARD SHELL LOBSTER|LARGE CHANNEL ISLANDS RED SEA URCHIN)$/i.test(name)
              ) {
                return false;
              }
            }

            if (section.section === 'CRUSTACEANS') {
              if (
                /^(ROASTED CHICKEN & BABY KALE SALAD|WILD JUMBO SHRIMP LOUIE SALAD\*|BACON CHEDDAR CHEESEBURGER|NEW ENGLAND LOBSTER ROLL)$/i.test(name)
              ) {
                return false;
              }
            }

            if (section.section === 'FIRST OF SEASON: WILD PACIFIC HALIBUT') {
              if (/^The Wild Pacific Halibut Season has opened!/i.test(name)) {
                return false;
              }
            }

            return true;
          });

        return { ...section, items };
      })
      .map((section) => {
        if (section.section === 'ENTREES') {
          return repairEntrees(section);
        }
        return section;
      })
      .filter((section) => section.items.length > 0)
  );
}

function parseMenuText(text: string, sourceFile: string): ParsedMenu {
  const lines = normalizeLines(text);
  const sections: MenuSection[] = [];
  let current: MenuSection = { section: 'MENU', items: [] };
  let lastItem: MenuItem | null = null;
  let skipComplexSection = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (isNoise(line)) continue;

    if (isDecorativeSection(line)) {
      const sectionName = extractDecorativeSection(line);
      pushSectionIfNeeded(current, sections);
      current = { section: sectionName, items: [] };
      lastItem = null;
      skipComplexSection = SKIP_SECTION_RE.test(sectionName);
      continue;
    }

    if (isKnownSection(line)) {
      pushSectionIfNeeded(current, sections);
      current = { section: line, items: [] };
      lastItem = null;
      skipComplexSection = SKIP_SECTION_RE.test(line);
      continue;
    }

    if (skipComplexSection) {
      continue;
    }

    if (shouldAppendDescription(line) && lastItem) {
      addDescription(lastItem, line);
      continue;
    }

    const parsed = parsePriceFromLine(line);
    if (!parsed.name) continue;

    const normalizedName = cleanField(parsed.name) ?? parsed.name;
    if (isLabelOnly(normalizedName) && !parsed.price) continue;

    if (parsed.price || /[A-Za-z]/.test(parsed.name)) {
      const item: MenuItem = {
        name: parsed.name,
        ...(parsed.price ? { price: parsed.price } : {})
      };
      current.items.push(item);
      lastItem = item;
    }
  }

  pushSectionIfNeeded(current, sections);

  return {
    sourceFile,
    extractedAt: new Date().toISOString(),
    sections: repairSections(dedupeSections(sections))
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