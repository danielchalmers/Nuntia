import { classifyApiError } from './errors';

export interface JsonRequest {
  model: string;
  systemPrompt: string;
  userPrompt: string;
  // In the Gemini API's schema dialect; the other adapters convert it with toJsonSchema.
  schema: unknown;
  // From createCache: a Gemini cache that holds the system prompt, or a marker that tells another adapter to mark the prompt for caching.
  cacheName?: string | undefined;
  // Gemini's cheaper, slower flex tier; the other adapters ignore it.
  useFlexTier?: boolean | undefined;
}

export interface TextRequest {
  model: string;
  systemPrompt: string;
  userPrompt: string;
}

/**
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

export class ModelError extends Error {
  readonly failure: Failure;

  constructor(message: string, failure: Failure = { kind: 'retryable' }) {
    super(message);
    this.name = 'ModelError';
    this.failure = failure;
  }
}

/** A non-2xx response from a model API, whose message is the error body as JSON. */
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
