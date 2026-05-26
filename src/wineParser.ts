import { normalizeLines } from './menuParser.js';

export type WineEntry = {
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
  priceTiers?: { label?: string; price: number }[];
  category?: string;
  style?: string;
  body?: string;
  tags: string[];
  notes?: string;
  binNumber?: string;
  section: string;
};

export type ParsedWineSection = {
  section: string;
  category: string;
  items: WineEntry[];
};

export type ParsedWineList = {
  sourceFile: string;
  extractedAt: string;
  sections: ParsedWineSection[];
};

const SECTION_CANONICAL: Array<{ category: string; patterns: RegExp[] }> = [
  {
    category: 'sparkling',
    patterns: [/^sparkling$/i, /\bsparkling wines?\b/i, /\bbubbles?\b/i, /\bcr[ée]mant\b/i, /^cava$/i, /^prosecco$/i, /\bfranciacorta\b/i, /\bpet[\s-]?nat\b/i]
  },
  {
    category: 'champagne',
    patterns: [/^champagne$/i, /\bchampagne(s)?\b/i]
  },
  {
    category: 'rose',
    patterns: [/^ros[ée]$/i, /^ros[ée]s$/i, /\bros[ée] wines?\b/i]
  },
  {
    category: 'orange',
    patterns: [/^orange$/i, /\borange wines?\b/i, /\bskin[\s-]?contact\b/i, /\bamber wines?\b/i]
  },
  {
    category: 'white',
    patterns: [/^whites?$/i, /\bwhite wines?\b/i, /\bvins blancs?\b/i, /^blancs?$/i]
  },
  {
    category: 'red',
    patterns: [/^reds?$/i, /\bred wines?\b/i, /^rouges?$/i, /\bvins rouges?\b/i]
  },
  {
    category: 'dessert',
    patterns: [/^dessert$/i, /\bdessert wines?\b/i, /\bsweet wines?\b/i, /\bvin doux\b/i, /\bsauternes?\b/i, /\bice ?wines?\b/i, /\btokaji?\b/i, /\blate harvest\b/i]
  },
  {
    category: 'fortified',
    patterns: [/^fortified$/i, /\bfortified wines?\b/i, /^port$/i, /^sherry$/i, /^madeira$/i, /^marsala$/i, /^vermouth$/i]
  },
  {
    category: 'sake',
    patterns: [/^sake$/i, /\bnihonshu\b/i, /\bjunmai\b/i, /\bdaiginjo\b/i]
  }
];

const COUNTRY_REGIONS: Record<string, { country: string; regions: RegExp[] }> = {
  france: {
    country: 'France',
    regions: [/\bburgundy\b/i, /\bbourgogne\b/i, /\bbordeaux\b/i, /\bchampagne\b/i, /\bloire\b/i, /\brh[oô]ne\b/i, /\balsace\b/i, /\bbeaujolais\b/i, /\bprovence\b/i, /\blanguedoc\b/i, /\broussillon\b/i, /\bsancerre\b/i, /\bch[aâ]blis\b/i, /\bch[aâ]teauneuf\b/i, /\bpouilly[\s-]?fum[eé]\b/i, /\bcondrieu\b/i, /\bvouvray\b/i, /\bcornas\b/i, /\bgevrey/i, /\bvolnay\b/i, /\bpommard\b/i, /\bmeursault\b/i, /\bmontrachet\b/i, /\bp[oô]merol\b/i, /\bst[\s.-]?[eé]milion\b/i, /\bm[eé]doc\b/i, /\bmargaux\b/i, /\bpauillac\b/i, /\bst[\s.-]?julien\b/i]
  },
  italy: {
    country: 'Italy',
    regions: [/\btuscany\b/i, /\btoscana\b/i, /\bpiedmont\b/i, /\bpiemonte\b/i, /\bbarolo\b/i, /\bbarbaresco\b/i, /\bbrunello\b/i, /\bchianti\b/i, /\bmontepulciano\b/i, /\bsicily\b/i, /\bsicilia\b/i, /\bveneto\b/i, /\bvalpolicella\b/i, /\bamarone\b/i, /\bsoave\b/i, /\bfriuli\b/i, /\btrentino\b/i, /\balto adige\b/i, /\bumbria\b/i, /\babruzzo\b/i, /\bcampania\b/i, /\bpuglia\b/i, /\bsardin[ia]\b/i, /\baeolian\b/i, /\betna\b/i]
  },
  spain: {
    country: 'Spain',
    regions: [/\brioja\b/i, /\bribera del duero\b/i, /\bpriorat\b/i, /\bpenedès\b/i, /\bpened[eé]s\b/i, /\brueda\b/i, /\bjerez\b/i, /\btoro\b/i, /\bgalicia\b/i, /\brias baixas\b/i, /\br[ií]as baixas\b/i, /\bmontsant\b/i, /\bbierzo\b/i, /\bnavarra\b/i, /\bmancha\b/i]
  },
  portugal: {
    country: 'Portugal',
    regions: [/\bdouro\b/i, /\balentejo\b/i, /\bdão\b/i, /\bdao\b/i, /\bvinho verde\b/i, /\bbairrada\b/i, /\bmadeira\b/i]
  },
  germany: {
    country: 'Germany',
    regions: [/\bmosel\b/i, /\brheingau\b/i, /\brheinhessen\b/i, /\bpfalz\b/i, /\bnahe\b/i, /\bbaden\b/i, /\bfranken\b/i]
  },
  austria: {
    country: 'Austria',
    regions: [/\bwachau\b/i, /\bkremstal\b/i, /\bkamptal\b/i, /\bburgenland\b/i, /\bsteiermark\b/i, /\bweinviertel\b/i]
  },
  usa: {
    country: 'USA',
    regions: [/\bnapa( valley)?\b/i, /\bsonoma\b/i, /\bwillamette\b/i, /\bcolumbia valley\b/i, /\bwalla walla\b/i, /\bpaso robles\b/i, /\bsanta barbara\b/i, /\bsanta rita\b/i, /\bmendocino\b/i, /\brussian river\b/i, /\boregon\b/i, /\bwashington\b/i, /\bcalifornia\b/i, /\bfinger lakes\b/i, /\bnew york\b/i, /\badelaida\b/i]
  },
  argentina: {
    country: 'Argentina',
    regions: [/\bmendoza\b/i, /\buco valley\b/i, /\bsalta\b/i, /\bpatagonia\b/i, /\bcafayate\b/i]
  },
  chile: {
    country: 'Chile',
    regions: [/\bmaipo\b/i, /\bcolchagua\b/i, /\bcasablanca\b/i, /\baconcagua\b/i, /\bbio[\s-]?bio\b/i, /\bitata\b/i]
  },
  australia: {
    country: 'Australia',
    regions: [/\bbarossa\b/i, /\bmclaren vale\b/i, /\bcoonawarra\b/i, /\bmargaret river\b/i, /\beden valley\b/i, /\bclare valley\b/i, /\byarra valley\b/i, /\bhunter valley\b/i, /\btasmania\b/i]
  },
  nz: {
    country: 'New Zealand',
    regions: [/\bmarlborough\b/i, /\bcentral otago\b/i, /\bhawke'?s bay\b/i, /\bmartinborough\b/i]
  },
  southAfrica: {
    country: 'South Africa',
    regions: [/\bstellenbosch\b/i, /\bswartland\b/i, /\bpaarl\b/i, /\bwalker bay\b/i, /\bhemel-en-aarde\b/i]
  },
  japan: { country: 'Japan', regions: [/\byamanashi\b/i, /\bnagano\b/i, /\bhokkaido\b/i] },
  greece: { country: 'Greece', regions: [/\bsantorini\b/i, /\bnemea\b/i, /\bnaoussa\b/i, /\bmacedonia\b/i] },
  hungary: { country: 'Hungary', regions: [/\btokaj\b/i, /\beger\b/i] },
  lebanon: { country: 'Lebanon', regions: [/\bbekaa\b/i] }
};

const VARIETALS: RegExp[] = [
  /\bchardonnay\b/i,
  /\bsauvignon blanc\b/i,
  /\bpinot noir\b/i,
  /\bpinot gris\b/i,
  /\bpinot grigio\b/i,
  /\bpinot blanc\b/i,
  /\bcabernet sauvignon\b/i,
  /\bcabernet franc\b/i,
  /\bmerlot\b/i,
  /\bmalbec\b/i,
  /\bsyrah\b/i,
  /\bshiraz\b/i,
  /\bgrenache\b/i,
  /\bgarnacha\b/i,
  /\bmourv[eè]dre\b/i,
  /\btempranillo\b/i,
  /\bnebbiolo\b/i,
  /\bsangiovese\b/i,
  /\bbarbera\b/i,
  /\bdolcetto\b/i,
  /\bcorvina\b/i,
  /\briesling\b/i,
  /\bgew[üu]rztraminer\b/i,
  /\bgr[üu]ner veltliner\b/i,
  /\bviognier\b/i,
  /\bch[eé]nin blanc\b/i,
  /\balbari[ñn]o\b/i,
  /\bvermentino\b/i,
  /\bvinho verde\b/i,
  /\bsemillon\b/i,
  /\bs[eé]millon\b/i,
  /\bzinfandel\b/i,
  /\bprimitivo\b/i,
  /\bcarmen[eè]re\b/i,
  /\bpetite sirah\b/i,
  /\bpetit verdot\b/i,
  /\bgamay\b/i,
  /\bnero d'avola\b/i,
  /\baglianico\b/i,
  /\bmontepulciano\b/i,
  /\btouriga\b/i,
  /\bxinomavro\b/i,
  /\bassyrtiko\b/i,
  /\bmoscato\b/i,
  /\bmuscat\b/i,
  /\bglera\b/i,
  /\bfurmint\b/i,
  /\btrousseau\b/i,
  /\bpoulsard\b/i,
  /\bsavagnin\b/i,
  /\bblaufr[äa]nkisch\b/i,
  /\bzweigelt\b/i
];

const STYLE_KEYWORDS: Record<string, RegExp[]> = {
  'full-bodied': [/\bfull[\s-]?bodied\b/i, /\bbold\b/i, /\brich\b/i, /\bpowerful\b/i, /\bstructured\b/i],
  'medium-bodied': [/\bmedium[\s-]?bodied\b/i, /\bmid[\s-]?weight\b/i],
  'light-bodied': [/\blight[\s-]?bodied\b/i, /\bdelicate\b/i, /\bdry\b.*\blight\b/i],
  'sweet': [/\bsweet\b/i, /\boff[\s-]?dry\b/i, /\blate harvest\b/i, /\bdessert\b/i],
  'dry': [/\bdry\b/i, /\bbrut\b/i, /\bextra brut\b/i],
  'crisp': [/\bcrisp\b/i, /\bzesty\b/i, /\bbright\b/i, /\bmineral\b/i, /\bfresh\b/i],
  'fruity': [/\bfruity\b/i, /\bjuicy\b/i, /\bripe fruit\b/i],
  'oaky': [/\boak(?:y|ed)?\b/i, /\bbarrel[\s-]?aged\b/i, /\bvanilla\b/i, /\btoasty\b/i]
};

const VINTAGE_RE = /\b(19[5-9]\d|20[0-4]\d)\b/;
const NV_RE = /\b(NV|MV|N\.V\.)\b/;
const PRICE_TOKEN_RE = /(\$?\d{1,4}(?:\.\d{2})?)/g;
const TRAILING_NUMBERS_RE = /(?:\s+\$?\d{1,4}(?:\.\d{2})?){1,4}\s*$/;
const SECTION_DECORATION_RE = /^[*=\-_~•·]{2,}|[*=\-_~•·]{2,}$/g;

const PURE_DIGIT_LINE_RE = /^[\d\s.,\-#]+$/;
const BIN_PREFIX_RE = /^(?:bin|sku|lot|cellar|item)\s*[#:]?\s*\d+\s*$/i;
const GLUED_VINTAGE_BIN_RE = /\b(19[5-9]\d|20[0-4]\d)(\d{1,4})\b/;

const FOOD_NEGATIVE_RE =
  /\b(salad|sandwich|burger|pizza|pasta|risotto|steak|ribeye|filet|oyster|clam|mussel|shrimp|crab|lobster|tartare|crudo|sashimi|nigiri|caviar|truffle butter|fries|side|dessert|cake|pie|cookie|sorbet|ice cream|sopapilla|enchilada|burrito|taco|fajita|quesadilla|tamale)\b/i;

const FOOD_SECTION_NAMES_RE =
  /\b(entr[eé]e|appetizer|salad|sandwich|side|raw bar|shellfish|sushi|kids?|antojito|combinations?|fajitas?|burritos?|tacos?|quesadillas?|on the grill)\b/i;

// Beer / cider / hard seltzer / cocktail / non-wine beverage indicators.
// Matched whole-word to avoid colliding with wine terms (e.g. "porter" only matches as a standalone word).
const BEVERAGE_NEGATIVE_RE =
  /\b(lager|ale|ales|ipa|i\.p\.a\.|pilsner|pilsener|stout|porter|hefeweizen|witbier|saison|kolsch|k[öo]lsch|amber ale|pale ale|brown ale|wheat beer|wheat ale|mexican lager|light lager|craft beer|draft beer|draught beer|cider|hard cider|hard seltzer|seltzer|cocktail|cocktails|margarita|martini|martinis|negroni|manhattan|old fashioned|mojito|daiquiri|spritz|aperol spritz|highball|sour mix|mule|moscow mule|paloma|caipirinha|gin and tonic|gin & tonic|vodka soda|whiskey sour|whisky sour|bloody mary|piña colada|pina colada|mai tai|tequila shot|rum and coke|jack and coke|bourbon|whiskey|whisky|tequila|mezcal|vodka|gin|rum|cognac|armagnac|grappa|absinthe|amaro|amari|aperitif|digestif|liqueur|schnapps|brandy|coors|corona|budweiser|bud light|miller lite|michelob|heineken|stella artois|guinness|modelo|pacifico|pacifico clara|dos equis|tecate|sapporo|asahi|kirin|tsingtao|peroni|moretti|amstel|carlsberg|pilsner urquell|spaten|paulaner|warsteiner|becks|hofbrau|grolsch|leffe|chimay|duvel|hoegaarden)\b/i;

const NOISE_LINE_RE =
  /^(?:page \d+|continued|see reverse|all prices.*|prices subject.*|tax.*included|gratuity.*|menu \d+|wine list \d+|served by the (glass|bottle))$/i;

const STATE_ABBR_RE = /^(?:AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY)$/;
const STATE_ABBR_INLINE = `(?:AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY)`;

// Geo-only fragment generic words: standalone tokens like "Coast, CA", "Valley, OR",
// "Mountain, OR", "Hills, CA", or "<Word> <Word>, <STATE>" with no real producer/varietal.
const GEO_GENERIC_WORDS_RE =
  /\b(coast|valley|hills?|mountain|mountains|county|district|peninsula|ridge|river|highlands?|lowlands?|plateau|basin|appellation|region|area)\b/i;

// Matches lines that are *only* a geographic fragment ending in a US state abbrev
// (e.g. "Coast, CA", "Valley, OR", "Cooper Mountain, Valley, OR", "Russian River, CA").
// Used together with absence of vintage/price/varietal/producer signals.
const GEO_ONLY_FRAGMENT_RE = new RegExp(
  `^[A-Za-z][A-Za-z\\s'’\\-\\.]{0,60},\\s*${STATE_ABBR_INLINE}\\.?$`
);
const GEO_ONLY_MULTI_FRAGMENT_RE = new RegExp(
  `^[A-Za-z][A-Za-z\\s'’\\-\\.]{0,80},\\s*[A-Za-z][A-Za-z\\s'’\\-\\.]{0,40},\\s*${STATE_ABBR_INLINE}\\.?$`
);

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

function classifySection(name: string): { category: string; canonical: string } | null {
  const trimmed = name.replace(SECTION_DECORATION_RE, '').trim();
  for (const entry of SECTION_CANONICAL) {
    for (const re of entry.patterns) {
      if (re.test(trimmed)) {
        return { category: entry.category, canonical: trimmed };
      }
    }
  }
  return null;
}

function looksLikeWineSectionHeader(line: string): boolean {
  if (line.length > 60) return false;
  if (FOOD_SECTION_NAMES_RE.test(line)) return false;
  if (VINTAGE_RE.test(line)) return false;
  if (NV_RE.test(line)) return false;
  if (/,/.test(line)) return false;
  if (/\$\d/.test(line)) return false;
  const tokens = line.trim().split(/\s+/);
  if (tokens.length > 5) return false;
  const trailing = extractTrailingPrices(line);
  if (trailing.prices.length > 0) return false;
  const lettersOnly = line.replace(/[^A-Za-z]/g, '');
  if (lettersOnly.length < 3) return false;
  return classifySection(line) !== null;
}

function detectVintage(text: string): { vintage: number | null; cleaned: string } {
  const nvMatch = text.match(NV_RE);
  if (nvMatch) {
    return { vintage: null, cleaned: text.replace(NV_RE, '').replace(/\s{2,}/g, ' ').trim() };
  }
  const m = text.match(VINTAGE_RE);
  if (m) {
    const year = parseInt(m[1], 10);
    const cleaned = text.replace(VINTAGE_RE, '').replace(/\s{2,}/g, ' ').trim();
    return { vintage: year, cleaned };
  }
  return { vintage: null, cleaned: text };
}

function detectVarietal(text: string): string | undefined {
  for (const re of VARIETALS) {
    const m = text.match(re);
    if (m) return m[0].toLowerCase();
  }
  return undefined;
}

function detectRegionAndCountry(text: string): { region?: string; country?: string } {
  for (const key of Object.keys(COUNTRY_REGIONS)) {
    const { country, regions } = COUNTRY_REGIONS[key];
    for (const re of regions) {
      const m = text.match(re);
      if (m) {
        const region = m[0].replace(/\s+/g, ' ').trim();
        return { region, country };
      }
    }
  }
  return {};
}

function detectStyle(text: string): { style?: string; body?: string; tags: string[] } {
  const tags: string[] = [];
  let style: string | undefined;
  let body: string | undefined;
  for (const key of Object.keys(STYLE_KEYWORDS)) {
    for (const re of STYLE_KEYWORDS[key]) {
      if (re.test(text)) {
        tags.push(key);
        if (key.endsWith('-bodied')) {
          body = body ?? key;
        } else if (!style) {
          style = key;
        }
        break;
      }
    }
  }
  return { style, body, tags };
}

function isVintageToken(token: string): boolean {
  const m = token.match(/^(\d{4})$/);
  if (!m) return false;
  const y = parseInt(m[1], 10);
  return y >= 1950 && y <= 2049;
}

function splitGluedVintageBin(line: string): { line: string; bin?: string } {
  const m = line.match(GLUED_VINTAGE_BIN_RE);
  if (!m) return { line };
  const year = parseInt(m[1], 10);
  if (year < 1950 || year > 2049) return { line };
  const tail = m[2];
  if (!/^\d{1,4}$/.test(tail)) return { line };
  const replaced = line.replace(GLUED_VINTAGE_BIN_RE, `$1 $2`);
  return { line: replaced, bin: tail };
}

function extractTrailingBin(line: string): { name: string; bin?: string } {
  const tokens = line.split(/\s+/);
  if (tokens.length === 0) return { name: line };
  const last = tokens[tokens.length - 1];
  if (isVintageToken(last)) return { name: line };
  if (/^\$?\d{1,4}(?:\.\d{2})?$/.test(last)) return { name: line };
  if (/^\d{3,7}$/.test(last)) {
    tokens.pop();
    return { name: tokens.join(' ').trim(), bin: last };
  }
  return { name: line };
}

function extractTrailingPrices(line: string): { name: string; prices: number[] } {
  const tokens = line.split(/\s+/);
  const prices: number[] = [];
  while (tokens.length > 0) {
    const last = tokens[tokens.length - 1];
    if (isVintageToken(last)) break;
    const m = last.match(/^\$?(\d{1,4}(?:\.\d{2})?)$/);
    if (m) {
      const n = Number(m[1]);
      if (Number.isFinite(n) && n > 0 && n < 100000) {
        prices.unshift(n);
        tokens.pop();
        continue;
      }
    }
    break;
  }
  return { name: tokens.join(' ').trim(), prices };
}

function isLikelyBinOrNoiseLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return true;
  if (PURE_DIGIT_LINE_RE.test(trimmed)) return true;
  if (BIN_PREFIX_RE.test(trimmed)) return true;
  if (NOISE_LINE_RE.test(trimmed)) return true;
  const letters = trimmed.replace(/[^A-Za-z]/g, '');
  if (letters.length < 3) return true;
  return false;
}

function hasMeaningfulProducerText(text: string): boolean {
  const stripped = text.replace(/[\d$.,;:#%/\\()\-]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!stripped) return false;
  const tokens = stripped.split(/\s+/);
  let alphaWords = 0;
  for (const tok of tokens) {
    if (/^[A-Za-z][A-Za-z'’`\-]*$/.test(tok)) {
      if (tok.length >= 3 && !STATE_ABBR_RE.test(tok.toUpperCase())) {
        alphaWords++;
      }
    }
  }
  return alphaWords >= 1;
}

function isBeverageNonWineLine(line: string): boolean {
  // Reject obvious beer / cider / hard seltzer / cocktail / spirit rows.
  // Skip if we already detect a wine varietal — varietals win over false positives.
  if (detectVarietal(line)) return false;
  return BEVERAGE_NEGATIVE_RE.test(line);
}

function stripPricesAndVintageForGeoCheck(line: string): string {
  let s = line;
  const deglued = splitGluedVintageBin(s);
  s = deglued.line;
  const binStripped = extractTrailingBin(s);
  s = binStripped.name;
  const priceStripped = extractTrailingPrices(s);
  s = priceStripped.name;
  s = s.replace(VINTAGE_RE, '').replace(NV_RE, '').replace(/\s{2,}/g, ' ').trim();
  s = s.replace(/[,;]+$/g, '').trim();
  return s;
}

function isGeoOnlyFragment(line: string): boolean {
  // Decide if a line is *only* a geographic fragment (no producer, no wine name).
  // We strip vintage/price/bin first, then test against geo-fragment shapes.
  const stripped = stripPricesAndVintageForGeoCheck(line);
  if (!stripped) return false;
  if (detectVarietal(stripped)) return false;

  const parts = stripped.split(/\s*,\s*/).map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return false;

  // Last token a US state abbreviation? Then all earlier tokens must look geo-generic
  // (e.g. "Coast", "Valley", "Hills", "Cooper Mountain") or be known wine regions.
  const lastIsState = STATE_ABBR_RE.test(parts[parts.length - 1].toUpperCase().replace(/\.$/, ''));
  if (lastIsState) {
    const earlier = parts.slice(0, -1);
    if (earlier.length === 0) return true; // bare state
    // Every earlier part is either a generic geo word, a known wine region, or a single short token.
    const allGeoGeneric = earlier.every((p) => {
      const lower = p.toLowerCase();
      if (GEO_GENERIC_WORDS_RE.test(lower)) return true;
      const detected = detectRegionAndCountry(p);
      if (detected.region || detected.country) return true;
      // Reject if it contains apparent producer words (more than 1 capitalized word that isn't a geo word).
      return false;
    });
    if (allGeoGeneric) return true;
  }

  if (GEO_ONLY_FRAGMENT_RE.test(stripped)) {
    const head = parts[0].toLowerCase();
    if (GEO_GENERIC_WORDS_RE.test(head)) return true;
    const detected = detectRegionAndCountry(parts[0]);
    if (detected.region || detected.country) return true;
  }
  if (GEO_ONLY_MULTI_FRAGMENT_RE.test(stripped)) {
    // e.g. "Cooper Mountain, Valley, OR" — head is generic mountain/valley, middle is generic.
    const head = parts[0].toLowerCase();
    const mid = parts[1].toLowerCase();
    if (GEO_GENERIC_WORDS_RE.test(head) || GEO_GENERIC_WORDS_RE.test(mid)) return true;
    if (GEO_GENERIC_WORDS_RE.test(head) && GEO_GENERIC_WORDS_RE.test(mid)) return true;
  }

  return false;
}

function looksLikeWineEntry(line: string): boolean {
  if (!line || line.length < 4) return false;
  if (FOOD_NEGATIVE_RE.test(line)) return false;
  if (isBeverageNonWineLine(line)) return false;
  if (/^\(/.test(line)) return false;
  if (isLikelyBinOrNoiseLine(line)) return false;
  if (isGeoOnlyFragment(line)) return false;
  const hasUpper = /[A-Z]/.test(line);
  if (!hasUpper) return false;

  const { line: deglued } = splitGluedVintageBin(line);
  const { name: noBin } = extractTrailingBin(deglued);
  const stripped = extractTrailingPrices(noBin);
  let candidate = stripped.name;
  const vintageInfo = detectVintage(candidate);
  candidate = vintageInfo.cleaned;

  const hasVintage = VINTAGE_RE.test(line) || NV_RE.test(line);
  const { prices } = extractTrailingPrices(deglued);
  const hasPrice = prices.length > 0;
  const hasVarietal = detectVarietal(line) !== undefined;
  const { region, country } = detectRegionAndCountry(line);
  const hasGeo = Boolean(country);

  if (!hasMeaningfulProducerText(candidate)) {
    return false;
  }

  const evidenceCount =
    (hasVintage ? 1 : 0) +
    (hasPrice ? 1 : 0) +
    (hasVarietal ? 1 : 0) +
    (hasGeo ? 1 : 0);

  if (evidenceCount === 0) return false;

  if (hasGeo && !hasVintage && !hasPrice && !hasVarietal) {
    let textAfterGeo = candidate;
    if (region) {
      textAfterGeo = textAfterGeo.replace(
        new RegExp(`\\b${region.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i'),
        ''
      );
    }
    if (country) {
      textAfterGeo = textAfterGeo.replace(
        new RegExp(`\\b${country.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i'),
        ''
      );
    }
    if (!hasMeaningfulProducerText(textAfterGeo)) return false;
  }

  return true;
}

function splitProducerName(text: string): { producer?: string; name: string } {
  const cleanedText = text.replace(/\s{2,}/g, ' ').trim();
  const commaParts = cleanedText.split(/\s*,\s*/);
  if (commaParts.length >= 2) {
    const producer = commaParts[0].trim();
    const rest = commaParts.slice(1).join(', ').trim();
    if (producer && rest && producer.length <= 60) {
      return { producer, name: rest };
    }
  }
  const dashSplit = cleanedText.split(/\s+[-–—]\s+/);
  if (dashSplit.length >= 2) {
    return { producer: dashSplit[0].trim(), name: dashSplit.slice(1).join(' - ').trim() };
  }
  return { name: cleanedText };
}

function buildWineEntry(
  rawLine: string,
  section: string,
  category: string,
  index: number
): WineEntry | null {
  let working = rawLine.trim();

  const deglued = splitGluedVintageBin(working);
  working = deglued.line;
  let bin = deglued.bin;

  const binStripped = extractTrailingBin(working);
  if (binStripped.bin) {
    working = binStripped.name;
    bin = bin ?? binStripped.bin;
  }

  const stripped = extractTrailingPrices(working);
  const prices = stripped.prices;
  if (prices.length > 0) {
    working = stripped.name;
  }

  const vintageResult = detectVintage(working);
  working = vintageResult.cleaned;

  const region = detectRegionAndCountry(working);
  let textForName = working;
  if (region.region) {
    textForName = textForName.replace(new RegExp(`\\b${region.region.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i'), '').trim();
  }
  if (region.country) {
    textForName = textForName.replace(new RegExp(`\\b${region.country.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i'), '').trim();
  }
  textForName = textForName
    .replace(/,\s*,/g, ',')
    .replace(/\s{2,}/g, ' ')
    .replace(/[,;\s]+$/g, '')
    .replace(/^[,;\s]+/g, '')
    .trim();

  const varietal = detectVarietal(rawLine);
  const styleInfo = detectStyle(rawLine);

  if (!textForName) {
    textForName = rawLine.replace(TRAILING_NUMBERS_RE, '').trim();
  }

  const { producer, name } = splitProducerName(textForName);
  if (!name || name.length < 2) return null;
  if (!hasMeaningfulProducerText(`${producer ?? ''} ${name}`)) return null;
  if (/^\d+$/.test(name.replace(/\s+/g, ''))) return null;

  const id = slugify(`${section}-${name}-${vintageResult.vintage ?? 'nv'}`) || `wine-${index + 1}`;

  let glassPrice: number | null | undefined;
  let bottlePrice: number | null | undefined;
  let priceTiers: { label?: string; price: number }[] | undefined;
  let primaryPrice: number | null | undefined;

  if (prices.length === 1) {
    primaryPrice = prices[0];
    if (primaryPrice < 40) {
      glassPrice = primaryPrice;
    } else {
      bottlePrice = primaryPrice;
    }
  } else if (prices.length === 2) {
    const [a, b] = prices;
    glassPrice = Math.min(a, b);
    bottlePrice = Math.max(a, b);
    primaryPrice = bottlePrice;
    priceTiers = [
      { label: 'glass', price: glassPrice },
      { label: 'bottle', price: bottlePrice }
    ];
  } else if (prices.length >= 3) {
    priceTiers = prices.map((p) => ({ price: p }));
    primaryPrice = prices[prices.length - 1];
    bottlePrice = primaryPrice;
  }

  const tags: string[] = [category, ...styleInfo.tags];
  if (varietal) tags.push(varietal);
  if (region.country) tags.push(region.country.toLowerCase());

  const entry: WineEntry = {
    id,
    name,
    section,
    category,
    tags: Array.from(new Set(tags)).filter(Boolean)
  };
  if (producer) entry.producer = producer;
  if (varietal) entry.varietal = varietal;
  if (region.region) entry.region = region.region;
  if (region.country) entry.country = region.country;
  entry.vintage = vintageResult.vintage;
  if (primaryPrice !== undefined) entry.price = primaryPrice;
  if (glassPrice !== undefined) entry.glassPrice = glassPrice;
  if (bottlePrice !== undefined) entry.bottlePrice = bottlePrice;
  if (priceTiers) entry.priceTiers = priceTiers;
  if (styleInfo.style) entry.style = styleInfo.style;
  if (styleInfo.body) entry.body = styleInfo.body;
  if (bin) entry.binNumber = bin;

  return entry;
}

export function parseWineText(text: string, sourceFile: string): ParsedWineList {
  const lines = normalizeLines(text);
  const sections: ParsedWineSection[] = [];
  let current: ParsedWineSection = {
    section: 'WINE LIST',
    category: 'wine',
    items: []
  };
  let lastEntry: WineEntry | null = null;

  function flush() {
    if (current.items.length > 0) {
      const existing = sections.find(
        (s) => s.section.toUpperCase() === current.section.toUpperCase()
      );
      if (existing) {
        existing.items.push(...current.items);
      } else {
        sections.push(current);
      }
    }
  }

  for (const rawLine of lines) {
    const line = rawLine.replace(SECTION_DECORATION_RE, '').trim();
    if (!line) continue;

    if (looksLikeWineSectionHeader(line)) {
      const cls = classifySection(line)!;
      flush();
      current = { section: cls.canonical, category: cls.category, items: [] };
      lastEntry = null;
      continue;
    }

    if (isLikelyBinOrNoiseLine(line)) {
      if (lastEntry && !lastEntry.binNumber) {
        const m = line.match(/^\d{3,7}$/);
        if (m) lastEntry.binNumber = m[0];
      }
      continue;
    }

    if (looksLikeWineEntry(line)) {
      const entry = buildWineEntry(line, current.section, current.category, current.items.length);
      if (entry) {
        current.items.push(entry);
        lastEntry = entry;
        continue;
      }
    }

    if (lastEntry && /[a-z]/.test(line) && !classifySection(line)) {
      const region = detectRegionAndCountry(line);
      if (region.region && !lastEntry.region) lastEntry.region = region.region;
      if (region.country && !lastEntry.country) lastEntry.country = region.country;
      const varietal = detectVarietal(line);
      if (varietal && !lastEntry.varietal) lastEntry.varietal = varietal;
      const styleInfo = detectStyle(line);
      if (styleInfo.style && !lastEntry.style) lastEntry.style = styleInfo.style;
      if (styleInfo.body && !lastEntry.body) lastEntry.body = styleInfo.body;
      for (const t of styleInfo.tags) {
        if (!lastEntry.tags.includes(t)) lastEntry.tags.push(t);
      }
      lastEntry.notes = lastEntry.notes ? `${lastEntry.notes} ${line}`.trim() : line;
    }
  }

  flush();

  for (const sec of sections) {
    const seen = new Set<string>();
    sec.items = sec.items.filter((it) => {
      const sig = `${(it.producer ?? '').toLowerCase()}|${it.name.toLowerCase()}|${it.vintage ?? ''}`;
      if (seen.has(sig)) return false;
      seen.add(sig);
      return true;
    });
  }

  return {
    sourceFile,
    extractedAt: new Date().toISOString(),
    sections
  };
}

export function toWineEntries(parsed: ParsedWineList): WineEntry[] {
  const out: WineEntry[] = [];
  for (const section of parsed.sections) {
    for (const item of section.items) {
      out.push(item);
    }
  }
  return out;
}

export function filterFoodNoise(entries: WineEntry[]): WineEntry[] {
  const seen = new Set<string>();
  return entries.filter((e) => {
    const blob = `${e.producer ?? ''} ${e.name} ${e.notes ?? ''}`;
    if (FOOD_NEGATIVE_RE.test(blob)) return false;
    if (isBeverageNonWineLine(blob)) return false;
    if (!e.name || e.name.length < 2) return false;
    if (/^\d+$/.test(e.name.replace(/\s+/g, ''))) return false;
    const letters = e.name.replace(/[^A-Za-z]/g, '');
    if (letters.length < 3) return false;
    // Drop entries whose entire identity is a geo-only fragment (e.g. "Coast, CA").
    const identity = `${e.producer ?? ''}, ${e.name}`.replace(/^,\s*/, '');
    if (isGeoOnlyFragment(identity)) return false;
    // De-duplicate identical fragment entries across sections.
    const sig = `${(e.producer ?? '').toLowerCase().trim()}|${e.name.toLowerCase().trim()}|${e.vintage ?? ''}|${e.region ?? ''}|${e.country ?? ''}`;
    if (seen.has(sig)) return false;
    seen.add(sig);
    return true;
  });
}
