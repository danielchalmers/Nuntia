import { CAPACITY_ERROR, errorMessage } from './errors';
import { ModelApiError, ModelError, type Failure } from './types';

// Capacity errors (503 UNAVAILABLE "high demand", 429 RESOURCE_EXHAUSTED) are outages, not bad requests.
// They get a longer, capped exponential schedule than the caller's default so a temporary spike doesn't fail every item in the backlog.
// Worst case per item: 10 + 20 + 40 + 60 + 60 + 60 = 250 seconds of waiting before giving up.
export const TRANSIENT_MAX_RETRIES = 6;
export const TRANSIENT_INITIAL_BACKOFF_MS = 10_000;
export const TRANSIENT_MAX_BACKOFF_MS = 60_000;

// The capacity check for errors that kept only the JSON body in their message.
const CAPACITY_CODE = /"code"\s*:\s*(503|429)\b/;

export function failureOf(err: unknown): Failure {
  if (err instanceof ModelError) return err.failure;
  const message = errorMessage(err);
  return CAPACITY_CODE.test(message) || CAPACITY_ERROR.test(message) ? { kind: 'capacity' } : { kind: 'retryable' };
}

// Run one model call until it succeeds, its retry budget runs out, or it fails in a way no retry can fix.
export async function withRetries<T>(
  attempt: () => Promise<T>,
  maxRetries: number,
  initialBackoffMs: number,
  sleep: (ms: number) => Promise<void>
): Promise<T> {
  let ordinaryFailures = 0;
  let transientFailures = 0;
  let lastError: unknown = undefined;
  const maxOrdinaryFailures = (maxRetries | 0) + 1;
  const maxTransientFailures = TRANSIENT_MAX_RETRIES + 1;

  for (;;) {
    try {
      return await attempt();
    } catch (err) {
      lastError = err;
    }

    const { kind } = failureOf(lastError);
    let backoff: number;
    if (kind === 'capacity') {
      transientFailures++;
      if (transientFailures >= maxTransientFailures) break;
      const scheduled = TRANSIENT_INITIAL_BACKOFF_MS * Math.pow(2, transientFailures - 1);
      const requested = lastError instanceof ModelApiError ? (lastError.retryAfterSeconds ?? 0) * 1000 : 0;
      backoff = Math.min(TRANSIENT_MAX_BACKOFF_MS, Math.max(scheduled, requested));
      console.warn(`Model unavailable (attempt ${transientFailures}/${maxTransientFailures}); retrying in ${Math.round(backoff / 1000)}s: ${errorMessage(lastError)}`);
    } else if (kind === 'retryable') {
      ordinaryFailures++;
      if (ordinaryFailures >= maxOrdinaryFailures) break;
      backoff = Math.max(1, initialBackoffMs * Math.pow(2, ordinaryFailures - 1));
      // One decimal place, so the 7.5s first wait isn't logged as 8s.
      console.warn(`Model call failed (attempt ${ordinaryFailures}/${maxOrdinaryFailures}); retrying in ${Number((backoff / 1000).toFixed(1))}s: ${errorMessage(lastError)}`);
    } else {
      break;
    }
    await sleep(backoff);
  }

  throw new ModelError(errorMessage(lastError), failureOf(lastError));
}
