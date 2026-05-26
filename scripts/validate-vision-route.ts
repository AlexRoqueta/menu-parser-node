/**
 * Server-route smoke test for the meal vision pipeline.
 *
 * We can't easily import the real Express app while overriding `extractMenuWithVision`
 * (the module is already loaded by then), so this test reproduces the routing
 * logic from `server.ts` against a fake `extractMenuWithVision` and asserts:
 *
 *   - direct image uploads route through the vision pipeline;
 *   - PDFs whose text extraction yields no usable text route through vision;
 *   - PDFs with real text continue on the text-LLM path;
 *   - when `pdftoppm` is missing, the server falls back to the text path
 *     instead of returning 500.
 *
 * Usage: tsx scripts/validate-vision-route.ts
 */
import { pdfTextLooksEmpty, RenderUnavailableError } from '../src/pdfRender.js';

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

type Engine = 'llm-vision' | 'llm' | 'deterministic-fallback' | 'deterministic';

type RouteResult = { engine: Engine; usedVision: boolean; renderedPageCount?: number };

/**
 * Mirror the meal-routing decisions in server.ts so we can exercise them
 * with mocks. Kept in sync by hand — if server.ts changes, update here.
 */
async function routeMealRequest(opts: {
  isImage: boolean;
  isPdf: boolean;
  pdfPages?: string[];
  pdfText?: string;
  forceVision?: boolean;
  llmEnabled?: boolean;
  forceDeterministic?: boolean;
  renderPdfPages: () => Promise<Buffer[]> | Buffer[];
  callMenuVision: (images: Buffer[]) => Promise<{ dishes: any[] }>;
  callMenuText: () => Promise<{ dishes: any[] }>;
}): Promise<RouteResult> {
  if (opts.llmEnabled === false) {
    return { engine: 'deterministic', usedVision: false };
  }
  if (opts.forceDeterministic) {
    return { engine: 'deterministic', usedVision: false };
  }
  if (opts.isImage) {
    await opts.callMenuVision([Buffer.from([0x89, 0x50, 0x4e, 0x47])]);
    return { engine: 'llm-vision', usedVision: true };
  }
  const imageOnly =
    opts.forceVision || pdfTextLooksEmpty(opts.pdfPages, opts.pdfText);
  if (imageOnly) {
    let rendered: Buffer[] | null;
    try {
      rendered = await opts.renderPdfPages();
    } catch (err) {
      if (err instanceof RenderUnavailableError) rendered = null;
      else throw err;
    }
    if (rendered && rendered.length > 0) {
      await opts.callMenuVision(rendered);
      return { engine: 'llm-vision', usedVision: true, renderedPageCount: rendered.length };
    }
  }
  await opts.callMenuText();
  return { engine: 'llm', usedVision: false };
}

async function testImageUploadRoutesThroughVision() {
  console.log('image upload routes through vision');
  let visionCalls = 0;
  let textCalls = 0;
  const res = await routeMealRequest({
    isImage: true,
    isPdf: false,
    renderPdfPages: async () => [],
    callMenuVision: async () => {
      visionCalls += 1;
      return { dishes: [{ name: 'Halibut' }] };
    },
    callMenuText: async () => {
      textCalls += 1;
      return { dishes: [] };
    }
  });
  assert(res.engine === 'llm-vision', 'engine is llm-vision');
  assert(res.usedVision === true, 'vision pipeline was invoked');
  assert(visionCalls === 1, 'exactly one vision call issued');
  assert(textCalls === 0, 'text path NOT invoked for image upload');
}

async function testImageOnlyPdfRoutesThroughVision() {
  console.log('image-only PDF routes through vision');
  let visionCalls = 0;
  let textCalls = 0;
  let renderCalls = 0;
  const res = await routeMealRequest({
    isImage: false,
    isPdf: true,
    pdfPages: ['', '', ''],
    pdfText: '',
    renderPdfPages: async () => {
      renderCalls += 1;
      return [Buffer.from('a'), Buffer.from('b')];
    },
    callMenuVision: async () => {
      visionCalls += 1;
      return { dishes: [{ name: 'Filet' }] };
    },
    callMenuText: async () => {
      textCalls += 1;
      return { dishes: [] };
    }
  });
  assert(res.engine === 'llm-vision', 'engine is llm-vision');
  assert(renderCalls === 1, 'PDF was rendered to PNG');
  assert(res.renderedPageCount === 2, 'two pages were rendered');
  assert(visionCalls === 1, 'one vision call issued');
  assert(textCalls === 0, 'text path NOT invoked for image-only PDF');
}

async function testTextPdfRoutesThroughTextLlm() {
  console.log('PDF with real text routes through text LLM');
  let visionCalls = 0;
  let textCalls = 0;
  let renderCalls = 0;
  const realPage =
    'Entrees: Pan-Seared Halibut 46. Cioppino 49. Filet Mignon 8oz Center Cut 58. ' +
    'Whole Fish charcoal grilled or whole crispy fried.';
  const res = await routeMealRequest({
    isImage: false,
    isPdf: true,
    pdfPages: [realPage],
    pdfText: realPage,
    renderPdfPages: async () => {
      renderCalls += 1;
      return [];
    },
    callMenuVision: async () => {
      visionCalls += 1;
      return { dishes: [] };
    },
    callMenuText: async () => {
      textCalls += 1;
      return { dishes: [{ name: 'Halibut' }] };
    }
  });
  assert(res.engine === 'llm', 'engine is llm (text path)');
  assert(visionCalls === 0, 'vision pipeline NOT invoked for text PDF');
  assert(renderCalls === 0, 'PDF NOT rendered for text PDF');
  assert(textCalls === 1, 'text LLM invoked');
}

async function testRenderUnavailableFallsBackToText() {
  console.log('render-unavailable falls back to text path');
  let visionCalls = 0;
  let textCalls = 0;
  const res = await routeMealRequest({
    isImage: false,
    isPdf: true,
    pdfPages: ['', '', ''],
    pdfText: '',
    renderPdfPages: async () => {
      throw new RenderUnavailableError('pdftoppm missing');
    },
    callMenuVision: async () => {
      visionCalls += 1;
      return { dishes: [] };
    },
    callMenuText: async () => {
      textCalls += 1;
      return { dishes: [] };
    }
  });
  assert(res.engine === 'llm', 'falls back to text engine when render is unavailable');
  assert(visionCalls === 0, 'vision NOT invoked when renderer missing');
  assert(textCalls === 1, 'text path invoked instead');
}

async function testForceDeterministic() {
  console.log('?engine=deterministic short-circuits everything');
  let visionCalls = 0;
  let textCalls = 0;
  const res = await routeMealRequest({
    isImage: true,
    isPdf: false,
    forceDeterministic: true,
    renderPdfPages: async () => [],
    callMenuVision: async () => {
      visionCalls += 1;
      return { dishes: [] };
    },
    callMenuText: async () => {
      textCalls += 1;
      return { dishes: [] };
    }
  });
  assert(res.engine === 'deterministic', 'engine is deterministic');
  assert(visionCalls === 0 && textCalls === 0, 'no LLM call when deterministic forced');
}

async function testNoApiKeyFallsBack() {
  console.log('OPENAI_API_KEY unset falls back to deterministic');
  let visionCalls = 0;
  const res = await routeMealRequest({
    isImage: true,
    isPdf: false,
    llmEnabled: false,
    renderPdfPages: async () => [],
    callMenuVision: async () => {
      visionCalls += 1;
      return { dishes: [] };
    },
    callMenuText: async () => ({ dishes: [] })
  });
  assert(res.engine === 'deterministic', 'engine is deterministic without API key');
  assert(visionCalls === 0, 'no vision call without API key');
}

async function main() {
  await testImageUploadRoutesThroughVision();
  await testImageOnlyPdfRoutesThroughVision();
  await testTextPdfRoutesThroughTextLlm();
  await testRenderUnavailableFallsBackToText();
  await testForceDeterministic();
  await testNoApiKeyFallsBack();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
