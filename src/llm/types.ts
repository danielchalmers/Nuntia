// Source: AutoTriage (danielchalmers/AutoTriage, src/llm/). Nuntia copies this folder verbatim, so change it in AutoTriage and copy it over in a paired PR.
import { classifyApiError } from './errors';

// Provider-neutral shapes shared by the model adapters and the code that calls them.

/** One call for a JSON reply that follows a response schema. */
export interface JsonRequest {
  model: string;
  systemPrompt: string;
  userPrompt: string;
  // Written in the Gemini API's schema dialect by the caller; other adapters convert it with toJsonSchema.
  schema: unknown;
  // The context the system prompt is cached under, from createCache: a Gemini cache that already holds the prompt, or a marker that tells the Claude adapter to mark the prompt for caching.
  cacheName?: string | undefined;
  // Gemini's cheaper, slower flex tier, used alongside the cache on backlog runs.
  useFlexTier?: boolean | undefined;
}

/** One call for a plain text reply, with no schema and the provider's default reasoning settings. */
export interface TextRequest {
  model: string;
  systemPrompt: string;
  userPrompt: string;
}

/**
 * What a call cost, in the same terms for every provider.
 * `inputTokens` is the whole prompt, cached tokens included, and `outputTokens` leaves out the thinking counted in `thoughtsTokens`.
 * `cacheWriteTokens` is set only by providers that bill for writing the prompt cache during the call, such as Claude.
 */
export interface ModelUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  thoughtsTokens: number;
  cacheWriteTokens?: number;
}

export interface JsonResult<T> extends ModelUsage {
  data: T;
  thoughts: string;
}

// The answer text alone, with any thoughts or reasoning left out.
export interface TextResult extends ModelUsage {
  text: string;
}

export interface CacheInfo {
  name: string;
  tokenCount: number;
}

/**
 * Why a model call failed, which decides whether it is retried and what happens to the run.
 * - `capacity`: the provider is overloaded or rate limited, so the call waits it out on the long schedule.
 * - `retryable`: a server error, network failure, or unusable reply, retried on the caller's budget.
 * - `permanent`: the API rejected this request, so sending it again unchanged would fail the same way.
 * - `truncated`: the reply stopped at the output token limit.
 * - `refusal`: the model declined to answer.
 * - `fatal`: no later call can succeed either, so the run stops. `cause` says whether the API key, the model name, or the account's billing is at fault.
 */
export type Failure =
  | { kind: 'capacity' | 'retryable' | 'permanent' | 'truncated' | 'refusal' }
  | { kind: 'fatal'; cause: FatalCause };

export type FailureKind = Failure['kind'];
export type FatalCause = 'auth' | 'model' | 'quota';

/** A model call that failed for good, or a reply that could not be used. Its message stands on its own in a log line. */
export class ModelError extends Error {
  readonly failure: Failure;

  constructor(message: string, failure: Failure = { kind: 'retryable' }) {
    super(message);
    this.name = 'ModelError';
    this.failure = failure;
  }
}

/**
 * A non-2xx response from a model API. The message is the error body as JSON, as @google/genai's ApiError built it.
 * Its failure comes from classifyApiError unless the adapter knows better.
 * `retryAfterSeconds` is the response's Retry-After header when it is a whole number of seconds.
 */
export class ModelApiError extends ModelError {
  readonly status: number;
  readonly retryAfterSeconds: number | undefined;

  constructor(message: string, status: number, options: { failure?: Failure; retryAfterSeconds?: number | undefined } = {}) {
    super(message, options.failure ?? classifyApiError(status, message));
    this.name = 'ModelApiError';
    this.status = status;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}
