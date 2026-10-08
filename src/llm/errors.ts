// Source: AutoTriage (danielchalmers/AutoTriage, src/llm/). Nuntia copies this folder verbatim, so change it in AutoTriage and copy it over in a paired PR.
import type { Failure } from './types';

// Error text helpers and the failure taxonomy for model calls.
// Kept here rather than in a shared util module so src/llm/ imports nothing from outside itself.
// This file imports only types, so util.ts can re-export errorMessage without a cycle.

// Message-only form, for warnings where a stack would be noise.
// Network failures carry their code on the cause (fetch only says "fetch failed"), so it is appended when present.
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message + causeCode(error) : String(error);
}

function causeCode(error: Error): string {
  const cause = 'cause' in error ? error.cause : undefined;
  return typeof cause === 'object' && cause !== null && 'code' in cause && typeof cause.code === 'string' ? ` (${cause.code})` : '';
}

// Billing and spend-limit errors look like rate limits (OpenAI sends a 429 with insufficient_quota, Anthropic a 400 about usage limits), but they keep failing until someone pays.
// Gemini's per-day quota 429s are left out until a real QuotaFailure body is captured, so they stay capacity errors.
const BILLING_ERROR = /insufficient_quota|credit.balance|spend.limit|usage.limit/i;
// Gemini answers a bad key with a 400 rather than a 401.
const API_KEY_ERROR = /api.?key/i;
const INVALID_KEY_ERROR = /invalid|not valid|expired|incorrect/i;
// Gemini's capacity statuses count wherever they appear, as they did before this taxonomy, and so does Anthropic's overload type.
export const CAPACITY_ERROR = /\b(UNAVAILABLE|RESOURCE_EXHAUSTED|overloaded_error)\b/;

/**
 * The failure an error response stands for, read from its status and body the same way for every provider.
 * 401 and 403 mean the key, 404 the model, and 402 or a billing body the account, and all of them are fatal.
 * 429, 503, 529, and capacity bodies are capacity errors, 408, 409 and other 5xx are retryable, and anything else is permanent.
 */
export function classifyApiError(status: number, body: string): Failure {
  if (status === 401 || status === 403) return { kind: 'fatal', cause: 'auth' };
  if (status === 404) return { kind: 'fatal', cause: 'model' };
  if (status === 402 || ((status === 400 || status === 429) && BILLING_ERROR.test(body))) return { kind: 'fatal', cause: 'quota' };
  if (status === 400 && API_KEY_ERROR.test(body) && INVALID_KEY_ERROR.test(body)) return { kind: 'fatal', cause: 'auth' };
  if (status === 429 || status === 503 || status === 529 || CAPACITY_ERROR.test(body)) return { kind: 'capacity' };
  // A request timeout or a conflict (Gemini's ABORTED) can succeed when sent again unchanged.
  return status >= 500 || status === 408 || status === 409 ? { kind: 'retryable' } : { kind: 'permanent' };
}

