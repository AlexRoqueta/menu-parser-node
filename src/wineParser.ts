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

// OCR/PDF text extraction commonly glues a leading 3-4 digit bin/SKU directly to
// the producer name with no whitespace (e.g. "200La Caña Albariño...",
// "1006Nicolas Feuillatte..."). Split when the digits are followed by a capital
// letter. The leading digits must look like a plausible bin, not a year.
const LEADING_BIN_GLUE_RE = /^(\d{3,4})([A-ZÀ-Þ])/;

// NV / MV / N.V. glued directly to a glass price (e.g. "NV13.5", "NV27.5", "MV99").
const NV_PRICE_GLUE_RE = /\b(NV|MV|N\.V\.)(\d{1,4}(?:\.\d{1,2})?)\b/g;

// Decorative section heading: anything wrapped/prefixed/suffixed by colon
// pairs, bullets, equals, tildes, ornament punctuation (e.g. `:: SPARKLING ::`,
// `=== RED WINE ===`, `* CHARDONNAY *`). The wrapping marks the whole line as
// a decorative heading regardless of its inner text.
const DECORATIVE_WRAPPED_HEADING_RE =
  /^[\s]*(?:::|=={1,}|~{2,}|\*{2,}|-{2,}|_{2,}|•{1,}|·{1,})\s*.+?\s*(?:::|=={1,}|~{2,}|\*{2,}|-{2,}|_{2,}|•{1,}|·{1,})[\s]*$/;
// Leading-only decorative prefix like `:: SPARKLING WINE` or `== RED WINE` with
// no closing pair — still a heading.
const DECORATIVE_PREFIX_HEADING_RE =
  /^[\s]*(?:::|=={1,}|~{2,}|\*{2,}|•|·)\s*[A-Za-z][^:]{0,80}$/;
// Trailing-only decorative suffix like `SPARKLING WINE ::` or `RED ==`.
const DECORATIVE_SUFFIX_HEADING_RE =
  /^[\s]*[A-Za-z][^:]{0,80}\s*(?:::|=={1,}|~{2,}|\*{2,}|•|·)[\s]*$/;

// "(cont'd)" or "(continued)" continuation markers — these are always section
// continuations, never wine entries.
const CONTINUATION_MARKER_RE = /\(\s*(?:cont(?:'d|inued|d)?\.?|cont\.?)\s*\)/i;

// All-caps section-style heading: 2+ words where most letters are uppercase,
// no digits, short length, no commas. Catches things like `SPARKLING WINE`,
// `CABERNET SAUVIGNON`, `PINOT GRIGIO & PINOT GRIS`, `SOUTHERN & NEW WORLD
// RHÔNE`. We use it together with absence of bottle evidence.
function isAllCapsSectionHeading(line: string): boolean {
  const trimmed = line.trim().replace(/[.,;:]+$/g, '');
  if (!trimmed) return false;
  if (trimmed.length > 70) return false;
  // No vintage / NV / $ / digits make this look like a heading rather than a
  // wine row.
  if (VINTAGE_RE.test(trimmed)) return false;
  if (NV_RE.test(trimmed)) return false;
  if (/\$\d/.test(trimmed)) return false;
  if (/\d/.test(trimmed)) return false;
  // Strip ornament chars to evaluate the inner text.
  const inner = trimmed.replace(/[:=~*\-_•·]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!inner) return false;
  const letters = inner.replace(/[^A-Za-zÀ-ÿ]/g, '');
  if (letters.length < 3) return false;
  const upperLetters = inner.replace(/[^A-ZÀ-Þ]/g, '');
  // 90%+ of letters must be uppercase for an all-caps heading.
  const upperRatio = upperLetters.length / Math.max(letters.length, 1);
  if (upperRatio < 0.9) return false;
  // No comma → looks like a section heading, not a wine row.
  if (/,/.test(inner)) return false;
  return true;
}

// Varietal/category-only heading: line is purely a varietal name (e.g.
// `CABERNET SAUVIGNON`, `Chardonnay`, `Pinot Grigio & Pinot Gris`, `Syrah &
// Shiraz`) optionally followed by `(cont'd)` and decorative wrappers — no
// producer, no vintage, no price.
const CATEGORY_LIKE_WORDS_RE =
  /^(?:sparkling|champagne|ros[ée]|orange|white|red|dessert|fortified|sake|wine|wines|by the (?:glass|bottle))(?:\s+(?:wine|wines))?$/i;

function stripDecorationAndContinuation(line: string): string {
  let s = line.trim();
  // Strip decorative wrappers from start/end.
  s = s.replace(/^[\s:=~*_\-•·]+/, '').replace(/[\s:=~*_\-•·]+$/, '').trim();
  // Strip continuation markers.
  s = s.replace(CONTINUATION_MARKER_RE, '').replace(/\s{2,}/g, ' ').trim();
  // Strip dangling punctuation.
  s = s.replace(/[.,;:]+$/g, '').trim();
  return s;
}

function isVarietalOrCategoryOnlyHeading(line: string): boolean {
  const stripped = stripDecorationAndContinuation(line);
  if (!stripped) return false;
  if (VINTAGE_RE.test(stripped)) return false;
  if (NV_RE.test(stripped)) return false;
  if (/\$\d/.test(stripped)) return false;
  if (/\d/.test(stripped)) return false;
  if (/,/.test(stripped)) return false;
  if (CATEGORY_LIKE_WORDS_RE.test(stripped)) return true;
  // Split on `&`/`/`/`+`/`and` — every part must match a known varietal.
  const parts = stripped
    .split(/\s*(?:&|\/|\+|\band\b)\s*/i)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return false;
  const allVarietal = parts.every((p) => {
    // p must match a varietal pattern AND nothing else (no extra producer
    // words). To check that, after detecting the varietal, the remainder must
    // be empty or only ornament chars.
    for (const re of VARIETALS) {
      const m = p.match(re);
      if (m && p.replace(re, '').replace(/[\s:=~*_\-•·]+/g, '').trim() === '') {
        return true;
      }
    }
    // Also accept the bare category words on their own
    if (CATEGORY_LIKE_WORDS_RE.test(p)) return true;
    return false;
  });
  return allVarietal;
}

// Tests for explicit decorative section markers like `:: SPARKLING ::`,
// `:: COCKTAILS ::`, `:: BARTENDER'S SPECIAL ::`. Used by the section-mode
// gate to decide whether we are currently inside a wine section or a
// non-wine section (cocktails / spirits / beer / etc.).
const DECORATIVE_MARKER_RE = /::|=={2,}|~{2,}|\*{2,}/;

function extractDecorativeHeadingText(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  if (!DECORATIVE_MARKER_RE.test(trimmed)) return null;
  if (!DECORATIVE_WRAPPED_HEADING_RE.test(trimmed) &&
      !DECORATIVE_PREFIX_HEADING_RE.test(trimmed) &&
      !DECORATIVE_SUFFIX_HEADING_RE.test(trimmed)) {
    return null;
  }
  // Reject lines that are actual wine rows (they have vintage / NV / price).
  if (VINTAGE_RE.test(trimmed) || NV_RE.test(trimmed) || /\$\d/.test(trimmed)) return null;
  const inner = stripDecorationAndContinuation(trimmed);
  return inner || null;
}

// Patterns indicating a non-wine section heading. Matched against the inner
// text of a `:: ... ::` marker. Covers cocktails, spirit-free, beer/draughts,
// and the spirits portion of the list (whiskey/whisky/bourbon/rye/scotch/
// brandy/tequila/mezcal/rum/gin/vodka/cognac/spirits).
const NON_WINE_SECTION_RE =
  /\b(spirit\s*free|spirit[\s-]?free|cocktails?|bartender'?s\s+special|draughts?|drafts?|on\s+tap|beers?|cans?\s+(?:and|&)\s+bottles?|cans?|bottles?\s+(?:and|&)\s+cans?|hard\s+seltzers?|seltzers?|ciders?|spirits?|whiskeys?|whiskys?|bourbons?|ryes?|scotch(?:es)?|single\s+malt|blended\s+scotch|japanese\s+whisk(?:e)?y|brand(?:y|ies)|cognacs?|tequilas?|mezcals?|rums?|gins?|vodkas?|aperitifs?|digestifs?|liqueurs?|amari|amaro)\b/i;

// Patterns indicating a wine section heading. Covers explicit wine words and
// well-known wine categories / varietals / regions used as headings on this
// kind of menu.
const WINE_SECTION_RE =
  /\b(wines?\s+by\s+the\s+(?:glass|bottle)|wines?|sparkling|champagne|ros[ée]|whites?|reds?|dessert\s+wines?|fortified|sake|cabernet|merlot|malbec|pinot|chardonnay|sauvignon|riesling|syrah|shiraz|rh[ôo]ne|bordeaux|burgundy|bourgogne|italy|spain|portugal|france|germany|austria|argentina|chile|new\s+zealand|orange|adventure\s+in\s+(?:white|red)\s+wine|bold\s+reds)\b/i;

type SectionMode = 'wine' | 'non-wine' | 'unknown';

function classifyDecorativeSectionMode(inner: string): SectionMode {
  const cleaned = inner.replace(/[(].*[)]/g, '').trim();
  if (NON_WINE_SECTION_RE.test(cleaned)) {
    // Wine words can appear inside non-wine headings rarely, but the
    // non-wine pattern is more specific — prefer non-wine when both match.
    return 'non-wine';
  }
  if (WINE_SECTION_RE.test(cleaned)) return 'wine';
  return 'unknown';
}

// Pre-line normalization: strip leading bin/SKU glued to producer name and
// un-glue NV<price> tokens (e.g. "NV13.5" → "NV 13.5"). Both are common
// OCR/PDF text-extraction artifacts. Always inserts whitespace so the
// per-line bin extractor in buildWineEntry decides later whether the leading
// run is a true bin or an actual vintage.
function preprocessWineLine(line: string): string {
  let s = line;
  s = s.replace(NV_PRICE_GLUE_RE, (_m, marker, price) => `${marker} ${price}`);
  s = s.replace(LEADING_BIN_GLUE_RE, '$1 $2');
  return s;
}

function isDecorativeSectionHeading(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (DECORATIVE_WRAPPED_HEADING_RE.test(trimmed)) return true;
  // Prefix or suffix-only ornament with no vintage/price (so it's not a real
  // wine row with stray punctuation).
  const stripped = stripDecorationAndContinuation(trimmed);
  if (DECORATIVE_PREFIX_HEADING_RE.test(trimmed) || DECORATIVE_SUFFIX_HEADING_RE.test(trimmed)) {
    if (!VINTAGE_RE.test(trimmed) && !NV_RE.test(trimmed) && !/\$\d/.test(trimmed)) {
      // If after stripping the ornament the residue is empty, a category,
      // a varietal, or an all-caps section name → heading.
      if (!stripped) return true;
      if (isVarietalOrCategoryOnlyHeading(stripped)) return true;
      if (isAllCapsSectionHeading(stripped)) return true;
    }
  }
  return false;
}

// Quote-prefixed vineyard/appellation fragment without bottle evidence — e.g.
// `'Blanchots' Grand Cru`, `'Les Clos' Grand Cru`, `'Russian River Valley, CA`,
// `'Charles Heintz Vineyard', Coast, CA`. Always wraps with a leading quote
// (straight or curly) followed by a capitalized name.
const QUOTE_PREFIX_RE = /^[\s]*[‘'`"]\s*[A-ZÀ-Þ]/;

function isQuotePrefixedFragmentLine(line: string): boolean {
  return QUOTE_PREFIX_RE.test(line);
}

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

// Known appellation / region heading patterns that frequently appear as bare
// section sub-headings on wine lists. When a line is *only* one of these (after
// stripping prices/vintage/bin), reject it as a wine record — it carries no
// producer or bottle info on its own.
const APPELLATION_HEADING_RE: RegExp[] = [
  // France — Bordeaux subregions and right-bank appellations
  /^saint[\s.\-]?[ée]milion(?:\s+grand\s+cru(?:\s+class[ée])?)?$/i,
  /^st[\s.\-]?[ée]milion(?:\s+grand\s+cru(?:\s+class[ée])?)?$/i,
  /^saint[\s.\-]?est[èe]phe$/i,
  /^st[\s.\-]?est[èe]phe$/i,
  /^saint[\s.\-]?julien$/i,
  /^st[\s.\-]?julien$/i,
  /^pauillac$/i,
  /^margaux$/i,
  /^pomerol$/i,
  /^p[ée]ssac[\s-]?l[ée]ognan$/i,
  /^graves$/i,
  /^haut[\s-]?m[ée]doc$/i,
  /^m[ée]doc$/i,
  /^sauternes$/i,
  /^barsac$/i,
  // France — Burgundy / Bourgogne villages
  /^chassagne[\s-]?montrachet$/i,
  /^puligny[\s-]?montrachet$/i,
  /^meursault$/i,
  /^pommard$/i,
  /^volnay$/i,
  /^gevrey[\s-]?chambertin$/i,
  /^vosne[\s-]?roman[ée]e$/i,
  /^nuits[\s-]?saint[\s-]?georges$/i,
  /^chambolle[\s-]?musigny$/i,
  /^morey[\s-]?saint[\s-]?denis$/i,
  /^aloxe[\s-]?corton$/i,
  /^savigny[\s-]?l[èe]s[\s-]?beaune$/i,
  /^beaune$/i,
  /^chablis(?:\s+(?:premier|grand)\s+cru)?$/i,
  /^mâcon(?:[\s-]?villages)?$/i,
  /^macon(?:[\s-]?villages)?$/i,
  /^pouilly[\s-]?fuiss[ée]$/i,
  // France — Rhône
  /^ch[âa]teauneuf[\s-]?du[\s-]?pape$/i,
  /^c[ôo]te[\s-]?r[ôo]tie$/i,
  /^hermitage$/i,
  /^crozes[\s-]?hermitage$/i,
  /^cornas$/i,
  /^saint[\s.\-]?joseph$/i,
  /^st[\s.\-]?joseph$/i,
  /^condrieu$/i,
  /^gigondas$/i,
  /^vacqueyras$/i,
  /^c[ôo]tes[\s-]?du[\s-]?rh[ôo]ne$/i,
  // France — Loire / Alsace / Champagne / Beaujolais
  /^sancerre$/i,
  /^pouilly[\s-]?fum[ée]$/i,
  /^vouvray$/i,
  /^chinon$/i,
  /^muscadet(?:[\s-]s[èe]vre[\s-]?et[\s-]?maine)?$/i,
  /^savenni[èe]res$/i,
  /^alsace$/i,
  /^champagne$/i,
  /^beaujolais(?:[\s-]?villages)?$/i,
  /^morgon$/i,
  /^fleurie$/i,
  /^moulin[\s-]?[àa][\s-]?vent$/i,
  // Italy
  /^barolo$/i,
  /^barbaresco$/i,
  /^brunello(?:\s+di\s+montalcino)?$/i,
  /^chianti(?:\s+classico(?:\s+riserva)?)?$/i,
  /^vino\s+nobile(?:\s+di\s+montepulciano)?$/i,
  /^amarone(?:\s+della\s+valpolicella)?$/i,
  /^valpolicella(?:\s+(?:classico|ripasso|superiore))?$/i,
  /^soave(?:\s+classico)?$/i,
  /^etna(?:\s+(?:rosso|bianco))?$/i,
  // Spain / Portugal
  /^rioja(?:\s+(?:reserva|gran\s+reserva|crianza))?$/i,
  /^ribera\s+del\s+duero$/i,
  /^priorat$/i,
  /^r[ií]as\s+baixas$/i,
  /^douro$/i,
  /^vinho\s+verde$/i,
  // Germany / Austria
  /^mosel$/i,
  /^rheingau$/i,
  /^wachau$/i,
  // USA — AVAs commonly used as headings on wine lists
  /^russian\s+river(?:\s+valley)?(?:,\s*ca)?$/i,
  /^rutherford(?:,\s*ca)?$/i,
  /^oakville(?:,\s*ca)?$/i,
  /^stags?\s+leap(?:\s+district)?(?:,\s*ca)?$/i,
  /^howell\s+mountain(?:,\s*ca)?$/i,
  /^spring\s+mountain(?:,\s*ca)?$/i,
  /^mount\s+veeder(?:,\s*ca)?$/i,
  /^diamond\s+mountain(?:,\s*ca)?$/i,
  /^calistoga(?:,\s*ca)?$/i,
  /^st\.?\s*helena(?:,\s*ca)?$/i,
  /^yountville(?:,\s*ca)?$/i,
  /^carneros(?:,\s*ca)?$/i,
  /^anderson\s+valley(?:,\s*ca)?$/i,
  /^dry\s+creek(?:\s+valley)?(?:,\s*ca)?$/i,
  /^alexander\s+valley(?:,\s*ca)?$/i,
  /^knights\s+valley(?:,\s*ca)?$/i,
  /^chalk\s+hill(?:,\s*ca)?$/i,
  /^fort\s+ross[\s-]?seaview(?:,\s*ca)?$/i,
  /^sonoma\s+coast(?:,\s*ca)?$/i,
  /^sonoma\s+valley(?:,\s*ca)?$/i,
  /^green\s+valley(?:\s+of\s+russian\s+river)?(?:,\s*ca)?$/i,
  /^sta\.?\s*rita\s+hills(?:,\s*ca)?$/i,
  /^santa\s+rita\s+hills(?:,\s*ca)?$/i,
  /^santa\s+lucia\s+highlands(?:,\s*ca)?$/i,
  /^santa\s+barbara(?:\s+county)?(?:,\s*ca)?$/i,
  /^santa\s+maria\s+valley(?:,\s*ca)?$/i,
  /^santa\s+ynez(?:\s+valley)?(?:,\s*ca)?$/i,
  /^paso\s+robles(?:,\s*ca)?$/i,
  /^adelaida(?:\s+district)?(?:,\s*ca)?$/i,
  /^willamette(?:\s+valley)?(?:,\s*or)?$/i,
  /^dundee\s+hills(?:,\s*or)?$/i,
  /^eola[\s-]?amity\s+hills(?:,\s*or)?$/i,
  /^columbia\s+valley(?:,\s*wa)?$/i,
  /^walla\s+walla(?:\s+valley)?(?:,\s*wa)?$/i,
  /^red\s+mountain(?:,\s*wa)?$/i,
  /^finger\s+lakes(?:,\s*ny)?$/i,
  /^napa\s+valley(?:,\s*ca)?$/i,
  // Argentina / Chile / etc.
  /^mendoza$/i,
  /^uco\s+valley$/i
];

function isKnownAppellationHeading(line: string): boolean {
  const trimmed = line.replace(/[.,;]+$/g, '').trim();
  if (!trimmed) return false;
  for (const re of APPELLATION_HEADING_RE) {
    if (re.test(trimmed)) return true;
  }
  return false;
}

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
  if (line.length > 80) return false;
  if (FOOD_SECTION_NAMES_RE.test(line)) return false;
  if (VINTAGE_RE.test(line)) return false;
  if (NV_RE.test(line)) return false;
  if (/\$\d/.test(line)) return false;
  // Strip decorative wrappers/continuations before classifying so that
  // `:: SPARKLING WINE ::` and `:: CHARDONNAY (cont'd) ::` are recognized.
  const stripped = stripDecorationAndContinuation(line);
  if (!stripped) return false;
  if (/,/.test(stripped)) return false;
  const tokens = stripped.trim().split(/\s+/);
  if (tokens.length > 6) return false;
  const trailing = extractTrailingPrices(stripped);
  if (trailing.prices.length > 0) return false;
  const lettersOnly = stripped.replace(/[^A-Za-z]/g, '');
  if (lettersOnly.length < 3) return false;
  return classifySection(stripped) !== null;
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
  // Common Water-Grill-style OCR pattern is vintage glued to one OR two
  // trailing prices, with the first price optionally `\d+\.5` (half-dollar
  // glass price) and the second a whole-dollar bottle/carafe price. Try the
  // multi-price triple split first.
  const triple = line.match(
    /\b(19[5-9]\d|20[0-4]\d)(\d{1,3})\.(5)(\d{1,4})\b/
  );
  if (triple) {
    const year = parseInt(triple[1], 10);
    if (year >= 1950 && year <= 2049) {
      // <year><intGlass>.5<intCarafe> → "<year> <intGlass>.5 <intCarafe>"
      const replaced = line.replace(
        /\b(19[5-9]\d|20[0-4]\d)(\d{1,3})\.(5)(\d{1,4})\b/,
        '$1 $2.$3 $4'
      );
      return { line: replaced };
    }
  }
  // Vintage glued to two whole-dollar prices (e.g. "20241835" → "2024 18 35").
  const doubleWhole = line.match(/\b(19[5-9]\d|20[0-4]\d)(\d{2})(\d{2})\b/);
  if (doubleWhole) {
    const year = parseInt(doubleWhole[1], 10);
    if (year >= 1950 && year <= 2049) {
      const a = parseInt(doubleWhole[2], 10);
      const b = parseInt(doubleWhole[3], 10);
      // Only split as two glass/carafe prices when the second is larger (carafe
      // > glass) and both look like sensible by-the-glass numbers.
      if (a > 0 && b > 0 && a <= 99 && b <= 99 && a < b) {
        const replaced = line.replace(
          /\b(19[5-9]\d|20[0-4]\d)(\d{2})(\d{2})\b/,
          '$1 $2 $3'
        );
        return { line: replaced };
      }
    }
  }
  // Fall back to the simple year + single-tail split.
  const m = line.match(GLUED_VINTAGE_BIN_RE);
  if (!m) return { line };
  const year = parseInt(m[1], 10);
  if (year < 1950 || year > 2049) return { line };
  const tail = m[2];
  if (!/^\d{1,4}$/.test(tail)) return { line };
  const replaced = line.replace(GLUED_VINTAGE_BIN_RE, `$1 $2`);
  // Only treat the glued tail as a bin candidate when it's at least 3 digits.
  // Shorter tails (1-2 digits, including fractional prices like ".5") almost
  // always represent a glass / bottle price, not a cellar bin.
  const isLikelyBin = /^\d{3,4}$/.test(tail);
  return isLikelyBin ? { line: replaced, bin: tail } : { line: replaced };
}

function extractTrailingBin(line: string): { name: string; bin?: string } {
  const tokens = line.split(/\s+/);
  if (tokens.length === 0) return { name: line };
  const last = tokens[tokens.length - 1];
  if (isVintageToken(last)) return { name: line };
  if (/^\$?\d{1,4}(?:\.\d{1,2})?$/.test(last)) return { name: line };
  if (/^\d{3,7}$/.test(last)) {
    tokens.pop();
    return { name: tokens.join(' ').trim(), bin: last };
  }
  return { name: line };
}

// Strip a leading 3-4 digit bin/SKU token (e.g. "200 La Caña Albariño..." →
// "La Caña Albariño..."). The preprocessWineLine already unglues "200La Caña"
// → "200 La Caña" so we always see a whitespace-separated leading token here.
// Wine-list bins are sometimes 4 digits and may coincide with a year (e.g.
// "2000"). A leading 4-digit number is interpreted as a bin (not a vintage)
// when the same line also has a different 4-digit vintage somewhere else, or
// when the next token is clearly a producer (capitalized letter / quote).
function extractLeadingBin(line: string): { name: string; bin?: string } {
  const tokens = line.split(/\s+/);
  if (tokens.length < 2) return { name: line };
  const first = tokens[0];
  if (!/^\d{3,4}$/.test(first)) return { name: line };
  // Next token must look name-like (start with a letter or opening quote).
  if (!/^[A-Za-zÀ-ÿ'’"`]/.test(tokens[1])) return { name: line };
  const n = parseInt(first, 10);
  const isPossibleYear = first.length === 4 && n >= 1900 && n <= 2049;
  if (isPossibleYear) {
    // Treat as bin if another distinct 4-digit vintage exists later on the
    // line (real wine bottle rows always include the vintage with the price).
    const rest = tokens.slice(1).join(' ');
    let foundOtherYear = false;
    const yearRe = /\b(19[5-9]\d|20[0-4]\d)\b/g;
    let mm: RegExpExecArray | null;
    while ((mm = yearRe.exec(rest)) !== null) {
      if (mm[1] !== first) {
        foundOtherYear = true;
        break;
      }
    }
    if (!foundOtherYear && !NV_RE.test(rest)) {
      // Looks like a real leading vintage with no other year token. Keep it.
      return { name: line };
    }
  }
  return { name: tokens.slice(1).join(' ').trim(), bin: first };
}

function extractTrailingPrices(line: string): { name: string; prices: number[] } {
  const tokens = line.split(/\s+/);
  const prices: number[] = [];
  while (tokens.length > 0) {
    const last = tokens[tokens.length - 1];
    if (isVintageToken(last)) break;
    // Accept whole-dollar prices and half-dollar prices ("13.5") as well as
    // standard two-decimal prices ("13.50"). The half-dollar form is common on
    // wine-list glass prices.
    const m = last.match(/^\$?(\d{1,4}(?:\.\d{1,2})?)$/);
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

function stripGeoTokensForResidueCheck(text: string): string {
  let s = text;
  // Strip known region matches (any country).
  for (const key of Object.keys(COUNTRY_REGIONS)) {
    const { country, regions } = COUNTRY_REGIONS[key];
    for (const re of regions) {
      s = s.replace(re, ' ');
    }
    s = s.replace(new RegExp(`\\b${country.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi'), ' ');
  }
  // Strip US state abbreviations as standalone tokens.
  s = s.replace(
    new RegExp(`\\b${STATE_ABBR_INLINE}\\b\\.?`, 'g'),
    ' '
  );
  // Strip generic geo words.
  s = s.replace(GEO_GENERIC_WORDS_RE, ' ');
  // Strip appellation heading patterns (anchored versions wouldn't match
  // inline, so we test the whole stripped text against the unanchored forms
  // by replacing common appellation names explicitly).
  const APPELLATION_INLINE_RE = [
    /\bsaint[\s.\-]?[ée]milion(?:\s+grand\s+cru(?:\s+class[ée])?)?\b/gi,
    /\bst[\s.\-]?[ée]milion(?:\s+grand\s+cru(?:\s+class[ée])?)?\b/gi,
    /\bsaint[\s.\-]?est[èe]phe\b/gi,
    /\bst[\s.\-]?est[èe]phe\b/gi,
    /\bchassagne[\s-]?montrachet\b/gi,
    /\bpuligny[\s-]?montrachet\b/gi,
    /\bch[âa]teauneuf[\s-]?du[\s-]?pape\b/gi,
    /\bsancerre\b/gi,
    /\brutherford\b/gi,
    /\boakville\b/gi,
    /\bpauillac\b/gi,
    /\bmargaux\b/gi,
    /\bpomerol\b/gi,
    /\bbarolo\b/gi,
    /\bbarbaresco\b/gi,
    /\bchianti(?:\s+classico(?:\s+riserva)?)?\b/gi,
    /\bbrunello(?:\s+di\s+montalcino)?\b/gi,
    /\brioja(?:\s+(?:reserva|gran\s+reserva|crianza))?\b/gi
  ];
  for (const re of APPELLATION_INLINE_RE) s = s.replace(re, ' ');
  return s.replace(/[,;]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function looksLikeWineEntry(line: string): boolean {
  if (!line || line.length < 4) return false;
  if (FOOD_NEGATIVE_RE.test(line)) return false;
  if (isBeverageNonWineLine(line)) return false;
  if (/^\(/.test(line)) return false;
  if (isLikelyBinOrNoiseLine(line)) return false;
  if (isGeoOnlyFragment(line)) return false;

  // Decorative section headings — `:: SPARKLING WINE ::`, `== RED ==`,
  // `:: CABERNET SAUVIGNON (cont'd) ::` — never wine rows.
  if (isDecorativeSectionHeading(line)) return false;
  // Continuation markers like `(cont'd)` always indicate a section heading,
  // never a wine row, when there's no bottle evidence on the same line.
  if (
    CONTINUATION_MARKER_RE.test(line) &&
    !VINTAGE_RE.test(line) &&
    !NV_RE.test(line) &&
    !/\$\d/.test(line)
  ) {
    return false;
  }
  // Varietal- or category-only heading (e.g. `CABERNET SAUVIGNON`,
  // `Chardonnay`, `Pinot Grigio & Pinot Gris`, `RED WINE`).
  if (isVarietalOrCategoryOnlyHeading(line)) return false;
  // All-caps section heading without bottle evidence (e.g. `SOUTHERN & NEW
  // WORLD RHÔNE`, `NEW WORLD 'BORDEAUX'`).
  if (isAllCapsSectionHeading(line)) return false;
  // Quote-prefixed vineyard/appellation fragment without any vintage/price/
  // varietal evidence (e.g. `'Blanchots' Grand Cru`, `'Russian River Valley,
  // CA`). Real producer rows that happen to use a quoted cuvée name will have
  // a vintage or price on the same line and are preserved.
  if (isQuotePrefixedFragmentLine(line)) {
    const hasVintageHere = VINTAGE_RE.test(line) || NV_RE.test(line);
    const { prices: pricesHere } = extractTrailingPrices(line);
    const hasPriceHere = pricesHere.length > 0;
    const hasVarietalHere = detectVarietal(line) !== undefined;
    if (!hasVintageHere && !hasPriceHere && !hasVarietalHere) return false;
  }

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

  // Reject any line that — after stripping vintage/price/bin — is a known
  // appellation/region heading on its own (e.g. "Sancerre", "Saint-Émilion
  // Grand Cru", "Russian River Valley, CA", "Chassagne-Montrachet",
  // "Châteauneuf-du-Pape, Southern Rhône"). These carry no producer info.
  if (!hasVintage && !hasPrice && !hasVarietal) {
    const headingCandidate = candidate.replace(/[,;]+\s*$/g, '').trim();
    if (isKnownAppellationHeading(headingCandidate)) return false;

    // Also handle "Appellation, Sub-Region" pairs where the second part is a
    // known region/country and the first part is an appellation heading.
    const parts = headingCandidate.split(/\s*,\s*/).filter(Boolean);
    if (parts.length >= 1 && isKnownAppellationHeading(parts[0])) {
      const rest = parts.slice(1).join(' ').trim();
      if (!rest) return false;
      // If every remaining part is itself a geo/region/country/state, reject.
      const restParts = parts.slice(1);
      const allGeoRest = restParts.every((p) => {
        const cleaned = p.replace(/\.$/, '').toUpperCase();
        if (STATE_ABBR_RE.test(cleaned)) return true;
        if (GEO_GENERIC_WORDS_RE.test(p)) return true;
        const det = detectRegionAndCountry(p);
        return Boolean(det.region || det.country);
      });
      if (allGeoRest) return false;
    }
  }

  const evidenceCount =
    (hasVintage ? 1 : 0) +
    (hasPrice ? 1 : 0) +
    (hasVarietal ? 1 : 0) +
    (hasGeo ? 1 : 0);

  if (evidenceCount === 0) return false;

  if (hasGeo && !hasVintage && !hasPrice && !hasVarietal) {
    // Strip ALL geo tokens (known regions, country names, state abbrevs,
    // generic geo words, and well-known appellations) and require what's
    // left to still contain meaningful producer text. This catches things
    // like "Russian River Valley, CA" where "Valley" survived the previous
    // narrower strip.
    const residue = stripGeoTokensForResidueCheck(candidate);
    if (!hasMeaningfulProducerText(residue)) return false;
    // Require at least 2 alpha tokens of length >= 3 in the residue — a
    // real producer name almost always has at least two such tokens (e.g.
    // "Domaine Leflaive", "Sea Smoke") whereas appellation-leftovers tend
    // to have at most one.
    const residueTokens = residue.split(/\s+/).filter(
      (t) => /^[A-Za-z][A-Za-z'’\-]*$/.test(t) && t.length >= 3 && !STATE_ABBR_RE.test(t.toUpperCase())
    );
    if (residueTokens.length < 2) return false;
  }

  return true;
}

function splitProducerName(text: string): { producer?: string; name: string } {
  const cleanedText = text.replace(/\s{2,}/g, ' ').trim();
  const commaParts = cleanedText.split(/\s*,\s*/);
  if (commaParts.length >= 2) {
    // Glass-list style "<Varietal>, <Producer>, <Region>, <Country>": the
    // leading token is a bare varietal name (no other identity tokens). In
    // that case, treat the second token as the producer/name and the rest
    // as geography. The varietal will still be detected from the original
    // line later via detectVarietal.
    const first = commaParts[0].trim();
    if (commaParts.length >= 2 && isVarietalOrCategoryOnlyHeading(first)) {
      const producer = commaParts[1].trim();
      const rest = commaParts.slice(2).join(', ').trim();
      if (producer && producer.length <= 80) {
        if (rest) return { producer, name: rest };
        return { name: producer };
      }
    }
    const producer = first;
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

  // Strip leading bin/SKU first (e.g. "200 La Caña Albariño..." → "La Caña
  // Albariño..."). The preprocess pass already unglued any "200La" to "200 La".
  const leading = extractLeadingBin(working);
  working = leading.name;
  let bin = leading.bin;

  const deglued = splitGluedVintageBin(working);
  working = deglued.line;
  if (!bin && deglued.bin) bin = deglued.bin;

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

// Wine-menu-specific pre-extraction normalization. Reverses one wrong
// behavior of the general menuParser.normalizeLines pipeline for wine lists:
// the GLUED_PRICES regex interprets "15.53" (in "202315.530") as a literal
// `$15.53` price and inserts a space after it, splitting the half-dollar
// glass price from its carafe price. For wine lists, the half-dollar form
// (`15.5`) is the glass price and the trailing digits are the carafe price.
// We pre-fix this glued vintage+half-price+carafe shape so the rest of the
// pipeline sees a clean "year glass.5 carafe" triple.
function preprocessRawWineText(text: string): string {
  return text
    .replace(/\b(19[5-9]\d|20[0-4]\d)(\d{1,3})\.5(\d{1,4})\b/g, '$1 $2.5 $3')
    .replace(/\b(19[5-9]\d|20[0-4]\d)(\d{2})(\d{2})\b/g, (m, y, a, b) => {
      const ai = parseInt(a, 10);
      const bi = parseInt(b, 10);
      if (ai > 0 && bi > 0 && ai <= 99 && bi <= 99 && ai < bi) {
        return `${y} ${a} ${b}`;
      }
      return m;
    })
    .replace(/\b(19[5-9]\d|20[0-4]\d)(\d{1,3})\b/g, '$1 $2')
    .replace(/\b(NV|MV|N\.V\.)(\d{1,4}(?:\.\d{1,2})?)\b/g, '$1 $2');
}

export function parseWineText(text: string, sourceFile: string): ParsedWineList {
  const lines = normalizeLines(preprocessRawWineText(text));
  const sections: ParsedWineSection[] = [];
  let current: ParsedWineSection = {
    section: 'WINE LIST',
    category: 'wine',
    items: []
  };
  let lastEntry: WineEntry | null = null;
  // Section-mode gate. Default 'unknown' (permissive: pre-wine context such as
  // a wine-only menu without explicit headings still parses). Once a decorative
  // `:: ... ::` heading is classified as 'wine' or 'non-wine', we enter that
  // mode and only flip back when another classified heading appears.
  let sectionMode: SectionMode = 'unknown';

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

  for (const rawLineOrig of lines) {
    const rawLine = preprocessWineLine(rawLineOrig);
    const line = rawLine.replace(SECTION_DECORATION_RE, '').trim();
    if (!line) continue;

    // Update section-mode gate from any decorative `:: ... ::` heading.
    const decoInner = extractDecorativeHeadingText(line);
    if (decoInner !== null) {
      const mode = classifyDecorativeSectionMode(decoInner);
      if (mode === 'non-wine') {
        sectionMode = 'non-wine';
        lastEntry = null;
        continue;
      }
      if (mode === 'wine') {
        sectionMode = 'wine';
        // Fall through so canonical sparkling/white/red etc. headings still
        // populate the section name when matched below.
      }
    }

    // Hard gate: in a non-wine section, drop every line until the next wine
    // heading. This is the structural fix for cocktails / beer / spirits.
    if (sectionMode === 'non-wine') {
      lastEntry = null;
      continue;
    }

    if (looksLikeWineSectionHeader(line)) {
      const stripped = stripDecorationAndContinuation(line);
      const cls = classifySection(stripped)!;
      flush();
      current = { section: cls.canonical, category: cls.category, items: [] };
      lastEntry = null;
      continue;
    }

    // Decorative/varietal/category-only headings that aren't a known canonical
    // section (e.g. `:: CABERNET SAUVIGNON ::`, `:: MALBEC (cont'd) ::`,
    // `SOUTHERN & NEW WORLD RHÔNE`). Drop them and reset the trailing-entry
    // pointer so they don't bleed into the previous wine's notes.
    if (
      isDecorativeSectionHeading(line) ||
      isVarietalOrCategoryOnlyHeading(line) ||
      isAllCapsSectionHeading(line)
    ) {
      lastEntry = null;
      continue;
    }

    // Lone continuation marker without bottle evidence — section continuation,
    // not a wine row.
    if (
      CONTINUATION_MARKER_RE.test(line) &&
      !VINTAGE_RE.test(line) &&
      !NV_RE.test(line) &&
      !/\$\d/.test(line)
    ) {
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

    // If this line is itself a non-wine beverage (beer/cocktail/spirit) or
    // food line, treat it as a section break and clear lastEntry so we don't
    // pollute the previous wine's notes with beer/cocktail strings (which
    // would later cause filterFoodNoise to drop the real wine).
    if (isBeverageNonWineLine(line) || FOOD_NEGATIVE_RE.test(line) || FOOD_SECTION_NAMES_RE.test(line)) {
      lastEntry = null;
      continue;
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
  // First pass: rescue entries where buildWineEntry's comma-split left the
  // wine "name" as nothing more than a state/region fragment but the producer
  // field carries the real identity. Promote the producer to the name so the
  // wine survives the downstream short-name and geo-residue checks.
  for (const e of entries) {
    if (!e.producer) continue;
    const nameTrim = (e.name ?? '').replace(/[.,;]+$/g, '').trim();
    const looksGeoOnly =
      /^[A-Z]{2}\.?$/.test(nameTrim) ||
      STATE_ABBR_RE.test(nameTrim.toUpperCase().replace(/\.$/, '')) ||
      isGeoOnlyFragment(nameTrim) ||
      isGeoOnlyFragment(`Anything ${nameTrim}`) ||
      (() => {
        const residue = stripGeoTokensForResidueCheck(nameTrim);
        const tokens = residue.split(/\s+/).filter(
          (t) => /^[A-Za-z][A-Za-z'’\-]*$/.test(t) && t.length >= 3 && !STATE_ABBR_RE.test(t.toUpperCase())
        );
        return tokens.length === 0;
      })();
    if (!looksGeoOnly) continue;
    const hasBottleEvidence = Boolean(
      e.vintage || e.price || e.glassPrice || e.bottlePrice || e.binNumber
    );
    if (!hasBottleEvidence) continue;
    // Don't promote a bare varietal/category-only producer into the wine
    // name — that would yield ghost rows like just "Pinot Noir" with no
    // identity. Drop the entry entirely later by leaving e.name short so
    // the standard filters reject it.
    if (
      isVarietalOrCategoryOnlyHeading(e.producer) ||
      CATEGORY_LIKE_WORDS_RE.test(e.producer.trim())
    ) {
      continue;
    }
    const origName = e.name;
    if (!e.region) {
      const det = detectRegionAndCountry(origName);
      if (det.region) e.region = det.region;
      if (det.country) e.country = det.country;
    }
    e.name = e.producer;
    delete e.producer;
  }

  return entries.filter((e) => {
    const blob = `${e.producer ?? ''} ${e.name} ${e.notes ?? ''}`;
    if (FOOD_NEGATIVE_RE.test(blob)) return false;
    if (isBeverageNonWineLine(blob)) return false;
    if (!e.name || e.name.length < 2) return false;
    if (/^\d+$/.test(e.name.replace(/\s+/g, ''))) return false;
    const letters = e.name.replace(/[^A-Za-z]/g, '');
    if (letters.length < 3) return false;
    // Strict final filter — reject anything that still looks like a
    // decorative section heading, a varietal/category-only label, or a
    // continuation marker. We test both the bare name and the producer+name
    // combination so neither field can smuggle a heading through.
    const identityRaw = `${e.producer ?? ''} ${e.name}`.trim();
    const hasBottleEvidenceStrict = Boolean(
      e.vintage || e.price || e.glassPrice || e.bottlePrice || e.binNumber ||
      (e.producer && e.varietal)
    );
    if (isDecorativeSectionHeading(e.name) || isDecorativeSectionHeading(identityRaw)) return false;
    if (
      CONTINUATION_MARKER_RE.test(e.name) ||
      CONTINUATION_MARKER_RE.test(identityRaw)
    ) {
      if (!hasBottleEvidenceStrict) return false;
    }
    if (isVarietalOrCategoryOnlyHeading(e.name) || isVarietalOrCategoryOnlyHeading(identityRaw)) {
      if (!hasBottleEvidenceStrict) return false;
    }
    if (isAllCapsSectionHeading(e.name) || isAllCapsSectionHeading(identityRaw)) {
      if (!hasBottleEvidenceStrict) return false;
    }
    if (isQuotePrefixedFragmentLine(e.name) || isQuotePrefixedFragmentLine(identityRaw)) {
      if (!hasBottleEvidenceStrict) return false;
    }
    // Any residual ornament `::` in the name → reject.
    if (/::/.test(e.name) || /::/.test(e.producer ?? '')) return false;
    // Drop entries whose entire identity is a geo-only fragment (e.g. "Coast, CA").
    const identity = `${e.producer ?? ''}, ${e.name}`.replace(/^,\s*/, '');
    if (isGeoOnlyFragment(identity)) return false;
    // Drop entries that have no producer, no vintage, no price, no varietal
    // and whose name (or producer+name) is a known appellation/region
    // heading like "Sancerre", "Saint-Émilion Grand Cru", "Russian River
    // Valley, CA", "Chassagne-Montrachet". These are pure list section
    // sub-headings, not wine records.
    const hasBottleEvidence = Boolean(
      e.vintage || e.price || e.glassPrice || e.bottlePrice || e.varietal || e.binNumber
    );
    if (!hasBottleEvidence) {
      if (isKnownAppellationHeading(e.name)) return false;
      const combined = identity.replace(/[.,;]+$/g, '').trim();
      if (isKnownAppellationHeading(combined)) return false;
      // Strip the wine name's geo residue: if nothing producer-like remains,
      // reject. Catches "Russian River Valley, CA" with no other info.
      const residue = stripGeoTokensForResidueCheck(
        `${e.producer ?? ''} ${e.name}`.trim()
      );
      const residueTokens = residue.split(/\s+/).filter(
        (t) => /^[A-Za-z][A-Za-z'’\-]*$/.test(t) && t.length >= 3 && !STATE_ABBR_RE.test(t.toUpperCase())
      );
      if (residueTokens.length < 2) return false;
    }
    // De-duplicate identical fragment entries across sections.
    const sig = `${(e.producer ?? '').toLowerCase().trim()}|${e.name.toLowerCase().trim()}|${e.vintage ?? ''}|${e.region ?? ''}|${e.country ?? ''}`;
    if (seen.has(sig)) return false;
    seen.add(sig);
    return true;
  });
}
