import express from 'express';
import cors from 'cors';
import multer from 'multer';
import {
  extractTextFromUpload,
  filterMealDishes,
  filterParsedMenuToDishes,
  parseMenuText,
  toTableSommDishes
} from './menuParser.js';
import {
  parseWineText,
  toWineEntries,
  filterFoodNoise
} from './wineParser.js';

const WINE_PARSER_VERSION = '1.0.0';

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
    acceptedFileTypes: ['application/pdf', 'image/*']
  });
});

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'tablesomm-menu-parser-api',
    acceptedFileTypes: ['application/pdf', 'image/*']
  });
});

app.post('/parse-menu', upload.single('file'), async (req, res) => {
  try {
    const file = req.file;
    if (!file) {
      return res
        .status(400)
        .json({ error: 'Missing file upload. Use form field name "file".' });
    }

    const isPdf =
      /\.pdf$/i.test(file.originalname) || file.mimetype === 'application/pdf';
    const isImage =
      (file.mimetype?.startsWith('image/') ?? false) ||
      /\.(png|jpe?g|webp|gif|bmp|tiff?)$/i.test(file.originalname);

    if (!isPdf && !isImage) {
      return res.status(400).json({ error: 'Only PDF and image files are supported.' });
    }

    const text = await extractTextFromUpload(
      file.buffer,
      file.originalname,
      file.mimetype
    );
    const parsed = parseMenuText(text, file.originalname);
    const allDishes = toTableSommDishes(parsed);
    const dishes = filterMealDishes(allDishes);
    const filteredParsed = filterParsedMenuToDishes(parsed, dishes);

    return res.json({
      parsed: filteredParsed,
      dishes,
      count: dishes.length,
      acceptedInputType: isPdf ? 'pdf' : 'image'
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

    const isPdf =
      /\.pdf$/i.test(file.originalname) || file.mimetype === 'application/pdf';
    const isImage =
      (file.mimetype?.startsWith('image/') ?? false) ||
      /\.(png|jpe?g|webp|gif|bmp|tiff?)$/i.test(file.originalname);

    if (!isPdf && !isImage) {
      return res.status(400).json({ error: 'Only PDF and image files are supported.' });
    }

    const text = await extractTextFromUpload(
      file.buffer,
      file.originalname,
      file.mimetype
    );
    const parsed = parseWineText(text, file.originalname);
    const allWines = toWineEntries(parsed);
    const wines = filterFoodNoise(allWines);

    return res.json({
      parsed,
      wines,
      count: wines.length,
      parserVersion: WINE_PARSER_VERSION,
      acceptedInputType: isPdf ? 'pdf' : 'image'
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
