/**
 * Shared OpenAI chat-completions client used by the wine and meal-menu LLM
 * parsers. Lightweight on purpose: a single JSON-response call plus a JSON
 * parser that tolerates accidental markdown fences.
 */

export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

export type LlmCallOptions = {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
};

export async function callOpenAiJson(
  messages: ChatMessage[],
  options: LlmCallOptions & { defaultModel: string; modelEnvVar?: string }
): Promise<string> {
  const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      'OPENAI_API_KEY is not set. Configure the environment variable to enable LLM extraction.'
    );
  }
  const envModel = options.modelEnvVar ? process.env[options.modelEnvVar] : undefined;
  const model = options.model ?? envModel ?? options.defaultModel;
  const baseUrl = (options.baseUrl ?? process.env.OPENAI_BASE_URL ?? 'https://api.openai.com').replace(/\/$/, '');
  const fetchFn = options.fetchImpl ?? (globalThis as any).fetch;
  if (typeof fetchFn !== 'function') {
    throw new Error('global fetch is not available; upgrade Node to >= 18 or pass fetchImpl.');
  }

  const res = await fetchFn(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages
    })
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`OpenAI request failed: ${res.status} ${res.statusText} ${body}`.trim());
  }
  const data: any = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    throw new Error('OpenAI response did not contain message content');
  }
  return content;
}

/**
 * Multimodal counterpart to {@link callOpenAiJson}. Sends one or more images
 * (as `data:image/...;base64,...` URLs) alongside a system + text user prompt
 * to OpenAI's chat completions endpoint with `response_format=json_object`.
 *
 * Used by the wine and meal vision pipelines when the PDF carries no
 * extractable text or when the upload is itself an image.
 */
export type VisionImage = {
  /** `data:image/...;base64,...` URL or absolute https URL. */
  url: string;
  /** Optional "low" / "high" / "auto" detail hint forwarded to the API. */
  detail?: 'low' | 'high' | 'auto';
};

export type VisionPromptInput = {
  system: string;
  userText: string;
  images: VisionImage[];
};

export async function callOpenAiVisionJson(
  input: VisionPromptInput,
  options: LlmCallOptions & { defaultModel: string; modelEnvVar?: string }
): Promise<string> {
  const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      'OPENAI_API_KEY is not set. Configure the environment variable to enable LLM vision extraction.'
    );
  }
  const envModel = options.modelEnvVar ? process.env[options.modelEnvVar] : undefined;
  const model = options.model ?? envModel ?? options.defaultModel;
  const baseUrl = (options.baseUrl ?? process.env.OPENAI_BASE_URL ?? 'https://api.openai.com').replace(/\/$/, '');
  const fetchFn = options.fetchImpl ?? (globalThis as any).fetch;
  if (typeof fetchFn !== 'function') {
    throw new Error('global fetch is not available; upgrade Node to >= 18 or pass fetchImpl.');
  }

  if (!input.images || input.images.length === 0) {
    throw new Error('callOpenAiVisionJson requires at least one image');
  }

  const userContent: Array<
    | { type: 'text'; text: string }
    | { type: 'image_url'; image_url: { url: string; detail?: 'low' | 'high' | 'auto' } }
  > = [{ type: 'text', text: input.userText }];
  for (const img of input.images) {
    userContent.push({
      type: 'image_url',
      image_url: img.detail ? { url: img.url, detail: img.detail } : { url: img.url }
    });
  }

  const res = await fetchFn(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: input.system },
        { role: 'user', content: userContent }
      ]
    })
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`OpenAI vision request failed: ${res.status} ${res.statusText} ${body}`.trim());
  }
  const data: any = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    throw new Error('OpenAI vision response did not contain message content');
  }
  return content;
}

export function parseLlmJson(raw: string): unknown {
  let trimmed = raw.trim();
  if (trimmed.startsWith('```')) {
    trimmed = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
  }
  return JSON.parse(trimmed);
}

export function coerceMoney(v: unknown): number | null {
  if (v == null || v === '') return null;
  if (typeof v === 'number' && Number.isFinite(v)) return Math.round(v * 100) / 100;
  if (typeof v === 'string') {
    const cleaned = v.replace(/[^0-9.\-]/g, '');
    if (!cleaned) return null;
    const n = Number.parseFloat(cleaned);
    if (Number.isFinite(n)) return Math.round(n * 100) / 100;
  }
  return null;
}
