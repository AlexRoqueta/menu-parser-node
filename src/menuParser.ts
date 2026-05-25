import pdf from 'pdf-parse';

type PriceTier = { label?: string; price: number };

export type MenuItem = {
  name: string;
  description?: string;
  price?: string;
  priceTiers?: PriceTier[];
  pieceCounts?: number[];
  platterSizing?: string;
};

export type MenuSection = {
  section: string;
  items: MenuItem[];
  notes?: string;
  platterTiers?: { label: string; price: number }[];
};

export type ParsedMenu = {
  sourceFile: string;
  extractedAt: string;
  sections: MenuSection[];
};

export type TableSommDish = {
  id: string;
  name: string;
  category: string;
  protein: string;
  style: string;
  price: number | null;
  priceTiers?: PriceTier[];
  pieceCounts?: number[];
  platterSizing?: string;
  tags: string[];
  notes: string;
  section: string;
};

const SECTION_RE = /^::\s*(.+?)\s*::$/;
const TOP_LEVEL_HEADINGS = new Set([
  'MENU',
  'DINNER',
  'LUNCH',
  'BRUNCH',
  'PACIFIC',
  'EASTERN',
  'OYSTER SAMPLER',
  'HALFWHOLE',
  'WHOLE',
  'EACH',
  '½ DOZEN',
  '1 DOZEN',
  'EACH½ DOZEN1 DOZEN',
  'EACH½ POUND1 POUND'
]);

const INLINE_SECTION_NAMES = new Set([
  'ICED SHELLFISH PLATTERS',
  'WHOLE FISH',
  'ENTREES',
  'USDA PRIME STEAKS',
  'WAGYU GOLD',
  'SIDES',
  'CRUSTACEANS',
  'SALADS & SANDWICHES'
]);

const PROMO_SECTIONS = new Set(['FIRST OF SEASON: WILD PACIFIC HALIBUT']);

const STEAK_SECTION_RE = /STEAK|WAGYU|FILET|RIBEYE/i;
const STEAK_PARENT_RE =
  /^(?:FILET MIGNON|NEW YORK STEAK|WAGYU FLIGHT|PRIME NEW YORK STRIP|PRIME RIBEYE|RIBEYE)$/i;

const PLATTER_SECTION = 'ICED SHELLFISH PLATTERS';
const PLATTER_TIER_RE = /^THE (GRAND|DELUXE|KING)$/i;
const PLATTER_SERVES_RE = /^serves\s+\d+(?:-\d+)?$/i;
const PLATTER_SIZING_RE = /^(?:½+WHOLE|WHOLE|½+)$/i;

const PRICE_RE = /(\$?\d+(?:\.\d{2})?)\s*$/;
const LEADER_DOTS_RE = /\.{3,}/g;
const GLUED_PRICES_RE = /(\d+\.\d{2})(?=\d)/g;
const DATE_STUB_RE =
  /\b(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),\s+\w+(?:\s+\d+(?:st|nd|rd|th)?)?\b/g;
const STEAK_SIZE_RE = /(\d+oz\s+[^*·]+?\*)/g;
const SIZE_PRICE_LINE_RE = /^(\d+oz\s+[^*]+?\*)\s+(\$?\d+(?:\.\d{2})?)$/;
const MULTI_SIZE_LINE_RE =
  /^((?:\d+oz\s+[^*·]+?\*\s*·\s*)+\d+oz\s+[^*]+?\*)\s+(\$?\d+(?:\.\d{2})?)$/;

const JUNK_RE =
  /^(?:\*+|[½¼¾]+|th|nd|rd|st|EACH½ DOZEN1 DOZEN|EACH½ POUND1 POUND|HALFWHOLE|½WHOLE|½½WHOLE|[\s\W]+)$/i;

export function normalizeLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .map((line) => line.replace(DATE_STUB_RE, '').trim())
    .map((line) => line.replace(LEADER_DOTS_RE, ' ').replace(/\s+/g, ' ').trim())
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
  if (/^(general manager|executive chef|chef de cuisine|sous chef|owner|head chef)\b/i.test(line))
    return true;
  if (/^first of season!?$/i.test(line)) return true;
  if (/^[A-Z][A-Z\s&]+(?:RANCH|FARMS?|RANCHES)\b.*·/i.test(line)) return true;
  if (/^SNAKE RIVER FARMS\b/i.test(line)) return true;
  if (/^DOUBLE R RANCH\b/i.test(line)) return true;
  return false;
}

function looksLikeNewItem(line: string): boolean {
  const firstWord = line.split(/\s/)[0];
  if (!/^[A-Z0-9'"&\-.()*]/.test(firstWord)) return false;
  const firstTokenMatch = line.match(/^[A-Z0-9'"&\-.()*]+(?:\s+[A-Z0-9'"&\-.()*]+)*/);
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
  const numericTiers: PriceTier[] = prices.map((p) => ({
    price: Number(p.replace(/\$/g, ''))
  }));
  return { name, price: prices[0], priceTiers: numericTiers };
}

function splitGluedCounts(digits: string): number[] | null {
  if (!/^\d+$/.test(digits) || digits.length < 3 || digits.length > 6) return null;
  const candidates: number[][] = [];
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
  const ndec = candidates.filter((c) => c[0] <= c[1] && c[1] <= c[2]);
  if (ndec.length > 0) {
    ndec.sort((x, y) => (x[2] - x[0]) - (y[2] - y[0]));
    return ndec[0];
  }
  return candidates[0];
}

export function parseMenuText(text: string, sourceFile: string): ParsedMenu {
  const lines = normalizeLines(text);
  const sections: MenuSection[] = [];
  let current: MenuSection = { section: 'MENU', items: [] };
  let lastSteakParent: string | null = null;
  let platterTierLabels: string[] = [];
  let platterTotalsCaptured = false;
  const pendingSectionNotes: Map<string, string> = new Map();

  function flushCurrent() {
    if (
      current.items.length > 0 ||
      current.section !== 'MENU' ||
      current.notes ||
      current.platterTiers
    ) {
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
    platterTierLabels = [];
    platterTotalsCaptured = false;
  }

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (isSection(line)) {
      flushCurrent();
      const newSectionName = extractSectionName(line);
      current = { section: newSectionName, items: [] };
      const pending = pendingSectionNotes.get(newSectionName);
      if (pending) {
        current.notes = pending;
        pendingSectionNotes.delete(newSectionName);
      }
      lastSteakParent = null;
      resetPlatterState();
      continue;
    }

    if (INLINE_SECTION_NAMES.has(line.toUpperCase())) {
      flushCurrent();
      current = { section: line.toUpperCase(), items: [] };
      lastSteakParent = null;
      resetPlatterState();
      continue;
    }

    // === ICED SHELLFISH PLATTERS special handling ===
    if (current.section === PLATTER_SECTION) {
      const tierMatch = line.match(PLATTER_TIER_RE);
      if (tierMatch) {
        platterTierLabels.push(tierMatch[1].toUpperCase());
        continue;
      }
      if (PLATTER_SERVES_RE.test(line)) continue;

      const totalsTokens = line.split(/\s+/);
      if (
        !platterTotalsCaptured &&
        totalsTokens.length === 3 &&
        totalsTokens.every((t) => /^\$?\d+(?:\.\d{2})?$/.test(t))
      ) {
        const labels =
          platterTierLabels.length === 3 ? platterTierLabels : ['GRAND', 'DELUXE', 'KING'];
        current.platterTiers = totalsTokens.map((p, i) => ({
          label: labels[i],
          price: Number(p.replace(/\$/g, ''))
        }));
        platterTotalsCaptured = true;
        continue;
      }

      if (/^\d{3,6}$/.test(line)) {
        const counts = splitGluedCounts(line);
        if (counts && current.items.length > 0) {
          const last = current.items[current.items.length - 1];
          last.pieceCounts = counts;
          if (!last.description) {
            last.description = `pieces per platter: ${platterTierLabels[0] || 'Grand'} ${
              counts[0]
            }, ${platterTierLabels[1] || 'Deluxe'} ${counts[1]}, ${
              platterTierLabels[2] || 'King'
            } ${counts[2]}`;
          }
          continue;
        }
        continue;
      }

      if (PLATTER_SIZING_RE.test(line)) {
        if (current.items.length > 0) {
          current.items[current.items.length - 1].platterSizing = line.toUpperCase();
        }
        continue;
      }

      if (isJunk(line)) continue;

      if (/^\(/.test(line) || !looksLikeNewItem(line)) {
        if (current.items.length > 0) {
          const last = current.items[current.items.length - 1];
          last.description = last.description ? `${last.description} ${line}`.trim() : line;
        }
        continue;
      }

      current.items.push({ name: line });
      continue;
    }

    if (TOP_LEVEL_HEADINGS.has(line.toUpperCase())) continue;
    if (isJunk(line)) continue;

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
        current.items.push({
          name: `${lastSteakParent} — ${sp[1].trim()}`,
          price: sp[2]
        });
        continue;
      }
    }

    if (current.items.length === 0 && /^(served with|with |topped with)\b/i.test(line)) {
      current.notes = current.notes ? `${current.notes} ${line}` : line;
      pendingSectionNotes.set(current.section, current.notes);
      continue;
    }

    if (/^\(/.test(line) && current.items.length > 0) {
      const prev = current.items[current.items.length - 1];
      const priceMatch = line.match(PRICE_RE);
      const textPart = priceMatch ? line.replace(PRICE_RE, '').trim() : line;
      prev.description = prev.description ? `${prev.description} ${textPart}`.trim() : textPart;
      if (priceMatch && !prev.price) prev.price = priceMatch[1];
      continue;
    }

    if (!looksLikeNewItem(line) && current.items.length > 0) {
      const prev = current.items[current.items.length - 1];
      const priceMatch = line.match(PRICE_RE);
      const textPart = priceMatch ? line.replace(PRICE_RE, '').trim() : line;
      prev.description = prev.description ? `${prev.description} ${textPart}`.trim() : textPart;
      if (priceMatch && !prev.price) prev.price = priceMatch[1];
      continue;
    }

    if (inSteakSection && !STEAK_PARENT_RE.test(line)) {
      lastSteakParent = null;
    }

    current.items.push(parseItem(line));
  }

  flushCurrent();
  for (const [sectionName, note] of pendingSectionNotes.entries()) {
    for (const sec of sections) {
      if (sec.section === sectionName) {
        sec.notes = sec.notes ? `${sec.notes} ${note}` : note;
      }
    }
  }

  for (const section of sections) {
    if (PROMO_SECTIONS.has(section.section)) {
      section.items = section.items.filter(
        (it) =>
          /^[A-Z]/.test(it.name) &&
          it.name.length < 80 &&
          it.price &&
          Number(it.price) < 500
      );
    }
  }

  for (const section of sections) {
    if (!STEAK_SECTION_RE.test(section.section)) continue;
    const expanded: MenuItem[] = [];
    for (const item of section.items) {
      const haystack = `${item.name} ${item.description ?? ''}`;
      const sizeMatches = [...haystack.matchAll(STEAK_SIZE_RE)].map((m) => m[1].trim());

      if (sizeMatches.length >= 2) {
        let baseName = item.name;
        for (const sz of sizeMatches) baseName = baseName.replace(sz, '').trim();
        baseName = baseName
          .replace(/\s{2,}/g, ' ')
          .replace(/[—\-]\s*$/, '')
          .trim();
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

  const merged: MenuSection[] = [];
  const indexByName = new Map<string, number>();
  for (const sec of sections) {
    const key = sec.section.trim().toUpperCase();
    if (indexByName.has(key)) {
      const idx = indexByName.get(key)!;
      merged[idx].items.push(...sec.items);
      if (sec.notes) {
        merged[idx].notes = merged[idx].notes
          ? `${merged[idx].notes} ${sec.notes}`
          : sec.notes;
      }
      if (sec.platterTiers && !merged[idx].platterTiers) {
        merged[idx].platterTiers = sec.platterTiers;
      }
    } else {
      indexByName.set(key, merged.length);
      merged.push(sec);
    }
  }

  for (const sec of merged) {
    const seen = new Set<string>();
    sec.items = sec.items.filter((it) => {
      const sig = `${it.name}|${it.price ?? ''}|${it.description ?? ''}`.toLowerCase();
      if (seen.has(sig)) return false;
      seen.add(sig);
      return true;
    });
  }

  function ensureSection(name: string): MenuSection {
    for (const s of merged) {
      if (s.section.toUpperCase() === name.toUpperCase()) return s;
    }
    const s: MenuSection = { section: name, items: [] };
    merged.push(s);
    return s;
  }

  const crust = merged.find((s) => s.section.toUpperCase() === 'CRUSTACEANS');
  if (crust) {
    const SANDWICH_PATTERNS = [
      /^ROASTED CHICKEN/i,
      /^WILD JUMBO SHRIMP LOUIE/i,
      /^BACON CHEDDAR CHEESEBURGER/i,
      /^NEW ENGLAND LOBSTER ROLL/i
    ];
    const movedToSandwich: MenuItem[] = [];
    crust.items = crust.items.filter((it) => {
      if (SANDWICH_PATTERNS.some((re) => re.test(it.name))) {
        movedToSandwich.push(it);
        return false;
      }
      return true;
    });
    if (movedToSandwich.length > 0) {
      const sandwich = ensureSection('SALADS & SANDWICHES');
      sandwich.items.push(...movedToSandwich);
    }
  }

  const wagyu = merged.find((s) => s.section.toUpperCase() === 'WAGYU GOLD');
  if (wagyu) {
    const PRIME_BLEED_PATTERNS = [/^PRIME NEW YORK STRIP\b/i, /^PRIME RIBEYE\b/i];
    const movedToPrime: MenuItem[] = [];
    wagyu.items = wagyu.items.filter((it) => {
      if (PRIME_BLEED_PATTERNS.some((re) => re.test(it.name))) {
        movedToPrime.push(it);
        return false;
      }
      return true;
    });
    if (movedToPrime.length > 0) {
      const prime = ensureSection('USDA PRIME STEAKS');
      prime.items.push(...movedToPrime);
    }
    for (const it of wagyu.items) {
      if (/^FILET MIGNON\b/i.test(it.name) && !/WAGYU/i.test(it.name)) {
        it.name = `WAGYU ${it.name}`;
      } else if (/^RIBEYE\b/i.test(it.name) && !/WAGYU/i.test(it.name)) {
        it.name = `WAGYU ${it.name}`;
      }
    }
  }

  const wagyu2 = merged.find((s) => s.section.toUpperCase() === 'WAGYU GOLD');
  if (wagyu2) {
    const flights: MenuItem[] = [];
    const other: MenuItem[] = [];
    for (const it of wagyu2.items) {
      if (/^WAGYU FLIGHT/i.test(it.name)) flights.push(it);
      else other.push(it);
    }
    if (flights.length > 1) {
      const sizes = flights.map((f) => {
        const m = f.name.match(/—\s*(.+)$/);
        return m ? m[1].trim() : f.name;
      });
      const priceObj = flights.find((f) => f.price);
      const combined: MenuItem = {
        name: `WAGYU FLIGHT — ${sizes.join(' · ')}`,
        price: priceObj?.price
      };
      const firstFlightIdx = wagyu2.items.indexOf(flights[0]);
      wagyu2.items = other;
      wagyu2.items.splice(firstFlightIdx, 0, combined);
    }
  }

  for (let i = merged.length - 1; i >= 0; i--) {
    const s = merged[i];
    if (s.items.length === 0 && !s.notes && !s.platterTiers) {
      merged.splice(i, 1);
    }
  }

  for (const sec of merged) {
    if (!sec.notes) continue;
    let notes = sec.notes.trim();
    const half = Math.floor(notes.length / 2);
    if (notes.length % 2 === 1 && notes[half] === ' ') {
      const left = notes.slice(0, half).trim();
      const right = notes.slice(half + 1).trim();
      if (left.toLowerCase() === right.toLowerCase()) notes = left;
    } else if (notes.length % 2 === 0) {
      const left = notes.slice(0, half).trim();
      const right = notes.slice(half).trim();
      if (left.toLowerCase() === right.toLowerCase()) notes = left;
    }
    const parts = notes
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter(Boolean);
    const seen = new Set<string>();
    const uniq: string[] = [];
    for (const p of parts) {
      const key = p.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      uniq.push(p);
    }
    sec.notes = uniq.join(' ');
  }

  return {
    sourceFile,
    extractedAt: new Date().toISOString(),
    sections: merged
  };
}
function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

function inferProtein(text: string): string {
  const t = text.toLowerCase();
  if (
    /(tuna|salmon|halibut|cod|bass|swordfish|lobster|shrimp|crab|scallop|mussel|clam|oyster|octopus|urchin|sablefish|seafood|fish|cioppino|poke|hamachi|sashimi|sushi|prawn|calamari|anchovy|toro)/.test(
      t
    )
  )
    return 'seafood';
  if (/(chicken|duck|turkey|poultry)/.test(t)) return 'chicken';
  if (
    /(beef|steak|filet|ribeye|wagyu|burger|mignon|ny strip|new york strip|porterhouse|t-bone)/.test(
      t
    )
  )
    return 'beef';
  if (/(pork|ham|bacon|chorizo|prosciutto|pancetta)/.test(t)) return 'pork';
  if (
    /(vegetable|vegan|vegetarian|greens|beet|salad|yam|avocado|cucumber|kale|asparagus|mushroom|potato)/.test(
      t
    )
  )
    return 'vegetarian';
  if (
    /(vodka|gin|tequila|whiskey|whisky|rum|mezcal|bourbon|cocktail|prosecco|wine|aperol|amaro|spritz|tonic|bitters)/.test(
      t
    )
  )
    return 'n/a';
  return 'unknown';
}

function inferStyle(text: string): string {
  const t = text.toLowerCase();
  if (/(light|citrus|crudo|vinaigrette|fresh)/.test(t)) return 'light';
  if (/(bold|smoked|rosemary|pepper|spiced|harissa|curry|chili|jalape)/.test(t)) return 'bold';
  if (
    /(mango|papaya|pineapple|berry|strawberry|grapefruit|passion fruit|elderflower)/.test(
      t
    )
  )
    return 'fruit';
  return 'classic';
}

function inferCategory(section: string, itemName: string, protein: string): string {
  const t = `${section} ${itemName}`.toLowerCase();
  if (protein === 'n/a' || /(cocktail|spirit free|wine|beer|bartender)/.test(t)) return 'drink';
  if (/(dessert|sorbet|cake|ice cream|panna cotta)/.test(t)) return 'dessert';
  if (/(side)/.test(t)) return 'side';
  if (
    /(salad|appetizer|sushi|raw bar|shellfish|chilled|tartare|poke|nachos|roll|platter)/.test(
      t
    )
  )
    return 'starter';
  return 'main';
}

function toNumber(price?: string): number | null {
  if (!price) return null;
  const first = price.split('/')[0].trim();
  const n = Number(first.replace(/\$/g, ''));
  return Number.isFinite(n) ? n : null;
}

export function toTableSommDishes(parsed: ParsedMenu): TableSommDish[] {
  const dishes: TableSommDish[] = [];
  for (const section of parsed.sections) {
    for (const item of section.items) {
      const name = item.name.trim();
      if (!name || name.length < 3) continue;
      if (/^(menu|dinner|lunch|brunch|pacific|eastern)$/i.test(name)) continue;
      if (/^::.+::$/.test(name)) continue;
      if (
        !item.price &&
        !item.pieceCounts &&
        !item.platterSizing &&
        name.length > 60 &&
        /\s[a-z]/.test(name)
      )
        continue;

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
      if (item.platterSizing) dish.platterSizing = item.platterSizing;
      dishes.push(dish);
    }
  }
  return dishes;
}

export function filterMealDishes(dishes: TableSommDish[]): TableSommDish[] {
  const allowedSections = new Set([
    'ENTREES',
    'USDA PRIME STEAKS',
    'WAGYU GOLD',
    'SALADS & SANDWICHES'
  ]);
  return dishes.filter((dish) => {
    if (dish.category === 'drink' || dish.category === 'dessert' || dish.category === 'side') {
      return false;
    }
    if (allowedSections.has(dish.section.toUpperCase())) return true;
    if (dish.category !== 'main') return false;

    const text = `${dish.name} ${dish.notes}`;
    if (
      /(roll|salad|nachos|poke|tartare|sushi|shellfish|platter|oyster|clam|mussel|shrimp louie)/i.test(
        text
      )
    ) {
      return false;
    }
    return true;
  });
}

export function filterParsedMenuToDishes(
  parsed: ParsedMenu,
  dishes: TableSommDish[]
): ParsedMenu {
  const bySection = new Map<string, Set<string>>();
  for (const dish of dishes) {
    const key = dish.section.toUpperCase();
    if (!bySection.has(key)) bySection.set(key, new Set());
    bySection.get(key)!.add(dish.name.trim().toUpperCase());
  }
  return {
    ...parsed,
    sections: parsed.sections
      .map((section) => {
        const names = bySection.get(section.section.toUpperCase());
        if (!names) return null;
        const items = section.items.filter((item) =>
          names.has(item.name.trim().toUpperCase())
        );
        if (items.length === 0) return null;
        return { ...section, items };
      })
      .filter((s): s is MenuSection => Boolean(s))
  };
}

export async function extractTextFromUpload(
  buffer: Buffer,
  originalname: string,
  mimetype?: string
): Promise<string> {
  if (/\.pdf$/i.test(originalname) || mimetype === 'application/pdf') {
    const result = await pdf(buffer);
    return result.text;
  }
  if (
    (mimetype && mimetype.startsWith('image/')) ||
    /\.(png|jpe?g|webp|gif|bmp|tiff?)$/i.test(originalname)
  ) {
    throw new Error(
      'Image upload is accepted by the API, but OCR is not implemented yet. Add Tesseract or a vision service before enabling image parsing in production.'
    );
  }
  throw new Error('Only PDF and image files are supported.');
}