// Source: AutoTriage (danielchalmers/AutoTriage, src/llm/). Nuntia copies this folder verbatim, so change it in AutoTriage and copy it over in a paired PR.
import { withRetries } from './retry';
import { createModelFetch, MODEL_TIMEOUT_MS, requestJson, type Fetch } from './transport';
import { ModelApiError, ModelError, type CacheInfo, type Failure, type JsonRequest, type JsonResult, type ModelUsage, type TextRequest, type TextResult } from './types';

// Gemini API adapter, sending the same requests @google/genai sent before it was replaced.
// A recorded fixture of those requests is checked against every call in the tests.

// Single source of truth for the thinking budget, also stamped into run telemetry.
export const THINKING_LEVEL = 'HIGH';

const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/';
const API_VERSION = 'v1beta';

export class GeminiResponseError extends ModelError {
  constructor(message: string, failure?: Failure) {
    super(message, failure);
    this.name = 'GeminiResponseError';
  }
}

// Finish reasons that mean Gemini declined to answer, so asking again would most likely be declined too.
const REFUSAL_FINISH_REASONS = new Set(['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'IMAGE_SAFETY']);

/**
 * The model's path in request URLs, following @google/genai's rules for the Gemini API.
 * `models/` and `tunedModels/` names pass through unchanged, and any other name gets `models/` in front.
 */
export function geminiModelPath(model: string): string {
  if (!model) {
    throw new Error('model is required and must be a string');
  }
  if (model.includes('..') || model.includes('?') || model.includes('&')) {
    throw new Error('invalid model parameter');
  }
  return model.startsWith('models/') || model.startsWith('tunedModels/') ? model : `models/${model}`;
}

// A bare cache ID gets the `cachedContents/` prefix, as @google/genai added it.
function cachedContentName(name: string): string {
  return !name.startsWith('cachedContents/') && name.split('/').length === 1 ? `cachedContents/${name}` : name;
}

function userContent(text: string) {
  return { parts: [{ text }], role: 'user' };
}

/**
 * The generateContent request body.
 * Fields are added in the order @google/genai serialized them, so the body is byte-for-byte the same.
 */
export function generateContentBody(request: JsonRequest) {
  return {
    contents: [userContent(request.userPrompt)],
    // A cache already holds the system prompt.
    ...(request.cacheName
      ? { cachedContent: cachedContentName(request.cacheName) }
      : { systemInstruction: userContent(request.systemPrompt) }),
    generationConfig: {
      responseMimeType: 'application/json',
      // The caller writes the schema in this API's own dialect, so it is sent as is.
      responseSchema: request.schema,
      thinkingConfig: {
        includeThoughts: true,
        thinkingLevel: THINKING_LEVEL,
      },
    },
    ...(request.useFlexTier ? { service_tier: 'flex' } : {}),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function tokenCount(value: unknown): number {
  return typeof value === 'number' ? value : 0;
}

/**
 * The text-only generateContent request body, with no schema or thinking settings, as Nuntia sends it.
 * @google/genai sent an empty generationConfig for Nuntia's text call, so it is kept to send the same bytes.
 */
export function generateTextBody(request: TextRequest) {
  return {
    contents: [userContent(request.userPrompt)],
    systemInstruction: userContent(request.systemPrompt),
    generationConfig: {},
  };
}

/**
 * Split a generateContent response into the answer text and the model's thoughts, and read its token usage.
 * Thought parts are kept out of the answer text, so they never reach JSON.parse.
 * A blocked prompt or a refusal finish throws a refusal, and a MAX_TOKENS finish throws as truncated, before any text is read.
 */
function readReply(response: unknown): { text: string; thoughts: string; usage: ModelUsage } {
  const { blockReason, blockReasonMessage } = asRecord(asRecord(response).promptFeedback);
  // BLOCKED_REASON_UNSPECIFIED is the enum's default value, not a block.
  if (typeof blockReason === 'string' && blockReason && blockReason !== 'BLOCKED_REASON_UNSPECIFIED') {
    const detail = typeof blockReasonMessage === 'string' && blockReasonMessage ? `: ${blockReasonMessage}` : '';
    throw new GeminiResponseError(`Gemini blocked the prompt (blockReason ${blockReason})${detail}`, { kind: 'refusal' });
  }

  const candidates = asRecord(response).candidates;
  const candidate = asRecord(Array.isArray(candidates) ? candidates[0] : undefined);
  const { finishReason } = candidate;
  if (typeof finishReason === 'string' && REFUSAL_FINISH_REASONS.has(finishReason)) {
    throw new GeminiResponseError(`Gemini declined to answer (finishReason ${finishReason})`, { kind: 'refusal' });
  }
  if (finishReason === 'MAX_TOKENS') {
    throw new GeminiResponseError('Gemini stopped at the output token limit (finishReason MAX_TOKENS)', { kind: 'truncated' });
  }

  const content = asRecord(candidate.content);
  const thoughts: string[] = [];
  const textParts: string[] = [];

  for (const part of Array.isArray(content.parts) ? content.parts : []) {
    const { text, thought } = asRecord(part);
    if (typeof text === 'string') {
      if (thought) {
        thoughts.push(text);
      } else {
        textParts.push(text);
      }
    }
  }

  const text = textParts.join('');
  if (!text) {
    throw new GeminiResponseError('Gemini responded with empty text');
  }

  const collapsedThoughts = thoughts
    .join('\n')
    .replace(/(\r?\n\s*){2,}/g, '\n')
    .trim();

  // thoughtsTokenCount is the hidden thinking budget Gemini 3 spends before emitting candidates; it is billed but excluded from candidatesTokenCount, so capture it explicitly to make per-pass thinking cost measurable.
  const usage = asRecord(asRecord(response).usageMetadata);
  return {
    text,
    thoughts: collapsedThoughts,
    usage: {
      inputTokens: tokenCount(usage.promptTokenCount),
      cachedInputTokens: tokenCount(usage.cachedContentTokenCount),
      outputTokens: tokenCount(usage.candidatesTokenCount),
      thoughtsTokens: tokenCount(usage.thoughtsTokenCount),
    },
  };
}

function parseJsonResult<T>(response: unknown): JsonResult<T> {
  const { text, thoughts, usage } = readReply(response);
  let data: T;
  try {
    data = JSON.parse(text) as T;
  } catch {
    throw new GeminiResponseError('Unable to parse JSON from Gemini response');
  }
  return { data, thoughts, ...usage };
}

export class GeminiClient {
  private readonly apiKey: string;
  private readonly fetch: Fetch;
  private readonly baseUrl: string;

  constructor(apiKey: string, fetch: Fetch = createModelFetch()) {
    this.apiKey = apiKey;
    this.fetch = fetch;
    // GOOGLE_GEMINI_BASE_URL sends requests to another host, such as a proxy, as it did with @google/genai.
    const baseUrl = process.env.GOOGLE_GEMINI_BASE_URL?.trim() || DEFAULT_BASE_URL;
    this.baseUrl = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  }

  protected sleep(ms: number) {
    return new Promise<void>(resolve => setTimeout(resolve, ms));
  }

  private request(method: 'POST' | 'DELETE', path: string, body: unknown): Promise<unknown> {
    return requestJson(this.fetch, new URL(`${this.baseUrl}/${API_VERSION}/${path}`).toString(), {
      method,
      headers: {
        'content-type': 'application/json',
        // Tells the server how long this client waits, in whole seconds.
        'x-server-timeout': String(Math.ceil(MODEL_TIMEOUT_MS / 1000)),
        'x-goog-api-key': this.apiKey,
      },
      body: JSON.stringify(body),
    });
  }

  /**
   * Create a context cache for the given system prompt and model.
   * Returns the cache resource name to be used in subsequent generateContent calls.
   */
  async createCache(model: string, systemPrompt: string, displayName?: string): Promise<CacheInfo> {
    const cache = asRecord(await this.request('POST', 'cachedContents', {
      model: geminiModelPath(model),
      ttl: '3600s',
      displayName: displayName || 'autotriage-context',
      systemInstruction: userContent(systemPrompt),
    }));
    if (typeof cache.name !== 'string' || !cache.name) {
      throw new GeminiResponseError('Failed to create context cache: no name returned');
    }
    return {
      name: cache.name,
      tokenCount: tokenCount(asRecord(cache.usageMetadata).totalTokenCount),
    };
  }

  /**
   * Delete a previously created context cache.
   */
  async deleteCache(name: string): Promise<void> {
    try {
      await this.request('DELETE', cachedContentName(name), {});
    } catch {
      // Best-effort cleanup; caches expire automatically via TTL
    }
  }

  /**
   * Call the model and parse its JSON reply, retrying as withRetries describes.
   * `validate`, when given, narrows the parsed reply; a reply it rejects by throwing counts as an ordinary failure, like a parse error.
   * A 403 or 404 on a cached call fails only this call, because the cache may have expired during a long run, and that says nothing about the key or the model.
   */
  generateJson<T = unknown>(
    request: JsonRequest,
    maxRetries: number,
    initialBackoffMs: number,
    validate?: (data: unknown) => T
  ): Promise<JsonResult<T>> {
    return withRetries(async () => {
      const response = await this.request('POST', `${geminiModelPath(request.model)}:generateContent`, generateContentBody(request))
        .catch((err: unknown) => {
          if (request.cacheName && err instanceof ModelApiError && (err.status === 403 || err.status === 404)) {
            throw new ModelApiError(err.message, err.status, { failure: { kind: 'permanent' } });
          }
          throw err;
        });
      const result = parseJsonResult<T>(response);
      if (validate) result.data = validate(result.data);
      return result;
    }, maxRetries, initialBackoffMs, ms => this.sleep(ms));
  }

  /**
   * Call the model for a plain text reply, retrying as withRetries describes.
   * The answer is trimmed, and a reply with no text left is retried like an empty one.
   */
  generateText(request: TextRequest, maxRetries: number, initialBackoffMs: number): Promise<TextResult> {
    return withRetries(async () => {
      const reply = readReply(await this.request('POST', `${geminiModelPath(request.model)}:generateContent`, generateTextBody(request)));
      const text = reply.text.trim();
      if (!text) throw new GeminiResponseError('Gemini responded with empty text');
      return { text, ...reply.usage };
    }, maxRetries, initialBackoffMs, ms => this.sleep(ms));
  }
}
