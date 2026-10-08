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
const MAX_RETRIES = 2;
const INITIAL_BACKOFF_MS = 5_000;
// Worst case per call: 10 + 20 + 40 + 60 + 60 + 60 = 250 seconds of waiting out an overload.
const CAPACITY_RETRIES = 6;

// Hosts that enforce response_format. Anywhere else, such as Claude's compatibility layer, the schema is also written into the prompt.
const SCHEMA_ENFORCING_HOSTS = new Set(['api.openai.com', 'generativelanguage.googleapis.com']);

// Request parameters a host may reject. Each one a host rejects is left off for the rest of the run.
type OptionalParameter = 'response_format' | 'reasoning_effort';

const BILLING_ERROR = /insufficient_quota|credit.balance|spend.limit|usage.limit/i;
const API_KEY_ERROR = /api.?key[^"]*(invalid|not valid|expired|incorrect)|(invalid|incorrect)[^"]*api.?key/i;
const CAPACITY_ERROR = /\b(UNAVAILABLE|RESOURCE_EXHAUSTED|overloaded_error)\b/;

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

function classify(status: number, body: string, keyName: string): { kind: FailureKind; hint: string } {
  if (status === 401 || status === 403 || (status === 400 && API_KEY_ERROR.test(body))) return { kind: 'fatal', hint: ` Check ${keyName}.` };
  if (status === 404) return { kind: 'fatal', hint: ' Check the model name.' };
  if (status === 402 || ((status === 400 || status === 429) && BILLING_ERROR.test(body))) return { kind: 'fatal', hint: ' Check the account\'s billing.' };
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
  if (choice.finish_reason === 'length') throw new ModelError(`${host} stopped the reply at the output token limit`, 'permanent');

  const content = Array.isArray(message.content)
    ? message.content.map(part => asRecord(part)).filter(part => part.type === 'text').map(part => String(part.text)).join('')
    : String(message.content ?? '');
  // Some open models write their reasoning into the reply, in a <think> block ahead of the answer.
  const text = content.replace(/^\s*<think>[\s\S]*?<\/think>/, '').trim();
  if (!text) throw new ModelError(`${host} responded with empty text`);

  const usage = asRecord(asRecord(response).usage);
  const reasoningTokens = count(asRecord(usage.completion_tokens_details).reasoning_tokens);
  return {
    text,
    usage: {
      inputTokens: count(usage.prompt_tokens),
      cachedInputTokens: count(asRecord(usage.prompt_tokens_details).cached_tokens),
      outputTokens: Math.max(0, count(usage.completion_tokens) - reasoningTokens),
      reasoningTokens,
    },
  };
}

// The optional parameter a rejected request names, if any.
function rejectedParameter(message: string, body: Record<string, unknown>): OptionalParameter | undefined {
  return (['response_format', 'reasoning_effort'] as const)
    .find(name => name in body && (message.includes(name) || (name === 'response_format' && message.includes('json_schema'))));
}

function schemaNote(schema: object): string {
  return [
    '=== SECTION: RESPONSE FORMAT ===',
    'This service may not enforce the response schema, so any earlier statement that the reply is decoded against an enforced schema does not apply.',
    'Return exactly one JSON object that matches this JSON Schema, with no markdown, code fences, or other text:',
    JSON.stringify(schema),
  ].join('\n');
}

/** A Chat Completions client, for OpenAI and every service with an OpenAI-compatible API. */
export class ChatClient {
  private readonly endpoint: Pick<Endpoint, 'baseUrl' | 'host' | 'apiKey' | 'keyName'>;
  private readonly fetch: Fetch;
  private readonly dropped = new Set<OptionalParameter>();

  constructor(endpoint: Pick<Endpoint, 'baseUrl' | 'host' | 'apiKey' | 'keyName'>, fetch: Fetch = createModelFetch()) {
    this.endpoint = endpoint;
    this.fetch = fetch;
  }

  protected sleep(ms: number) {
    return new Promise<void>(resolve => setTimeout(resolve, ms));
  }

  // Call the model for a JSON reply. `parse` narrows it, and a reply it rejects by throwing is retried like a malformed one.
  generateJson<T>(request: JsonRequest, parse: (data: unknown) => T): Promise<{ data: T } & Usage> {
    return this.withRetries(async () => {
      const { text, usage } = await this.complete(() => this.jsonBody(request));
      let data: unknown;
      try {
        data = JSON.parse(text.replace(/^```\w*\n([\s\S]*?)\n?```$/, '$1'));
      } catch {
        throw new ModelError(`Unable to parse JSON from the ${this.endpoint.host} response`);
      }
      return { data: parse(data), ...usage };
    });
  }

  // Call the model for a plain text reply, at its default reasoning settings.
  generateText(request: ChatRequest): Promise<{ text: string } & Usage> {
    return this.withRetries(() => this.complete(() => this.textBody(request)).then(({ text, usage }) => ({ text, ...usage })));
  }

  private textBody(request: ChatRequest): Record<string, unknown> {
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
    return {
      ...this.textBody({ ...request, userPrompt }),
      ...(this.dropped.has('response_format') ? {} : { response_format: { type: 'json_schema', json_schema: { name: 'response', strict: true, schema: request.schema } } }),
      // Matches the HIGH thinking level the passes were tuned on.
      ...(this.dropped.has('reasoning_effort') ? {} : { reasoning_effort: 'high' }),
    };
  }

  // Sends the request again at once without any optional parameter the host rejects. Each is dropped only once, so this always ends.
  private async complete(build: () => Record<string, unknown>): Promise<{ text: string; usage: Usage }> {
    for (;;) {
      const body = build();
      let response: unknown;
      try {
        response = await this.post(body);
      } catch (err) {
        const rejected = err instanceof ModelError && err.kind === 'permanent' ? rejectedParameter(err.message, body) : undefined;
        if (!rejected) throw err;
        this.dropped.add(rejected);
        console.warn(`${this.endpoint.host} rejected ${rejected}, so it is left off for the rest of the run: ${errorMessage(err)}`);
        continue;
      }
      return readReply(response, this.endpoint.host);
    }
  }

  private async post(body: Record<string, unknown>): Promise<unknown> {
    const { baseUrl, host, apiKey, keyName } = this.endpoint;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), MODEL_TIMEOUT_MS);
    timer.unref();
    try {
      const response = await this.fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
        body: JSON.stringify(body),
        // Redirects are refused, so the key and the prompt can't be sent on to a host the user didn't pick.
        redirect: 'manual',
        signal: controller.signal,
      });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        throw new ModelError(`${host} redirected the request (HTTP ${response.status}), and redirects are not followed because the request carries the API key.`, 'permanent');
      }
      if (!response.ok) {
        const text = (await response.text()).slice(0, 2000);
        const { kind, hint } = classify(response.status, text, keyName);
        const retryAfter = response.headers.get('retry-after')?.trim() ?? '';
        throw new ModelError(`${host} returned HTTP ${response.status}: ${text}${hint}`, kind, /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : 0);
      }
      return await response.json();
    } catch (err) {
      if (controller.signal.aborted) throw new ModelError(`${host} did not respond within ${MODEL_TIMEOUT_MS / 1000}s`);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  // Anything other than a ModelError, such as a network failure or a reply `parse` rejected, is retryable.
  private async withRetries<T>(attempt: () => Promise<T>): Promise<T> {
    let failures = 0;
    let capacityFailures = 0;
    for (;;) {
      try {
        return await attempt();
      } catch (err) {
        const error = err instanceof ModelError ? err : new ModelError(errorMessage(err));
        let wait: number;
        if (error.kind === 'capacity' && ++capacityFailures <= CAPACITY_RETRIES) {
          wait = Math.min(60_000, Math.max(10_000 * 2 ** (capacityFailures - 1), error.retryAfterMs));
        } else if (error.kind === 'retryable' && ++failures <= MAX_RETRIES) {
          wait = INITIAL_BACKOFF_MS * 2 ** (failures - 1);
        } else {
          throw error;
        }
        console.warn(`Model call failed (${error.kind}); retrying in ${wait / 1000}s: ${error.message}`);
        await this.sleep(wait);
      }
    }
  }
}
