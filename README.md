# menu-parser-node

PDF / image menu parser API for TableSomm. Two endpoints, both LLM-backed when
`OPENAI_API_KEY` is configured, with the existing deterministic regex parsers
preserved as automatic fallbacks.

- `POST /parse-menu` — meal/food-menu extractor (LLM-first, deterministic
  fallback).
- `POST /parse-wine-list` — wine-list extractor (LLM-first, deterministic
  fallback).

## Why LLM extraction

Restaurant PDFs are too irregular for pure regex to keep up: multi-column raw
bar tiers, dishes with no description, market-price entries, wine lists with
varied producer/varietal/region orderings, half-bottle carafe columns, bin
numbers, multilingual menus. Each LLM parser sends the extracted text — page
by page when available — to an OpenAI chat model with a strict structured
prompt, then validates and normalizes the response against a schema before
mapping into the TableSomm shapes the frontend consumes.

The deterministic parsers (`menuParser.ts`, `wineParser.ts`) are kept
unchanged and used as automatic fallbacks when:

- `OPENAI_API_KEY` is not set, or
- the LLM call fails for any reason, or
- the client passes `?engine=deterministic` to force the deterministic path.

## Run

```bash
npm install
npm run build
npm start
```

For local development with hot reload:

```bash
npm run dev
```

## Validate the LLM pipelines

Both validation scripts run without spending tokens by default — they exercise
the post-processing layer against representative fixtures.

```bash
# Wine LLM pipeline (compares against Water Grill known-good target)
npx tsx scripts/validate-wine-llm.ts

# Meal-menu LLM pipeline (uses scripts/fixtures/sample_menu_raw.json)
npx tsx scripts/validate-menu-llm.ts
```

To exercise an actual LLM call (requires `OPENAI_API_KEY`):

```bash
OPENAI_API_KEY=sk-... npx tsx scripts/validate-wine-llm.ts \
  --live --pdf=/path/to/Watergrill-wine-menu.pdf --out=./wines.json

OPENAI_API_KEY=sk-... npx tsx scripts/validate-menu-llm.ts \
  --live --pdf=/path/to/dinner-menu.pdf --out=./menu.json
```

You can also force the deterministic path on the live API by appending
`?engine=deterministic` to either endpoint.

## Render / production deployment

Set these environment variables in Render (or your host):

| Variable             | Required | Default                  | Notes                                                                              |
| -------------------- | -------- | ------------------------ | ---------------------------------------------------------------------------------- |
| `OPENAI_API_KEY`     | yes\*    | —                        | Required to use the LLM extractors. Without it both endpoints fall back to regex.  |
| `WINE_PARSER_MODEL`  | no       | `gpt-4o-mini`            | Chat-completions model for `/parse-wine-list`. Must support JSON response format.  |
| `MENU_PARSER_MODEL`  | no       | `gpt-4o-mini`            | Chat-completions model for `/parse-menu`. Must support JSON response format.       |
| `OPENAI_BASE_URL`    | no       | `https://api.openai.com` | Override for Azure OpenAI or compatible proxies.                                   |
| `PORT`               | no       | `3000`                   | Bound listen port.                                                                 |

\* The service still boots and responds without `OPENAI_API_KEY` — it just
serves the deterministic parser output and includes a `notice` field in the
response telling the operator to configure the key.

Health check: `GET /health` returns `wineParser.llmEnabled: true` and
`menuParser.llmEnabled: true` once `OPENAI_API_KEY` is set.

## Response shapes

### `POST /parse-menu`

```jsonc
{
  "engine": "llm",                  // or "deterministic-fallback" / "deterministic" / "deterministic-no-key"
  "extraction": {                   // raw target shape (what ChatGPT returns)
    "source_file": "dinner-menu.pdf",
    "extraction_scope": "Only actual food/menu dishes ...",
    "dish_count": 42,
    "dishes": [
      {
        "name": "Maine Lobster Roll",
        "section": "Sandwiches",
        "description": "Warm butter, brioche bun, lemon",
        "price": 38.0,
        "price_tiers": [],
        "protein": "shellfish",
        "style": "warm",
        "tags": ["shellfish"],
        "ingredients": ["lobster", "butter", "brioche"],
        "is_raw_bar": false,
        "contains_shellfish": true,
        "source_pages": [2]
      }
    ]
  },
  "rawDishes": [...],              // alias of extraction.dishes
  "dishes": [...],                 // TableSomm-shaped dish objects (frontend)
  "count": 42,
  "parserVersion": "2.0.0-llm",
  "model": "gpt-4o-mini",
  "acceptedInputType": "pdf"
}
```

Each TableSomm dish includes `id`, `name`, `section`, `category`, `protein`,
`style`, `description`, `price`, `priceTiers`, `tags`, `ingredients`,
`isRawBar`, `containsShellfish`, `notes`, and `sourcePages`. The validator
drops anything that is clearly a beverage (wine/cocktail/beer/spirits), a
section heading on its own, a disclaimer, or an entry with no usable name.

### `POST /parse-wine-list`

```jsonc
{
  "engine": "llm",                  // or "deterministic-fallback" / "deterministic" / "deterministic-no-key"
  "extraction": {
    "source_file": "Watergrill-wine-menu.pdf",
    "extraction_scope": "Only wines fully identified with a glass, half-bottle carafe, or bottle price; cocktails, beer, spirits, and non-wine items excluded.",
    "wine_count": 233,
    "wines": [
      {
        "wine": "Cabernet Sauvignon, Duckhorn Vineyards, Napa Valley, CA",
        "vintage": "2022",
        "category": "Red",
        "bin": null,
        "prices": { "glass": 32.0, "half_bottle_carafe": 63.0 },
        "source_pages": [3]
      }
    ]
  },
  "rawWines": [...],
  "wines": [...],                  // TableSomm-shaped wine objects (frontend)
  "count": 233,
  "parserVersion": "2.0.0-llm",
  "model": "gpt-4o-mini",
  "acceptedInputType": "pdf"
}
```

The frontend accepts `wines | items | wineList`; each entry includes `name`,
`vintage`, `category`, `glassPrice`, `halfBottlePrice`, `bottlePrice`,
`priceTiers`, `binNumber`, `sourcePages`, and `notes`.

## Fallback behavior

When `OPENAI_API_KEY` is unset, the response includes `"engine":
"deterministic-no-key"` and a `notice` field. When the LLM call fails at
runtime, the server transparently retries with the deterministic parser and
returns `"engine": "deterministic-fallback"` plus an `llmError` field so the
operator can diagnose. Either way, the frontend continues to receive a
populated `dishes` / `wines` array.
