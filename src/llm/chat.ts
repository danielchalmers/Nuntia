import { Agent, EnvHttpProxyAgent, fetch as undiciFetch } from 'undici';
import type { Endpoint } from './endpoint';

export type Fetch = typeof globalThis.fetch;

/**
 * Why a model call failed.
 * Capacity errors (overload, rate limits) are waited out, retryable ones are retried a couple of times, permanent ones fail the call, and fatal ones (a bad key, an unknown model, no credit) would fail every later call too.
 */
export type FailureKind = 'capacity' | 'retryable' | 'permanent' | 'fatal';

export class ModelError extends Error {
  readonly kind: FailureKind;
  readonly retryAfterMs: number;

  constructor(message: string, kind: FailureKind = 'retryable', retryAfterMs = 0) {
    super(message);
    this.name = 'ModelError';
    this.kind = kind;
    this.retryAfterMs = retryAfterMs;
  }
}

export interface ChatRequest {
  model: string;
  systemPrompt: string;
  userPrompt: string;
}

export interface JsonRequest extends ChatRequest {
  // A strict JSON Schema for the reply.
  schema: object;
}

// `outputTokens` leaves out the reasoning counted in `reasoningTokens`.
export interface Usage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
}

export const MODEL_TIMEOUT_MS = 600_000;
// One limit for a whole call, counting every attempt and the waits between them, since retrying hung requests could otherwise take over 90 minutes.
export const CALL_DEADLINE_MS = 900_000;
// How often the log notes a request that is still waiting for a reply.
export const HEARTBEAT_MS = 60_000;
const MAX_RETRIES = 2;
const INITIAL_BACKOFF_MS = 5_000;
// Worst case per call: 10 + 20 + 40 + 60 + 60 + 60 = 250 seconds of waiting out an overload.
const CAPACITY_RETRIES = 6;

// Claude is called through its own Messages API, because its Chat Completions layer ignores reasoning_effort and so leaves Haiku at medium effort.
const CLAUDE_HOST = 'api.anthropic.com';
const CLAUDE_API_VERSION = '2026-10-21';
const CLAUDE_EFFORT = 'xhigh';
// The Messages API requires a limit, and at xhigh a lower one can cut the reply off partway through the reasoning.
const CLAUDE_MAX_TOKENS = 64_000;

// Hosts that enforce response_format, so the schema isn't also written into the prompt.
// Claude enforces its schema too but still gets the schema note, which the prompts were measured with: in a MudBlazor dry run at medium effort, Haiku caught 82% of the due inactivity actions with the note and 36–42% without it.
const SCHEMA_ENFORCING_HOSTS = new Set(['api.openai.com', 'generativelanguage.googleapis.com']);
const BUILT_IN_HOSTS = new Set([...SCHEMA_ENFORCING_HOSTS, CLAUDE_HOST]);

// Request parameters a host may reject. Each one a host rejects is left off for the rest of the run.
// `effort` is Claude's, inside output_config, and older Claude models reject it.
const OPTIONAL_PARAMETERS = ['response_format', 'reasoning_effort', 'effort'] as const;
type OptionalParameter = typeof OPTIONAL_PARAMETERS[number];

const BILLING_ERROR = /insufficient_quota|credit.balance|spend.limit|usage.limit/i;
// Gemini answers a bad key with a 400 rather than a 401, worded differently by each of its APIs.
const API_KEY_ERROR = /api.?key/i;
const CAPACITY_ERROR = /\b(UNAVAILABLE|RESOURCE_EXHAUSTED|overloaded_error)\b/;
// A daily quota, such as the 500 requests a day of Gemini's free tier, resets hours later, so waiting it out like an overload only delays the warning.
const DAILY_QUOTA_ERROR = /PerDay|per day|\b(RPD|TPD)\b/i;
// OpenRouter refuses a flagged prompt with a 403, which is about the item rather than the key.
const MODERATION_ERROR = /moderation|flagged|guardrail/i;

// Message-only form, for warnings where a stack would be noise.
// Network failures carry their code on the cause (fetch only says "fetch failed"), so it is appended when present.
export function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = 'cause' in error ? error.cause : undefined;
  const code = typeof cause === 'object' && cause !== null && 'code' in cause && typeof cause.code === 'string' ? ` (${cause.code})` : '';
  return error.message + code;
}

/**
 * undici's own fetch, because Node's built-in fetch gives up on any response whose headers take longer than 300s, whatever the AbortSignal.
 * The dispatcher's timers are off by default so MODEL_TIMEOUT_MS is the only deadline, and it is passed per request so GitHub API traffic is unchanged.
 * EnvHttpProxyAgent keeps the built-in fetch's proxy support under NODE_USE_ENV_PROXY=1.
 */
export function createModelFetch(dispatcherTimeoutMs = 0): Fetch {
  const options = { headersTimeout: dispatcherTimeoutMs, bodyTimeout: dispatcherTimeoutMs };
  const dispatcher = process.env.NODE_USE_ENV_PROXY === '1' ? new EnvHttpProxyAgent(options) : new Agent(options);
  const modelFetch: typeof undiciFetch = (input, init) => undiciFetch(input, { ...init, dispatcher });
  // undici's types come from a different release than Node's built-in fetch types, so TypeScript cannot match them even though the API is the same.
  return modelFetch as Fetch;
}

// The reasoning a JSON call gets on a host, as the startup log states it. A host outside the built-in ones may or may not honor reasoning_effort.
export function describeReasoning(host: string): string {
  if (host === CLAUDE_HOST) return `reasoning: ${CLAUDE_EFFORT}`;
  return BUILT_IN_HOSTS.has(host) ? 'reasoning: high' : `reasoning: high if ${host} honors reasoning_effort`;
}

function classify(status: number, body: string, endpoint: Pick<Endpoint, 'host' | 'keyName'>): { kind: FailureKind; hint: string } {
  if (status === 403 && MODERATION_ERROR.test(body)) return { kind: 'permanent', hint: '' };
  if (status === 401 || status === 403 || (status === 400 && API_KEY_ERROR.test(body))) return { kind: 'fatal', hint: ` Check ${endpoint.keyName}.` };
  if (status === 404) return { kind: 'fatal', hint: BUILT_IN_HOSTS.has(endpoint.host) ? ' Check the model name.' : ' Check the model name and the OPENAI_BASE_URL path.' };
  if (status === 402 || ((status === 400 || status === 429) && BILLING_ERROR.test(body))) return { kind: 'fatal', hint: ' Check the account\'s billing.' };
  if (status === 429 && DAILY_QUOTA_ERROR.test(body)) return { kind: 'permanent', hint: ' The daily quota is used up.' };
  if (status === 429 || status === 503 || status === 529 || CAPACITY_ERROR.test(body)) return { kind: 'capacity', hint: '' };
  // A request timeout or a conflict can succeed when sent again unchanged.
  return { kind: status >= 500 || status === 408 || status === 409 ? 'retryable' : 'permanent', hint: '' };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function count(value: unknown): number {
  return typeof value === 'number' ? value : 0;
}

function readReply(response: unknown, host: string): { text: string; usage: Usage } {
  const choices = asRecord(response).choices;
  const choice = asRecord(Array.isArray(choices) ? choices[0] : undefined);
  const message = asRecord(choice.message);
  if (typeof message.refusal === 'string' && message.refusal.trim()) {
    throw new ModelError(`${host} declined to answer: ${message.refusal.trim()}`, 'permanent');
  }
  if (choice.finish_reason === 'content_filter') throw new ModelError(`${host} stopped the reply with its content filter`, 'permanent');
  // OpenRouter answers for a provider that failed partway through with a 200 that carries an error, and the text so far would otherwise pass as the reply.
  const failure = asRecord(response).error ?? choice.error;
  if (failure != null || choice.finish_reason === 'error') throw new ModelError(`${host} failed partway through the reply: ${JSON.stringify(failure ?? choice.finish_reason)}`);
  if (choice.finish_reason === 'length') throw new ModelError(`${host} stopped the reply at the output token limit`, 'permanent');

  const content = Array.isArray(message.content)
    ? message.content.map(part => asRecord(part)).filter(part => part.type === 'text').map(part => String(part.text)).join('')
    : String(message.content ?? '');
  // Some open models write their reasoning into the reply, in a <think> block ahead of the answer.
  const text = content.replace(/^\s*<think>[\s\S]*?<\/think>/, '').trim();
  if (!text) throw new ModelError(`${host} responded with empty text`);

  const usage = asRecord(asRecord(response).usage);
  const completion = count(usage.completion_tokens);
  // OpenAI counts reasoning inside completion_tokens and breaks it out. Gemini and some others leave it out of completion_tokens, so only total_tokens includes it.
  const uncounted = Math.max(0, count(usage.total_tokens) - count(usage.prompt_tokens) - completion);
  const reported = asRecord(usage.completion_tokens_details).reasoning_tokens;
  const reasoningTokens = typeof reported === 'number' ? reported : uncounted;
  return {
    text,
    usage: {
      inputTokens: count(usage.prompt_tokens),
      cachedInputTokens: count(asRecord(usage.prompt_tokens_details).cached_tokens),
      outputTokens: uncounted > 0 ? completion : Math.max(0, completion - reasoningTokens),
      reasoningTokens,
    },
  };
}

// A Messages API reply, whose text comes in blocks alongside the thinking blocks.
function readClaudeReply(response: unknown, host: string): { text: string; usage: Usage } {
  const message = asRecord(response);
  if (message.stop_reason === 'refusal') {
    const explanation = asRecord(message.stop_details).explanation;
    throw new ModelError(`${host} declined to answer${typeof explanation === 'string' && explanation.trim() ? `: ${explanation.trim()}` : ''}`, 'permanent');
  }
  if (message.stop_reason === 'max_tokens') throw new ModelError(`${host} stopped the reply at the output token limit`, 'permanent');

  const blocks = Array.isArray(message.content) ? message.content : [];
  const text = blocks.map(block => asRecord(block)).filter(block => block.type === 'text').map(block => String(block.text)).join('').trim();
  if (!text) throw new ModelError(`${host} responded with empty text`);

  const usage = asRecord(message.usage);
  const cachedInputTokens = count(usage.cache_read_input_tokens);
  // output_tokens includes the thinking, which is broken out only on some replies.
  const reasoningTokens = count(asRecord(usage.output_tokens_details).thinking_tokens);
  return {
    text,
    usage: {
      // input_tokens leaves out what was read from or written to the cache.
      inputTokens: count(usage.input_tokens) + cachedInputTokens + count(usage.cache_creation_input_tokens),
      cachedInputTokens,
      outputTokens: Math.max(0, count(usage.output_tokens) - reasoningTokens),
      reasoningTokens,
    },
  };
}

// The optional parameter a rejected request names, if any: in the error's `param` field when it has one, as OpenAI-style errors do, or else anywhere in its text.
function rejectedParameter(message: string, body: Record<string, unknown>): OptionalParameter | undefined {
  const text = /"param"\s*:\s*"([^"]+)"/.exec(message)?.[1] ?? message;
  return OPTIONAL_PARAMETERS.find(name => {
    if (name === 'effort') return 'effort' in asRecord(body.output_config) && text.includes(name);
    return name in body && (text.includes(name) || (name === 'response_format' && text.includes('json_schema')));
  });
}

function schemaNote(schema: object): string {
  return [
    '=== SECTION: RESPONSE FORMAT ===',
    'This service may not enforce the response schema, so any earlier statement that the reply is decoded against an enforced schema does not apply.',
    'Return exactly one JSON object that matches this JSON Schema, with no markdown, code fences, or other text:',
    JSON.stringify(schema),
  ].join('\n');
}

/** A Chat Completions client, for OpenAI and every service with an OpenAI-compatible API, which calls Claude through its Messages API. */
export class ChatClient {
  private readonly endpoint: Pick<Endpoint, 'baseUrl' | 'host' | 'apiKey' | 'keyName'>;
  private readonly fetch: Fetch;
  private readonly dropped = new Set<OptionalParameter>();

  constructor(endpoint: Pick<Endpoint, 'baseUrl' | 'host' | 'apiKey' | 'keyName'>, fetch: Fetch = createModelFetch()) {
    this.endpoint = endpoint;
    this.fetch = fetch;
  }

  private get claude(): boolean {
    return this.endpoint.host === CLAUDE_HOST;
  }

  // Ends early when the call's deadline passes.
  protected sleep(ms: number, deadline: AbortSignal) {
    return new Promise<void>(resolve => {
      const done = () => {
        clearTimeout(timer);
        deadline.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      deadline.addEventListener('abort', done);
    });
  }

  // Call the model for a JSON reply. `parse` narrows it, and a reply it rejects by throwing is retried like a malformed one.
  generateJson<T>(request: JsonRequest, parse: (data: unknown) => T): Promise<{ data: T } & Usage> {
    return this.withRetries(async deadline => {
      const { text, usage } = await this.complete(() => this.jsonBody(request), deadline);
      let data: unknown;
      try {
        data = JSON.parse(text.replace(/^```\w*\n([\s\S]*?)\n?```$/, '$1'));
      } catch {
        throw new ModelError(`Unable to parse JSON from the ${this.endpoint.host} response`);
      }
      return { data: parse(data), ...usage };
    });
  }

  // Call the model for a plain text reply, at its default reasoning settings, except that Claude gets the effort a JSON call gets, because Haiku's default is medium.
  generateText(request: ChatRequest): Promise<{ text: string } & Usage> {
    return this.withRetries(deadline => this.complete(() => this.textBody(request), deadline).then(({ text, usage }) => ({ text, ...usage })));
  }

  private textBody(request: ChatRequest): Record<string, unknown> {
    if (this.claude) {
      return {
        model: request.model,
        max_tokens: CLAUDE_MAX_TOKENS,
        ...(request.systemPrompt ? { system: request.systemPrompt } : {}),
        messages: [{ role: 'user', content: request.userPrompt }],
        ...(this.dropped.has('effort') ? {} : { output_config: { effort: CLAUDE_EFFORT } }),
      };
    }
    return {
      model: request.model,
      messages: [
        { role: 'system', content: request.systemPrompt },
        { role: 'user', content: request.userPrompt },
      ],
    };
  }

  private jsonBody(request: JsonRequest): Record<string, unknown> {
    const enforced = SCHEMA_ENFORCING_HOSTS.has(this.endpoint.host) && !this.dropped.has('response_format');
    const userPrompt = enforced ? request.userPrompt : `${request.userPrompt.trimEnd()}\n\n${schemaNote(request.schema)}`;
    if (this.claude) {
      return {
        ...this.textBody({ ...request, userPrompt }),
        output_config: {
          format: { type: 'json_schema', schema: request.schema },
          ...(this.dropped.has('effort') ? {} : { effort: CLAUDE_EFFORT }),
        },
      };
    }
    return {
      ...this.textBody({ ...request, userPrompt }),
      ...(this.dropped.has('response_format') ? {} : { response_format: { type: 'json_schema', json_schema: { name: 'response', strict: true, schema: request.schema } } }),
      // Matches the HIGH thinking level the prompts were tuned on.
      ...(this.dropped.has('reasoning_effort') ? {} : { reasoning_effort: 'high' }),
    };
  }

  // Sends the request again at once without any optional parameter the host rejects. Each is dropped only once, so this always ends.
  private async complete(build: () => Record<string, unknown>, deadline: AbortSignal): Promise<{ text: string; usage: Usage }> {
    for (;;) {
      const body = build();
      let response: unknown;
      try {
        response = await this.post(body, deadline);
      } catch (err) {
        const rejected = err instanceof ModelError && err.kind === 'permanent' ? rejectedParameter(err.message, body) : undefined;
        if (!rejected) throw err;
        this.dropped.add(rejected);
        console.warn(`${this.endpoint.host} rejected ${rejected}, so it is left off for the rest of the run: ${errorMessage(err)}`);
        continue;
      }
      return this.claude ? readClaudeReply(response, this.endpoint.host) : readReply(response, this.endpoint.host);
    }
  }

  private async post(body: Record<string, unknown>, deadline: AbortSignal): Promise<unknown> {
    const { baseUrl, host, apiKey } = this.endpoint;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), MODEL_TIMEOUT_MS);
    timer.unref();
    let beats = 0;
    const heartbeat = setInterval(() => console.log(`Still waiting for ${host} after ${++beats * HEARTBEAT_MS / 60_000} min...`), HEARTBEAT_MS);
    heartbeat.unref();
    try {
      const response = await this.fetch(`${baseUrl}/${this.claude ? 'messages' : 'chat/completions'}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.claude ? { 'anthropic-version': CLAUDE_API_VERSION, ...(apiKey ? { 'x-api-key': apiKey } : {}) } : apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        // Redirects are refused, so the key and the prompt can't be sent on to a host the user didn't pick.
        redirect: 'manual',
        signal: AbortSignal.any([controller.signal, deadline]),
      });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        throw new ModelError(`${host} redirected the request (HTTP ${response.status}), and redirects are not followed because the request carries the API key.`, 'permanent');
      }
      if (!response.ok) {
        // OpenAI pretty-prints its error bodies, and a log annotation reads better on one line.
        const text = (await response.text()).replace(/\s+/g, ' ').trim().slice(0, 2000);
        const { kind, hint } = classify(response.status, text, this.endpoint);
        const retryAfter = response.headers.get('retry-after')?.trim() ?? '';
        throw new ModelError(`${host} returned HTTP ${response.status}: ${text}${hint}`, kind, /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : 0);
      }
      return await response.json();
    } catch (err) {
      if (controller.signal.aborted) throw new ModelError(`${host} did not respond within ${MODEL_TIMEOUT_MS / 1000}s`);
      throw err;
    } finally {
      clearTimeout(timer);
      clearInterval(heartbeat);
    }
  }

  /**
   * Anything other than a ModelError, such as a network failure or a reply `parse` rejected, is retryable.
   * Past CALL_DEADLINE_MS the call fails as retryable whatever it was doing, because a later call may well get through.
   */
  private async withRetries<T>(attempt: (deadline: AbortSignal) => Promise<T>): Promise<T> {
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), CALL_DEADLINE_MS);
    timer.unref();
    let attempts = 0;
    let failures = 0;
    let capacityFailures = 0;
    let lastError: ModelError | undefined;
    const expired = () => {
      const last = lastError ? ` The last failure was: ${lastError.message}` : '';
      return new ModelError(`${this.endpoint.host} gave no usable reply within the ${CALL_DEADLINE_MS / 60_000}-minute limit for a call, after ${attempts} attempt${attempts === 1 ? '' : 's'}.${last}`);
    };
    try {
      for (;;) {
        try {
          attempts++;
          return await attempt(deadline.signal);
        } catch (err) {
          if (deadline.signal.aborted) throw expired();
          const error = err instanceof ModelError ? err : new ModelError(errorMessage(err));
          let wait: number;
          if (error.kind === 'capacity' && ++capacityFailures <= CAPACITY_RETRIES) {
            wait = Math.min(60_000, Math.max(10_000 * 2 ** (capacityFailures - 1), error.retryAfterMs));
          } else if (error.kind === 'retryable' && ++failures <= MAX_RETRIES) {
            wait = INITIAL_BACKOFF_MS * 2 ** (failures - 1);
          } else {
            throw error;
          }
          lastError = error;
          console.warn(`Model call failed (${error.kind}); retrying in ${wait / 1000}s: ${error.message}`);
          await this.sleep(wait, deadline.signal);
          if (deadline.signal.aborted) throw expired();
        }
      }
    } finally {
      clearTimeout(timer);
    }
  }
}
