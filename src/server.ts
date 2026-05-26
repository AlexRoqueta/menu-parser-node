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
  extractWinesWithVision,
  toTableSommWines,
  WINE_LLM_PARSER_VERSION,
  WINE_LLM_PARSER_VERSION_VISION
} from './wineLlmParser.js';
import {
  extractMenuWithLlm,
  extractMenuWithVision,
  toTableSommDishes as toLlmDishes,
  MENU_LLM_PARSER_VERSION,
  MENU_LLM_PARSER_VERSION_VISION
} from './menuLlmParser.js';
import {
  RenderUnavailableError,
  pdfTextLooksEmpty,
  renderPdfPagesToPng
} from './pdfRender.js';

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
      visionVersion: WINE_LLM_PARSER_VERSION_VISION,
      llmEnabled: Boolean(process.env.OPENAI_API_KEY),
      llmModel: process.env.WINE_PARSER_MODEL ?? 'gpt-4o-mini'
    },
    menuParser: {
      llmVersion: MENU_LLM_PARSER_VERSION,
      visionVersion: MENU_LLM_PARSER_VERSION_VISION,
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
      visionVersion: WINE_LLM_PARSER_VERSION_VISION,
      llmEnabled: Boolean(process.env.OPENAI_API_KEY)
    },
    menuParser: {
      llmVersion: MENU_LLM_PARSER_VERSION,
      visionVersion: MENU_LLM_PARSER_VERSION_VISION,
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

/**
 * Try to extract per-page text from a PDF buffer; on failure fall back to the
 * existing `extractTextFromUpload` which concatenates everything into one blob.
 */
async function safeExtractPdfPages(
  buffer: Buffer,
  originalname: string,
  mimetype: string
): Promise<{ pages?: string[]; rawText: string }> {
  try {
    const pages = await extractPdfPages(buffer);
    return { pages, rawText: pages.join('\n\n') };
  } catch {
    const rawText = await extractTextFromUpload(buffer, originalname, mimetype);
    return { rawText };
  }
}

/**
 * Attempt to render a PDF buffer to PNG bytes for the vision pipeline. Returns
 * `null` when poppler / `pdftoppm` is not installed so the caller can route to
 * its text/deterministic fallback instead of returning a 500.
 */
async function tryRenderPdfPages(buffer: Buffer): Promise<Buffer[] | null> {
  try {
    return await renderPdfPagesToPng(buffer);
  } catch (err) {
    if (err instanceof RenderUnavailableError) return null;
    throw err;
  }
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
    const forceVision = req.query.engine === 'vision';

    if (llmEnabled && !forceDeterministic) {
      // Image uploads always go through the vision pipeline directly. No PDF
      // text extraction is possible on an image, and the prior code path
      // simply sent an empty `rawText` to the text LLM, which is wasteful.
      if (isImage) {
        try {
          const extraction = await extractMenuWithVision({
            sourceFile: file.originalname,
            images: [file.buffer]
          });
          const dishes = toLlmDishes(extraction);
          return res.json({
            engine: 'llm-vision',
            extraction,
            rawDishes: extraction.dishes,
            dishes,
            count: dishes.length,
            parserVersion: MENU_LLM_PARSER_VERSION_VISION,
            model: process.env.MENU_PARSER_MODEL ?? 'gpt-4o-mini',
            acceptedInputType: 'image'
          });
        } catch (llmErr) {
          const message = llmErr instanceof Error ? llmErr.message : 'LLM vision extraction failed';
          return res.status(500).json({ error: message });
        }
      }

      // PDF path: extract text first. If it's image-only (no text), route the
      // rendered page PNGs through the vision pipeline.
      const { pages, rawText } = await safeExtractPdfPages(
        file.buffer,
        file.originalname,
        file.mimetype
      );
      const imageOnlyPdf = forceVision || pdfTextLooksEmpty(pages, rawText);

      if (imageOnlyPdf) {
        const rendered = await tryRenderPdfPages(file.buffer);
        if (rendered && rendered.length > 0) {
          try {
            const extraction = await extractMenuWithVision({
              sourceFile: file.originalname,
              images: rendered,
              pageNumbers: rendered.map((_, i) => i + 1)
            });
            const dishes = toLlmDishes(extraction);
            return res.json({
              engine: 'llm-vision',
              extraction,
              rawDishes: extraction.dishes,
              dishes,
              count: dishes.length,
              parserVersion: MENU_LLM_PARSER_VERSION_VISION,
              model: process.env.MENU_PARSER_MODEL ?? 'gpt-4o-mini',
              acceptedInputType: 'pdf',
              renderedPageCount: rendered.length
            });
          } catch (llmErr) {
            const message = llmErr instanceof Error ? llmErr.message : 'LLM vision extraction failed';
            return res.status(500).json({ error: message });
          }
        }
        // Render unavailable — fall through to the existing text → deterministic
        // pipeline. The text path will produce sparse output for an image-only
        // PDF, but that matches the legacy behavior and is clearly labeled.
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
          acceptedInputType: 'pdf'
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
            acceptedInputType: 'pdf'
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
    const forceVision = req.query.engine === 'vision';

    if (llmEnabled && !forceDeterministic) {
      if (isImage) {
        try {
          const extraction = await extractWinesWithVision({
            sourceFile: file.originalname,
            images: [file.buffer]
          });
          const wines = toTableSommWines(extraction);
          return res.json({
            engine: 'llm-vision',
            extraction,
            rawWines: extraction.wines,
            wines,
            count: wines.length,
            parserVersion: WINE_LLM_PARSER_VERSION_VISION,
            model: process.env.WINE_PARSER_MODEL ?? 'gpt-4o-mini',
            acceptedInputType: 'image'
          });
        } catch (llmErr) {
          const message = llmErr instanceof Error ? llmErr.message : 'LLM vision extraction failed';
          return res.status(500).json({ error: message });
        }
      }

      const { pages, rawText } = await safeExtractPdfPages(
        file.buffer,
        file.originalname,
        file.mimetype
      );
      const imageOnlyPdf = forceVision || pdfTextLooksEmpty(pages, rawText);

      if (imageOnlyPdf) {
        const rendered = await tryRenderPdfPages(file.buffer);
        if (rendered && rendered.length > 0) {
          try {
            const extraction = await extractWinesWithVision({
              sourceFile: file.originalname,
              images: rendered,
              pageNumbers: rendered.map((_, i) => i + 1)
            });
            const wines = toTableSommWines(extraction);
            return res.json({
              engine: 'llm-vision',
              extraction,
              rawWines: extraction.wines,
              wines,
              count: wines.length,
              parserVersion: WINE_LLM_PARSER_VERSION_VISION,
              model: process.env.WINE_PARSER_MODEL ?? 'gpt-4o-mini',
              acceptedInputType: 'pdf',
              renderedPageCount: rendered.length
            });
          } catch (llmErr) {
            const message = llmErr instanceof Error ? llmErr.message : 'LLM vision extraction failed';
            return res.status(500).json({ error: message });
          }
        }
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
          acceptedInputType: 'pdf'
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
            acceptedInputType: 'pdf'
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
