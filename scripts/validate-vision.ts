/**
 * Offline validations for the meal + wine vision pipelines.
 *
 * No network or OPENAI_API_KEY is required. Each test injects a fake
 * `callVision` that records the request and returns a hard-coded JSON
 * payload, so we can assert:
 *
 *   1. `extractMenuWithVision` builds the right multimodal request
 *      (system prompt unchanged, image data URLs, page labels) and round-trips
 *      a payload into the same dish shape as the text path.
 *   2. `extractWinesWithVision` builds the right multimodal request and
 *      round-trips a wine payload, backfilling source pages.
 *   3. `pdfTextLooksEmpty` correctly flags image-only PDFs.
 *   4. The image MIME detector and data URL builder work on real PNG bytes.
 *   5. The vision JSON schema preserves the full-meal scope filter so
 *      excluded categories (raw bar, sushi, soup) are dropped from output.
 *
 * Usage: tsx scripts/validate-vision.ts
 */
import {
  extractMenuWithVision,
  buildMenuVisionUserPrompt,
  MENU_LLM_PARSER_VERSION_VISION
} from '../src/menuLlmParser.js';
import {
  extractWinesWithVision,
  buildWineVisionUserPrompt,
  WINE_LLM_PARSER_VERSION_VISION
} from '../src/wineLlmParser.js';
import {
  detectImageMime,
  imageBufferToDataUrl,
  pdfTextLooksEmpty,
  renderPdfPagesToPng,
  RenderUnavailableError
} from '../src/pdfRender.js';

let failed = 0;
let passed = 0;
function assert(cond: any, msg: string) {
  if (!cond) {
    console.error('  ✗', msg);
    failed += 1;
    process.exitCode = 1;
  } else {
    console.log('  ✓', msg);
    passed += 1;
  }
}

const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00]);
const JPEG_HEADER = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);

async function testMimeAndDataUrl() {
  console.log('detectImageMime / imageBufferToDataUrl');
  assert(detectImageMime(PNG_HEADER) === 'image/png', 'PNG magic detected as image/png');
  assert(detectImageMime(JPEG_HEADER) === 'image/jpeg', 'JPEG magic detected as image/jpeg');
  assert(
    detectImageMime(Buffer.from([0x00, 0x00, 0x00])) === 'image/png',
    'Unknown bytes fall back to PNG'
  );
  const url = imageBufferToDataUrl(PNG_HEADER);
  assert(url.startsWith('data:image/png;base64,'), 'PNG -> data URL prefix is correct');
  assert(url.includes(PNG_HEADER.toString('base64')), 'PNG bytes round-trip into the data URL');
}

function testPdfTextLooksEmpty() {
  console.log('pdfTextLooksEmpty');
  assert(pdfTextLooksEmpty([], '') === true, 'empty input is empty');
  assert(pdfTextLooksEmpty(undefined, '') === true, 'undefined pages + empty raw is empty');
  assert(pdfTextLooksEmpty(['', '   ', '\n'], '') === true, 'whitespace-only pages are empty');
  assert(pdfTextLooksEmpty(['short'], 'short') === true, 'very small text is empty');
  const realPage =
    'Wines by the Glass: Sparkling, White, Red. Cooper Mountain Pinot Gris 14.5 28. ' +
    'Stolpman Syrah 16 31. Chateauneuf-du-Pape 22 42.';
  assert(pdfTextLooksEmpty([realPage], realPage) === false, 'real wine page is not empty');
  assert(
    pdfTextLooksEmpty(['', realPage, ''], `${realPage}`) === false,
    'mixed pages with one real page is not empty'
  );
}

type CaptureVision = {
  system?: string;
  userText?: string;
  imageCount: number;
  detail?: string;
  modelEnvVar?: string;
};

async function testMenuVisionRequestConstruction() {
  console.log('extractMenuWithVision request construction');
  const captured: CaptureVision = { imageCount: 0 };
  const fakeCall = async (input: any, options: any) => {
    captured.system = input.system;
    captured.userText = input.userText;
    captured.imageCount = input.images.length;
    captured.detail = input.images[0]?.detail;
    captured.modelEnvVar = options.modelEnvVar;
    return JSON.stringify({
      source_file: 'menu.pdf',
      meal_count: 3,
      meals: [
        {
          name: 'Pan-Seared Halibut',
          category: 'Entrees',
          description: 'fennel puree, citrus salad',
          price: 46,
          protein: 'fish',
          style: 'seared'
        },
        // Excluded: raw bar — should be filtered out.
        {
          name: 'Oysters Rockefeller',
          category: 'Raw Bar',
          price: 28
        },
        // Excluded: sushi — should be filtered out.
        {
          name: 'Spicy Tuna Roll',
          category: 'Sushi',
          price: 18
        },
        {
          name: 'Filet Mignon 8oz Center Cut',
          category: 'USDA Prime Steaks',
          price: 58,
          protein: 'beef'
        }
      ]
    });
  };

  const extraction = await extractMenuWithVision({
    sourceFile: 'menu.pdf',
    images: [PNG_HEADER, PNG_HEADER],
    pageNumbers: [1, 2],
    apiKey: 'sk-fake',
    callVision: fakeCall
  });

  assert(captured.system?.startsWith('You are an expert restaurant menu parser'),
    'menu vision uses the same system prompt as the text path');
  assert(captured.userText?.includes('page-1'), 'user prompt references page-1');
  assert(captured.userText?.includes('page-2'), 'user prompt references page-2');
  assert(captured.userText?.includes('FOOD menu'), 'user prompt names the FOOD menu task');
  assert(captured.imageCount === 2, 'two images forwarded to the vision call');
  assert(captured.detail === 'high', 'vision images sent with detail=high');
  assert(captured.modelEnvVar === 'MENU_PARSER_MODEL', 'meal vision uses MENU_PARSER_MODEL');

  assert(extraction.meals.length === 2, 'raw-bar and sushi entries filtered (2 meals remain)');
  const names = extraction.meals.map((m) => m.name);
  assert(names.includes('Pan-Seared Halibut'), 'halibut entree kept');
  assert(names.includes('Filet Mignon 8oz Center Cut'), 'filet kept');
  assert(!names.some((n) => /oysters\s+rockefeller/i.test(n)), 'oysters rockefeller dropped');
  assert(!names.some((n) => /spicy\s+tuna\s+roll/i.test(n)), 'spicy tuna roll dropped');
  for (const m of extraction.meals) {
    assert(
      (m.source_pages ?? []).length > 0,
      `${m.name} has backfilled source_pages from the supplied page numbers`
    );
  }
}

async function testWineVisionRequestConstruction() {
  console.log('extractWinesWithVision request construction');
  const captured: CaptureVision = { imageCount: 0 };
  const fakeCall = async (input: any, options: any) => {
    captured.system = input.system;
    captured.userText = input.userText;
    captured.imageCount = input.images.length;
    captured.detail = input.images[0]?.detail;
    captured.modelEnvVar = options.modelEnvVar;
    return JSON.stringify({
      source_file: 'wine.pdf',
      wines: [
        {
          section: 'Wines by the Glass',
          category: 'White',
          wine: 'Cooper Mountain Pinot Gris, Willamette Valley, OR',
          vintage: '2023',
          prices: { glass: 14.5, carafe: 28 }
        },
        {
          section: 'Bottle List',
          category: 'CHARDONNAY',
          bin: '1004',
          wine: 'Gloria Ferrer Sonoma Brut, Sonoma, CA',
          vintage: 'NV',
          prices: { bottle: 66 }
        }
      ]
    });
  };

  const extraction = await extractWinesWithVision({
    sourceFile: 'wine.pdf',
    images: [PNG_HEADER],
    pageNumbers: [3],
    apiKey: 'sk-fake',
    callVision: fakeCall
  });

  assert(captured.system?.startsWith('You are an expert sommelier'),
    'wine vision reuses the wine system prompt');
  assert(captured.userText?.includes('page-3'), 'user prompt references page-3');
  assert(captured.userText?.includes('wine list'), 'user prompt names the wine task');
  assert(captured.imageCount === 1, 'one image forwarded to wine vision call');
  assert(captured.detail === 'high', 'wine vision uses detail=high');
  assert(captured.modelEnvVar === 'WINE_PARSER_MODEL', 'wine vision uses WINE_PARSER_MODEL');

  assert(extraction.wines.length === 2, 'two wines round-trip from the fake response');
  const pinot = extraction.wines.find((w) => /pinot gris/i.test(w.wine));
  assert(pinot != null, 'pinot gris record present');
  assert(pinot?.prices.glass === 14.5, 'glass price preserved');
  assert(pinot?.prices.carafe === 28, 'carafe price preserved');
  for (const w of extraction.wines) {
    assert(
      (w.source_pages ?? []).includes(3),
      `${w.wine} backfilled source page 3`
    );
  }
}

function testMenuPromptBuilder() {
  console.log('buildMenuVisionUserPrompt');
  const p = buildMenuVisionUserPrompt({
    sourceFile: 'water-grill.pdf',
    pageNumbers: [4, 5],
    imageCount: 2
  });
  assert(p.includes('Source file: water-grill.pdf'), 'menu prompt includes source file');
  assert(p.includes('page-4') && p.includes('page-5'), 'menu prompt lists both pages');
  assert(/full meal items/i.test(p), 'menu prompt names full-meal rule');
}

function testWinePromptBuilder() {
  console.log('buildWineVisionUserPrompt');
  const p = buildWineVisionUserPrompt({
    sourceFile: 'wines.pdf',
    pageNumbers: [1, 2, 3],
    imageCount: 3
  });
  assert(p.includes('Source file: wines.pdf'), 'wine prompt includes source file');
  assert(
    p.includes('page-1') && p.includes('page-2') && p.includes('page-3'),
    'wine prompt lists all three pages'
  );
  assert(/wine list/i.test(p), 'wine prompt names the wine list task');
}

async function testRenderUnavailableFallback() {
  console.log('renderPdfPagesToPng with missing binary');
  let caught: unknown = null;
  try {
    await renderPdfPagesToPng(Buffer.from([0x25, 0x50, 0x44, 0x46]), {
      binary: '/does/not/exist/pdftoppm'
    });
  } catch (err) {
    caught = err;
  }
  assert(caught instanceof RenderUnavailableError, 'missing binary throws RenderUnavailableError');
}

function testParserVersions() {
  console.log('parser version constants');
  assert(/vision/i.test(MENU_LLM_PARSER_VERSION_VISION), 'meal vision parser version mentions vision');
  assert(/vision/i.test(WINE_LLM_PARSER_VERSION_VISION), 'wine vision parser version mentions vision');
}

async function main() {
  await testMimeAndDataUrl();
  testPdfTextLooksEmpty();
  await testMenuVisionRequestConstruction();
  await testWineVisionRequestConstruction();
  testMenuPromptBuilder();
  testWinePromptBuilder();
  await testRenderUnavailableFallback();
  testParserVersions();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
