// Source: AutoTriage (danielchalmers/AutoTriage, src/llm/). Nuntia copies this folder verbatim, so change it in AutoTriage and copy it over in a paired PR.
import { withRetries } from './retry';
import { relaxSchema, toJsonSchema } from './schema';
import { createModelFetch, requestJson, type Fetch } from './transport';
import { ModelApiError, ModelError, type CacheInfo, type Failure, type JsonRequest, type JsonResult, type ModelUsage, type TextRequest, type TextResult } from './types';

// Chat Completions adapter for OpenAI and any OpenAI-compatible service behind OPENAI_BASE_URL, one request per call and no streaming.
// OpenAI's own API gets the official request, and a 400 never changes it, so its strict schema and HIGH reasoning are never silently dropped.
// Every other host is best effort: the reply format is spelled out in the user message too, and a parameter the host rejects is left off for the rest of the run.

export const OPENAI_BASE_URL = 'https://api.openai.com/v1';
const OFFICIAL_HOST = 'api.openai.com';
// Explicit prompt caching is documented for GPT-5.6 and later, so text calls send it only to the official GPT-6.x family, and older models keep working.
const EXPLICIT_CACHE_MODEL = /^gpt-6/i;

// Reasoning and the answer count toward this together, and it is still several times what triage replies have used.
const MAX_COMPLETION_TOKENS = 32_000;

// HIGH reasoning, to match Gemini's thinking level. It is also the one value almost every compatible host accepts.
const REASONING_EFFORT = 'high';

// The name OpenAI requires on a JSON schema response format.
const SCHEMA_NAME = 'triage_plan';

/**
 * What createCache returns on OpenAI's own API, since it has no cache resource to create.
 * A request that carries it puts a cache breakpoint at the end of the system prompt, and the first call writes the cache.
 */
export const PROMPT_CACHE_BREAKPOINT = 'prompt_cache_breakpoint';

// Thoughts end up in a hidden comment block, and the raw reasoning of some open models is far longer than GitHub allows there.
const MAX_THOUGHTS_CHARS = 20_000;

// A schema with too many or too long enum values, such as a repository's labels.
// OpenAI says "Expected at most 1000 enum values in total within a single schema", and other hosts word it their own way.
const SCHEMA_TOO_LARGE = /\b(schema|enums?)\b[\s\S]*?\b(too (large|long|complex|many)|exceed\w*|limit|at most)\b/i;

// OpenAI's codes for a parameter or value the model doesn't support, such as reasoning_effort on a model without reasoning.
const UNSUPPORTED_BY_MODEL = /^unsupported_(parameter|value)$/;

// Parameters a best-effort host may reject, in the order they are given up when an error names more than one.
// response_format steps down to JSON mode before it is left off.
const OPTIONAL_PARAMETERS = ['reasoning_effort', 'store', 'max_completion_tokens', 'response_format'] as const;
type OptionalParameter = typeof OPTIONAL_PARAMETERS[number];

type ReplyFormat = 'json_schema' | 'json_object' | 'none';

export class OpenAIResponseError extends ModelError {
  constructor(message: string, failure?: Failure) {
    super(message, failure);
    this.name = 'OpenAIResponseError';
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function tokenCount(value: unknown): number {
  return typeof value === 'number' ? value : 0;
}

/**
 * The reply format spelled out for a best-effort host, which goes at the end of the user message.
 * Many hosts accept a strict schema without enforcing it, so the reply is asked for in words as well, and it overrides any earlier word that the schema is enforced.
 */
export function responseFormatNote(schema: unknown): string {
  return [
    '=== SECTION: RESPONSE FORMAT ===',
    'This service may not enforce the response schema, so any earlier statement that the reply is decoded against an enforced schema does not apply.',
    '- Return exactly one valid JSON object that matches the JSON Schema below. Do not wrap it in markdown, comments, extra text, or code fences. Avoid trailing commas.',
    '- Include every field the schema requires, and no others.',
    '',
    'JSON Schema:',
    JSON.stringify(schema, null, 2),
  ].join('\n');
}

// Some hosts wrap JSON in a Markdown code fence even when told not to.
function withoutCodeFence(text: string): string {
  const fenced = /^\s*```[^\n]*\n([\s\S]*?)\s*(```\s*)?$/.exec(text);
  return fenced ? fenced[1]! : text;
}

function thinkingText(value: unknown): string {
  if (typeof value === 'string') return value;
  // Mistral nests the thinking in its own list of text chunks.
  return Array.isArray(value) ? value.map(chunk => asRecord(chunk).text).filter(text => typeof text === 'string').join('') : '';
}

// The `code` and `param` of an OpenAI-style error body, as strings, or empty when absent.
function errorFields(message: string): { code: string; param: string } {
  let error: Record<string, unknown>;
  try {
    error = asRecord(asRecord(JSON.parse(message)).error);
  } catch {
    error = {};
  }
  return {
    code: typeof error.code === 'string' ? error.code : '',
    param: typeof error.param === 'string' ? error.param : '',
  };
}

/**
 * The parameter a rejected request names, if it is one this adapter can leave off.
 * OpenAI-style errors name it in `param`, and other hosts only in the message text.
 */
function rejectedParameter(message: string, sent: readonly OptionalParameter[]): OptionalParameter | undefined {
  const { param } = errorFields(message);
  const text = param || message;
  return sent.find(name => new RegExp(`\\b${name}\\b`).test(text) || (name === 'response_format' && /\bjson_schema\b/.test(text)));
}

/**
 * Split a Chat Completions response into the answer text and the model's thoughts, and read its token usage.
 * A refusal or a content filter stop throws as a refusal, and a reply cut off by the token limit throws as truncated, before any text is read.
 * OpenAI returns no thoughts on this API, so its answer is never touched; compatible hosts put them in `reasoning_content`, `reasoning`, thinking parts of the content, or a leading <think> block (whose opening tag may be missing), which is kept out of the answer.
 * `prompt_tokens` already includes cached tokens and `completion_tokens` includes reasoning, which is counted on its own.
 */
function readReply(response: unknown, label: string, official: boolean): { text: string; thoughts: string; usage: ModelUsage } {
  const choices = asRecord(response).choices;
  const choice = asRecord(Array.isArray(choices) ? choices[0] : undefined);
  const message = asRecord(choice.message);
  const refusal = typeof message.refusal === 'string' ? message.refusal.trim() : '';
  if (refusal) {
    throw new OpenAIResponseError(`${label} declined to answer: ${refusal}`, { kind: 'refusal' });
  }
  if (choice.finish_reason === 'content_filter') {
    throw new OpenAIResponseError(`${label} stopped the reply with its content filter (finish_reason content_filter)`, { kind: 'refusal' });
  }
  if (choice.finish_reason === 'length') {
    throw new OpenAIResponseError(`${label} stopped at the output token limit (finish_reason length)`, { kind: 'truncated' });
  }

  const thoughts: string[] = [];
  for (const field of [message.reasoning_content, message.reasoning]) {
    if (typeof field === 'string' && field.trim()) {
      thoughts.push(field);
      break;
    }
  }
  let text = '';
  if (typeof message.content === 'string') {
    text = message.content;
  } else if (Array.isArray(message.content)) {
    for (const part of message.content) {
      const { type, text: partText, thinking } = asRecord(part);
      if (type === 'text' && typeof partText === 'string') {
        text += partText;
      } else if (type === 'thinking') {
        thoughts.push(thinkingText(thinking));
      }
    }
  }
  // Some chat templates write the opening <think> into the prompt, so the reply starts inside the block and only closes it on a line of its own.
  // That is only looked for when the host gave no reasoning field and the reply doesn't start as JSON, so a </think> quoted in an answer (release notes about reasoning models, say) is left alone.
  const think = official ? null : /^\s*<think>([\s\S]*?)<\/think>/.exec(text)
    ?? (thoughts.length > 0 || /^\s*[{[]/.test(text) ? null : /^([\s\S]*?)(?:^|\n)[ \t]*<\/think>[ \t]*(?:\r?\n|$)/.exec(text));
  if (think) {
    thoughts.push(think[1]!);
    text = text.slice(think[0].length);
  }
  if (!text.trim()) {
    throw new OpenAIResponseError(`${label} responded with empty text`);
  }

  const usage = asRecord(asRecord(response).usage);
  const promptDetails = asRecord(usage.prompt_tokens_details);
  const thoughtsTokens = tokenCount(asRecord(usage.completion_tokens_details).reasoning_tokens);
  // DeepSeek reports cache reads in its own field.
  const cachedInputTokens = typeof promptDetails.cached_tokens === 'number' ? promptDetails.cached_tokens : tokenCount(usage.prompt_cache_hit_tokens);
  return {
    text,
    thoughts: thoughts.join('\n').replace(/(\r?\n\s*){2,}/g, '\n').trim().slice(0, MAX_THOUGHTS_CHARS),
    usage: {
      inputTokens: tokenCount(usage.prompt_tokens),
      cachedInputTokens,
      outputTokens: Math.max(0, tokenCount(usage.completion_tokens) - thoughtsTokens),
      thoughtsTokens,
      cacheWriteTokens: tokenCount(promptDetails.cache_write_tokens),
    },
  };
}

export class OpenAIClient {
  private readonly apiKey: string | undefined;
  private readonly fetch: Fetch;
  private readonly url: string;
  private readonly host: string;
  // OpenAI's own API, which gets the official request; any other host is best effort.
  private readonly official: boolean;
  // Names the API in messages, since a best-effort host is not OpenAI.
  private readonly label: string;
  private hostLogged = false;
  // Set for the rest of the run once the API rejects the full schema as too large or complex.
  private relaxedSchema = false;
  // What a best-effort host turned out not to accept, kept for the rest of the run.
  private replyFormat: ReplyFormat = 'json_schema';
  private readonly dropped = new Set<OptionalParameter>();

  /**
   * `apiKey` is sent as a Bearer token, and left out when absent, as for a local server that takes no key.
   * `baseUrl` is OPENAI_BASE_URL when set, and the request goes to its /chat/completions, keeping any query string such as Azure's `?api-version=preview`.
   */
  constructor(apiKey: string | undefined, fetch: Fetch = createModelFetch(), baseUrl = OPENAI_BASE_URL) {
    this.apiKey = apiKey;
    this.fetch = fetch;
    const url = new URL(baseUrl);
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/chat/completions`;
    this.url = url.toString();
    this.host = url.host;
    this.official = this.host === OFFICIAL_HOST;
    this.label = this.official ? 'OpenAI' : this.host;
  }

  protected sleep(ms: number) {
    return new Promise<void>(resolve => setTimeout(resolve, ms));
  }

  private post(body: unknown): Promise<unknown> {
    // The host decides where the key and the issue text go, so it is always in the log.
    if (!this.hostLogged) {
      this.hostLogged = true;
      console.log(`Chat Completions requests go to ${this.host}.`);
    }
    return requestJson(this.fetch, this.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      redirect: 'manual',
    });
  }

  // The optional parameters a best-effort host hasn't rejected, in the order they are sent.
  private optionalParameters(parameters: Partial<Record<OptionalParameter, unknown>>) {
    return Object.fromEntries(Object.entries(parameters).filter(([name]) => !this.dropped.has(name as OptionalParameter)));
  }

  /**
   * The request body for a JSON reply.
   * OpenAI's own API gets a strict schema, HIGH reasoning, and explicit prompt caching, which caches nothing unless the request carries the cache marker and so places a breakpoint after the system prompt.
   * A best-effort host gets the same request without caching and with the reply format in the user message, minus anything it has rejected, and its system message is a plain string, which every host accepts.
   * The flex tier is Gemini's alone, so `useFlexTier` is ignored.
   */
  private jsonBody(request: JsonRequest) {
    const schema = toJsonSchema(this.relaxedSchema ? relaxSchema(request.schema) : request.schema);
    const strictFormat = { type: 'json_schema', json_schema: { name: SCHEMA_NAME, strict: true, schema } };
    if (this.official) {
      return {
        model: request.model,
        messages: [
          { role: 'system', content: [{ type: 'text', text: request.systemPrompt, ...(request.cacheName ? { prompt_cache_breakpoint: { mode: 'explicit' } } : {}) }] },
          { role: 'user', content: request.userPrompt },
        ],
        response_format: strictFormat,
        reasoning_effort: REASONING_EFFORT,
        store: false,
        max_completion_tokens: MAX_COMPLETION_TOKENS,
        prompt_cache_options: { mode: 'explicit' },
      };
    }
    const responseFormat = this.replyFormat === 'json_schema' ? strictFormat : { type: 'json_object' };
    return {
      model: request.model,
      messages: [
        { role: 'system', content: request.systemPrompt },
        { role: 'user', content: `${request.userPrompt.trimEnd()}\n\n${responseFormatNote(schema)}` },
      ],
      ...this.optionalParameters({
        ...(this.replyFormat === 'none' ? {} : { response_format: responseFormat }),
        reasoning_effort: REASONING_EFFORT,
        store: false,
        max_completion_tokens: MAX_COMPLETION_TOKENS,
      }),
    };
  }

  /**
   * The request body for a plain text reply, with each model's default reasoning and no token limit.
   * GPT-6.x on OpenAI's own API also gets explicit prompt caching with no breakpoint, because its default implicit mode bills a cache write for a prompt that is never reused.
   */
  private textBody(request: TextRequest) {
    return {
      model: request.model,
      messages: [
        { role: 'system', content: request.systemPrompt },
        { role: 'user', content: request.userPrompt },
      ],
      ...this.optionalParameters({ store: false }),
      ...(this.official && EXPLICIT_CACHE_MODEL.test(request.model) ? { prompt_cache_options: { mode: 'explicit' } } : {}),
    };
  }

  /**
   * Send a request, and send it again at once if it was rejected in a way a changed request can fix.
   * Each change is made once and kept for the rest of the run, so this always ends.
   * A prompt stopped by a content filter, as Azure OpenAI does with a 400, throws as a refusal.
   * A model on OpenAI's own API that rejects a parameter or value of the official request fails as an unusable model, since every call to it would be rejected the same way.
   */
  private async send(model: string, build: () => Record<string, unknown>): Promise<unknown> {
    for (;;) {
      const body = build();
      try {
        return await this.post(body);
      } catch (err) {
        if (!(err instanceof ModelApiError)) throw err;
        const { code } = errorFields(err.message);
        if (err.status === 400 && code === 'content_filter') {
          throw new ModelApiError(`${this.label} stopped the prompt with its content filter: ${err.message}`, err.status, { failure: { kind: 'refusal' } });
        }
        if (this.adapt(err, body)) continue;
        if (this.official && err.status === 400 && err.failure.kind === 'permanent' && UNSUPPORTED_BY_MODEL.test(code)) {
          throw new ModelApiError(
            `${model} does not support the official request. The supported family is GPT-6.x, such as gpt-6-luna. ${err.message}`,
            err.status,
            { failure: { kind: 'fatal', cause: 'model' } }
          );
        }
        throw err;
      }
    }
  }

  /**
   * Change later requests to get past a rejected one, and say whether anything changed.
   * A schema rejected as too large or complex loses the enums on array items, on any host.
   * On a best-effort host, a 400 or 422 that names an optional parameter leaves it off, except that a rejected strict schema first steps down to JSON mode.
   * OpenAI's own API is never changed otherwise, so its 400s fail as they are.
   * Each change is warned about once.
   */
  private adapt(err: ModelApiError, body: Record<string, unknown>): boolean {
    if (err.failure.kind !== 'permanent' || (err.status !== 400 && (this.official || err.status !== 422))) return false;
    if ('response_format' in body && !this.relaxedSchema && SCHEMA_TOO_LARGE.test(err.message)) {
      this.relaxedSchema = true;
      console.warn(`${this.label} rejected the response schema as too large or complex, so it is sent without the allowed values for list items (such as label names) for the rest of the run: ${err.message}`);
      return true;
    }
    if (this.official) return false;

    const rejected = rejectedParameter(err.message, OPTIONAL_PARAMETERS.filter(name => name in body));
    if (!rejected) return false;
    if (rejected === 'response_format' && this.replyFormat === 'json_schema') {
      this.replyFormat = 'json_object';
      console.warn(`${this.host} rejected the strict response schema, so JSON mode is used for the rest of the run, with the schema in the prompt: ${err.message}`);
    } else if (rejected === 'response_format') {
      this.replyFormat = 'none';
      console.warn(`${this.host} rejected JSON mode, so the reply format is given only in the prompt for the rest of the run: ${err.message}`);
    } else {
      this.dropped.add(rejected);
      console.warn(`${this.host} rejected ${rejected}, so it is left off for the rest of the run: ${err.message}`);
    }
    return true;
  }

  /**
   * OpenAI caches a marked prompt as part of an ordinary call, so there is nothing to create and no API call is made.
   * The marker it returns makes later requests place a cache breakpoint, and the cache writes those calls report are their own usage.
   * A best-effort host gets no caching settings, so there is no cache to offer and it returns undefined; such a host caches repeated prompts on its own, if at all.
   */
  async createCache(_model: string, _systemPrompt: string, _displayName?: string): Promise<CacheInfo | undefined> {
    return this.official ? { name: PROMPT_CACHE_BREAKPOINT, tokenCount: 0 } : undefined;
  }

  // The cache expires on its own 30 minutes after its last use.
  async deleteCache(_name: string): Promise<void> {}

  /**
   * Call the model and parse its JSON reply, retrying as withRetries describes.
   * `validate`, when given, narrows the parsed reply; a reply it rejects by throwing counts as an ordinary failure, like a parse error.
   * Requests a host rejects are changed as adapt describes, without using up a retry.
   */
  generateJson<T = unknown>(
    request: JsonRequest,
    maxRetries: number,
    initialBackoffMs: number,
    validate?: (data: unknown) => T
  ): Promise<JsonResult<T>> {
    return withRetries(async () => {
      const { text, thoughts, usage } = readReply(await this.send(request.model, () => this.jsonBody(request)), this.label, this.official);
      let data: T;
      try {
        data = JSON.parse(this.official ? text : withoutCodeFence(text)) as T;
      } catch {
        throw new OpenAIResponseError(`Unable to parse JSON from ${this.label} response`);
      }
      return { data: validate ? validate(data) : data, thoughts, ...usage };
    }, maxRetries, initialBackoffMs, ms => this.sleep(ms));
  }

  /**
   * Call the model for a plain text reply, retrying as withRetries describes.
   * The answer is trimmed, and its thoughts are left out.
   */
  generateText(request: TextRequest, maxRetries: number, initialBackoffMs: number): Promise<TextResult> {
    return withRetries(async () => {
      const reply = readReply(await this.send(request.model, () => this.textBody(request)), this.label, this.official);
      return { text: reply.text.trim(), ...reply.usage };
    }, maxRetries, initialBackoffMs, ms => this.sleep(ms));
  }
}
