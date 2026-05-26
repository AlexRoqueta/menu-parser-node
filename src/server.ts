import express from 'express';
import cors from 'cors';
import multer from 'multer';
import {
  extractTextFromUpload,
  filterMealDishes,
  filterParsedMenuToDishes,
  parseMenuText,
  toTableSommDishes as toDeterministicDishes
} from './menuParser.js';
import {
  parseWineText,
  toWineEntries,
  filterFoodNoise
} from './wineParser.js';
import {
  extractPdfPages,
  extractWinesWithLlm,
  toTableSommWines,
  WINE_LLM_PARSER_VERSION
} from './wineLlmParser.js';
import {
  extractMenuWithLlm,
  toTableSommDishes as toLlmDishes,
  MENU_LLM_PARSER_VERSION
} from './menuLlmParser.js';

const WINE_PARSER_VERSION = '1.0.0';
const MENU_PARSER_VERSION = '1.0.0';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }
});

const app = express();
app.use(cors({ origin: true }));
app.use(express.json({ limit: '1mb' }));

app.get('/', (_req, res) => {
  res.json({
    ok: true,
    service: 'tablesomm-menu-parser-api',
    endpoints: [
      'GET /health',
      'POST /parse-menu (multipart, field=file)',
      'POST /parse-wine-list (multipart, field=file)'
    ],
    acceptedFileTypes: ['application/pdf', 'image/*'],
    wineParser: {
      llmVersion: WINE_LLM_PARSER_VERSION,
      llmEnabled: Boolean(process.env.OPENAI_API_KEY),
      llmModel: process.env.WINE_PARSER_MODEL ?? 'gpt-4o-mini'
    },
    menuParser: {
      llmVersion: MENU_LLM_PARSER_VERSION,
      llmEnabled: Boolean(process.env.OPENAI_API_KEY),
      llmModel: process.env.MENU_PARSER_MODEL ?? 'gpt-4o-mini'
    }
  });
});

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'tablesomm-menu-parser-api',
    acceptedFileTypes: ['application/pdf', 'image/*'],
    wineParser: {
      llmVersion: WINE_LLM_PARSER_VERSION,
      llmEnabled: Boolean(process.env.OPENAI_API_KEY)
    },
    menuParser: {
      llmVersion: MENU_LLM_PARSER_VERSION,
      llmEnabled: Boolean(process.env.OPENAI_API_KEY)
    }
  });
});

function classifyUpload(file: Express.Multer.File): { isPdf: boolean; isImage: boolean } {
  const isPdf =
    /\.pdf$/i.test(file.originalname) || file.mimetype === 'application/pdf';
  const isImage =
    (file.mimetype?.startsWith('image/') ?? false) ||
    /\.(png|jpe?g|webp|gif|bmp|tiff?)$/i.test(file.originalname);
  return { isPdf, isImage };
}

app.post('/parse-menu', upload.single('file'), async (req, res) => {
  try {
    const file = req.file;
    if (!file) {
      return res
        .status(400)
        .json({ error: 'Missing file upload. Use form field name "file".' });
    }

    const { isPdf, isImage } = classifyUpload(file);
    if (!isPdf && !isImage) {
      return res.status(400).json({ error: 'Only PDF and image files are supported.' });
    }

    const llmEnabled = Boolean(process.env.OPENAI_API_KEY);
    const forceDeterministic = req.query.engine === 'deterministic';

    if (llmEnabled && !forceDeterministic) {
      let pages: string[] | undefined;
      let rawText: string;
      if (isPdf) {
        try {
          pages = await extractPdfPages(file.buffer);
          rawText = pages.join('\n\n');
        } catch {
          rawText = await extractTextFromUpload(file.buffer, file.originalname, file.mimetype);
        }
      } else {
        rawText = await extractTextFromUpload(file.buffer, file.originalname, file.mimetype);
      }

      try {
        const extraction = await extractMenuWithLlm({
          sourceFile: file.originalname,
          pages,
          rawText
        });
        const dishes = toLlmDishes(extraction);
        return res.json({
          engine: 'llm',
          extraction,
          rawDishes: extraction.dishes,
          dishes,
          count: dishes.length,
          parserVersion: MENU_LLM_PARSER_VERSION,
          model: process.env.MENU_PARSER_MODEL ?? 'gpt-4o-mini',
          acceptedInputType: isPdf ? 'pdf' : 'image'
        });
      } catch (llmErr) {
        const message = llmErr instanceof Error ? llmErr.message : 'LLM extraction failed';
        try {
          const text =
            rawText ?? (await extractTextFromUpload(file.buffer, file.originalname, file.mimetype));
          const parsed = parseMenuText(text, file.originalname);
          const allDishes = toDeterministicDishes(parsed);
          const dishes = filterMealDishes(allDishes);
          const filteredParsed = filterParsedMenuToDishes(parsed, dishes);
          return res.json({
            engine: 'deterministic-fallback',
            llmError: message,
            parsed: filteredParsed,
            dishes,
            count: dishes.length,
            parserVersion: MENU_PARSER_VERSION,
            acceptedInputType: isPdf ? 'pdf' : 'image'
          });
        } catch (innerErr) {
          const m2 = innerErr instanceof Error ? innerErr.message : 'Unknown parse error';
          return res.status(500).json({ error: m2, llmError: message });
        }
      }
    }

    const text = await extractTextFromUpload(
      file.buffer,
      file.originalname,
      file.mimetype
    );
    const parsed = parseMenuText(text, file.originalname);
    const allDishes = toDeterministicDishes(parsed);
    const dishes = filterMealDishes(allDishes);
    const filteredParsed = filterParsedMenuToDishes(parsed, dishes);

    return res.json({
      engine: forceDeterministic ? 'deterministic' : 'deterministic-no-key',
      parsed: filteredParsed,
      dishes,
      count: dishes.length,
      parserVersion: MENU_PARSER_VERSION,
      acceptedInputType: isPdf ? 'pdf' : 'image',
      ...(llmEnabled
        ? {}
        : {
            notice:
              'OPENAI_API_KEY is not set. Configure it on the server to enable the LLM menu extractor.'
          })
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown parse error';
    return res.status(500).json({ error: message });
  }
});

app.post('/parse-wine-list', upload.single('file'), async (req, res) => {
  try {
    const file = req.file;
    if (!file) {
      return res
        .status(400)
        .json({ error: 'Missing file upload. Use form field name "file".' });
    }

    const { isPdf, isImage } = classifyUpload(file);
    if (!isPdf && !isImage) {
      return res.status(400).json({ error: 'Only PDF and image files are supported.' });
    }

    const llmEnabled = Boolean(process.env.OPENAI_API_KEY);
    const forceDeterministic = req.query.engine === 'deterministic';

    if (llmEnabled && !forceDeterministic) {
      let pages: string[] | undefined;
      let rawText: string;
      if (isPdf) {
        try {
          pages = await extractPdfPages(file.buffer);
          rawText = pages.join('\n\n');
        } catch {
          rawText = await extractTextFromUpload(file.buffer, file.originalname, file.mimetype);
        }
      } else {
        rawText = await extractTextFromUpload(file.buffer, file.originalname, file.mimetype);
      }

      try {
        const extraction = await extractWinesWithLlm({
          sourceFile: file.originalname,
          pages,
          rawText
        });
        const wines = toTableSommWines(extraction);
        return res.json({
          engine: 'llm',
          extraction,
          rawWines: extraction.wines,
          wines,
          count: wines.length,
          parserVersion: WINE_LLM_PARSER_VERSION,
          model: process.env.WINE_PARSER_MODEL ?? 'gpt-4o-mini',
          acceptedInputType: isPdf ? 'pdf' : 'image'
        });
      } catch (llmErr) {
        const message = llmErr instanceof Error ? llmErr.message : 'LLM extraction failed';
        try {
          const text =
            rawText ?? (await extractTextFromUpload(file.buffer, file.originalname, file.mimetype));
          const parsed = parseWineText(text, file.originalname);
          const wines = filterFoodNoise(toWineEntries(parsed));
          return res.json({
            engine: 'deterministic-fallback',
            llmError: message,
            parsed,
            wines,
            count: wines.length,
            parserVersion: WINE_PARSER_VERSION,
            acceptedInputType: isPdf ? 'pdf' : 'image'
          });
        } catch (innerErr) {
          const m2 = innerErr instanceof Error ? innerErr.message : 'Unknown parse error';
          return res.status(500).json({ error: m2, llmError: message });
        }
      }
    }

    const text = await extractTextFromUpload(
      file.buffer,
      file.originalname,
      file.mimetype
    );
    const parsed = parseWineText(text, file.originalname);
    const wines = filterFoodNoise(toWineEntries(parsed));
    return res.json({
      engine: forceDeterministic ? 'deterministic' : 'deterministic-no-key',
      parsed,
      wines,
      count: wines.length,
      parserVersion: WINE_PARSER_VERSION,
      acceptedInputType: isPdf ? 'pdf' : 'image',
      ...(llmEnabled
        ? {}
        : {
            notice:
              'OPENAI_API_KEY is not set. Configure it on the server to enable the LLM wine extractor.'
          })
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown parse error';
    return res.status(500).json({ error: message });
  }
});

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  console.log(`tablesomm-menu-parser-api listening on ${port}`);
});
