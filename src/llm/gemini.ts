import { withRetries } from './retry';
import { createModelFetch, MODEL_TIMEOUT_MS, requestJson, type Fetch } from './transport';
import { ModelApiError, ModelError, type CacheInfo, type Failure, type JsonRequest, type JsonResult, type ModelUsage, type TextRequest, type TextResult } from './types';

// Also stamped into run telemetry.
export const THINKING_LEVEL = 'HIGH';

const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/';
const API_VERSION = 'v1beta';

export class GeminiResponseError extends ModelError {
  constructor(message: string, failure?: Failure) {
    super(message, failure);
    this.name = 'GeminiResponseError';
  }
}

// Finish reasons that mean Gemini declined to answer.
const REFUSAL_FINISH_REASONS = new Set(['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'IMAGE_SAFETY']);

export function geminiModelPath(model: string): string {
  if (!model) {
    throw new Error('model is required and must be a string');
  }
  if (model.includes('..') || model.includes('?') || model.includes('&')) {
    throw new Error('invalid model parameter');
  }
  return model.startsWith('models/') || model.startsWith('tunedModels/') ? model : `models/${model}`;
}

function cachedContentName(name: string): string {
  return !name.startsWith('cachedContents/') && name.split('/').length === 1 ? `cachedContents/${name}` : name;
}

function userContent(text: string) {
  return { parts: [{ text }], role: 'user' };
}

export function generateContentBody(request: JsonRequest) {
  return {
    contents: [userContent(request.userPrompt)],
    // A cache already holds the system prompt.
    ...(request.cacheName
      ? { cachedContent: cachedContentName(request.cacheName) }
      : { systemInstruction: userContent(request.systemPrompt) }),
    generationConfig: {
      responseMimeType: 'application/json',
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

export function generateTextBody(request: TextRequest) {
  return {
    contents: [userContent(request.userPrompt)],
    systemInstruction: userContent(request.systemPrompt),
    generationConfig: {},
  };
}

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

  // Thinking is billed but left out of candidatesTokenCount.
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
    // GOOGLE_GEMINI_BASE_URL sends requests to another host, such as a proxy.
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

  async deleteCache(name: string): Promise<void> {
    try {
      await this.request('DELETE', cachedContentName(name), {});
    } catch {
      // Best-effort cleanup; caches expire automatically via TTL
    }
  }

  generateJson<T = unknown>(
    request: JsonRequest,
    maxRetries: number,
    initialBackoffMs: number,
    validate?: (data: unknown) => T
  ): Promise<JsonResult<T>> {
    return withRetries(async () => {
      const response = await this.request('POST', `${geminiModelPath(request.model)}:generateContent`, generateContentBody(request))
        .catch((err: unknown) => {
          // The cache may have expired during a long run, which says nothing about the key or the model.
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

  generateText(request: TextRequest, maxRetries: number, initialBackoffMs: number): Promise<TextResult> {
    return withRetries(async () => {
      const reply = readReply(await this.request('POST', `${geminiModelPath(request.model)}:generateContent`, generateTextBody(request)));
      const text = reply.text.trim();
      if (!text) throw new GeminiResponseError('Gemini responded with empty text');
      return { text, ...reply.usage };
    }, maxRetries, initialBackoffMs, ms => this.sleep(ms));
  }
}
