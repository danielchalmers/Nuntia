// Source: AutoTriage (danielchalmers/AutoTriage, src/llm/). Nuntia copies this folder verbatim, so change it in AutoTriage and copy it over in a paired PR.
import { withRetries } from './retry';
import { relaxSchema, toJsonSchema } from './schema';
import { createModelFetch, requestJson, type Fetch } from './transport';
import { ModelApiError, ModelError, type CacheInfo, type Failure, type JsonRequest, type JsonResult, type ModelUsage, type TextRequest, type TextResult } from './types';

// Claude Messages API adapter, one request per call and no streaming.
// Calls take seconds, and max_tokens stays under the size Anthropic's own SDKs allow without streaming.

export const ANTHROPIC_BASE_URL = 'https://api.anthropic.com';
const API_VERSION = '2023-06-01';

// Thinking counts toward this limit too, and it is still several times what triage replies have used.
const MAX_TOKENS = 20_000;

// HIGH reasoning, to match Gemini's thinking level. Haiku 5.5 and Opus 5.5 default to medium, so it is always sent.
const EFFORT = 'high';

/**
 * What createCache returns, since Claude has no cache resource to create.
 * A request that carries it marks the system prompt for caching, and the first call writes the cache.
 */
export const PROMPT_CACHE_MARKER = 'cache_control';

// Claude caches the prompt for 5 minutes by default, and gaps between pro-pass calls on a backlog run can be longer.
const CACHE_CONTROL = { type: 'ephemeral', ttl: '1h' };

// Too many optional or union parameters, or too large a grammar, such as a long label enum.
const SCHEMA_TOO_COMPLEX = /schema is too complex|too complex for compilation/i;
// Models before Claude 5.5 support only the older thinking settings, and some of them have no effort setting either.
// Which of the two the API rejects first is not documented, so either one means the model can't take the official request.
const NO_OFFICIAL_REQUEST = /adaptive thinking is not supported|does not support adaptive thinking|\beffort\b[^"]*\bnot (supported|permitted)\b|\bnot support[^"]*\beffort\b/i;

export class AnthropicResponseError extends ModelError {
  constructor(message: string, failure?: Failure) {
    super(message, failure);
    this.name = 'AnthropicResponseError';
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function tokenCount(value: unknown): number {
  return typeof value === 'number' ? value : 0;
}

function system(text: string, cached: boolean) {
  return [{ type: 'text', text, ...(cached ? { cache_control: CACHE_CONTROL } : {}) }];
}

/**
 * The Messages request body for a JSON reply.
 * Thinking is adaptive with summarized text, because Claude 5.5 models omit the thinking text unless asked.
 * Sampling settings, a prefilled reply and forced tool use are never sent, because Claude 5.5 models reject them.
 * `relaxed` sends the schema without the long enums on array items.
 */
export function jsonMessagesBody(request: JsonRequest, relaxed = false) {
  return {
    model: request.model,
    max_tokens: MAX_TOKENS,
    system: system(request.systemPrompt, Boolean(request.cacheName)),
    messages: [{ role: 'user', content: request.userPrompt }],
    thinking: { type: 'adaptive', display: 'summarized' },
    output_config: {
      effort: EFFORT,
      format: { type: 'json_schema', schema: toJsonSchema(relaxed ? relaxSchema(request.schema) : request.schema) },
    },
  };
}

/** The Messages request body for a plain text reply, with each model's default thinking and effort. */
export function textMessagesBody(request: TextRequest) {
  return {
    model: request.model,
    max_tokens: MAX_TOKENS,
    system: system(request.systemPrompt, false),
    messages: [{ role: 'user', content: request.userPrompt }],
  };
}

/**
 * Split a Messages response into the answer text and the model's thoughts, and read its token usage.
 * Thinking blocks are kept out of the answer text, so they never reach JSON.parse.
 * A refusal throws as one, with its category, and a reply cut off by the output or context limit throws as truncated, before any text is read.
 * Claude's input_tokens leaves out cached tokens and its output_tokens includes thinking, so both are rebased to the shared ModelUsage terms.
 */
function readReply(response: unknown): { text: string; thoughts: string; usage: ModelUsage } {
  const message = asRecord(response);
  const stopReason = message.stop_reason;
  if (stopReason === 'refusal') {
    const { category } = asRecord(message.stop_details);
    const detail = typeof category === 'string' && category ? `, category ${category}` : '';
    throw new AnthropicResponseError(`Claude declined to answer (stop_reason refusal${detail})`, { kind: 'refusal' });
  }
  if (stopReason === 'max_tokens') {
    throw new AnthropicResponseError('Claude stopped at the output token limit (stop_reason max_tokens)', { kind: 'truncated' });
  }
  if (stopReason === 'model_context_window_exceeded') {
    throw new AnthropicResponseError('Claude stopped at the context window limit (stop_reason model_context_window_exceeded)', { kind: 'truncated' });
  }

  const thoughts: string[] = [];
  const textParts: string[] = [];
  for (const block of Array.isArray(message.content) ? message.content : []) {
    const { type, text, thinking } = asRecord(block);
    if (type === 'thinking' && typeof thinking === 'string') {
      thoughts.push(thinking);
    } else if (type === 'text' && typeof text === 'string') {
      textParts.push(text);
    }
  }

  const text = textParts.join('');
  if (!text.trim()) {
    throw new AnthropicResponseError('Claude responded with empty text');
  }

  const usage = asRecord(message.usage);
  const cacheReadTokens = tokenCount(usage.cache_read_input_tokens);
  const cacheWriteTokens = tokenCount(usage.cache_creation_input_tokens);
  const thoughtsTokens = tokenCount(asRecord(usage.output_tokens_details).thinking_tokens);
  return {
    text,
    thoughts: thoughts.join('\n').replace(/(\r?\n\s*){2,}/g, '\n').trim(),
    usage: {
      inputTokens: tokenCount(usage.input_tokens) + cacheWriteTokens + cacheReadTokens,
      cachedInputTokens: cacheReadTokens,
      outputTokens: Math.max(0, tokenCount(usage.output_tokens) - thoughtsTokens),
      thoughtsTokens,
      cacheWriteTokens,
    },
  };
}

function parseJsonResult<T>(response: unknown): JsonResult<T> {
  const { text, thoughts, usage } = readReply(response);
  let data: T;
  try {
    data = JSON.parse(text) as T;
  } catch {
    throw new AnthropicResponseError('Unable to parse JSON from Claude response');
  }
  return { data, thoughts, ...usage };
}

export class AnthropicClient {
  private readonly apiKey: string;
  private readonly fetch: Fetch;
  private readonly baseUrl: string;
  // Set for the rest of the run once Claude rejects the full schema as too complex.
  private relaxedSchema = false;

  constructor(apiKey: string, fetch: Fetch = createModelFetch(), baseUrl = ANTHROPIC_BASE_URL) {
    this.apiKey = apiKey;
    this.fetch = fetch;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  protected sleep(ms: number) {
    return new Promise<void>(resolve => setTimeout(resolve, ms));
  }

  private request(body: unknown): Promise<unknown> {
    return requestJson(this.fetch, `${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'anthropic-version': API_VERSION,
        'x-api-key': this.apiKey,
      },
      body: JSON.stringify(body),
      redirect: 'manual',
    });
  }

  /**
   * Claude caches a marked prompt as part of an ordinary call, so there is nothing to create and no API call is made.
   * The marker it returns makes later requests mark the system prompt, and the cache writes those calls report are their own usage.
   */
  async createCache(_model: string, _systemPrompt: string, _displayName?: string): Promise<CacheInfo> {
    return { name: PROMPT_CACHE_MARKER, tokenCount: 0 };
  }

  // The cache expires on its own an hour after its last use.
  async deleteCache(_name: string): Promise<void> {}

  /**
   * Call the model and parse its JSON reply, retrying as withRetries describes.
   * `validate`, when given, narrows the parsed reply; a reply it rejects by throwing counts as an ordinary failure, like a parse error.
   * A schema rejected as too complex is sent again at once without the long enums on array items, and stays that way for the rest of the run, with one warning.
   * A model without adaptive thinking or the effort setting fails as an unusable model, since every call to it would be rejected the same way.
   */
  generateJson<T = unknown>(
    request: JsonRequest,
    maxRetries: number,
    initialBackoffMs: number,
    validate?: (data: unknown) => T
  ): Promise<JsonResult<T>> {
    return withRetries(async () => {
      const result = parseJsonResult<T>(await this.sendJson(request));
      if (validate) result.data = validate(result.data);
      return result;
    }, maxRetries, initialBackoffMs, ms => this.sleep(ms));
  }

  private async sendJson(request: JsonRequest): Promise<unknown> {
    try {
      return await this.request(jsonMessagesBody(request, this.relaxedSchema));
    } catch (err) {
      if (!(err instanceof ModelApiError) || err.status !== 400) throw err;
      if (NO_OFFICIAL_REQUEST.test(err.message)) {
        throw new ModelApiError(
          `${request.model} does not support adaptive thinking or the effort setting, which this request needs. The supported family is Claude 5.5, such as claude-haiku-5-5. ${err.message}`,
          err.status,
          { failure: { kind: 'fatal', cause: 'model' } }
        );
      }
      if (this.relaxedSchema || !SCHEMA_TOO_COMPLEX.test(err.message)) throw err;
      this.relaxedSchema = true;
      console.warn(`Claude rejected the response schema as too complex, so it is sent without the allowed values for list items (such as label names) for the rest of the run: ${err.message}`);
      return this.request(jsonMessagesBody(request, true));
    }
  }

  /**
   * Call the model for a plain text reply, retrying as withRetries describes.
   * The answer is trimmed, and its thinking is left out.
   */
  generateText(request: TextRequest, maxRetries: number, initialBackoffMs: number): Promise<TextResult> {
    return withRetries(async () => {
      const reply = readReply(await this.request(textMessagesBody(request)));
      return { text: reply.text.trim(), ...reply.usage };
    }, maxRetries, initialBackoffMs, ms => this.sleep(ms));
  }
}
