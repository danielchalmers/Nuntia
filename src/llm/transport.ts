import { Agent, EnvHttpProxyAgent, fetch as undiciFetch } from 'undici';
import { ModelApiError, ModelError } from './types';

export type Fetch = typeof globalThis.fetch;

// Flex calls can take minutes to start answering, so the deadline is generous.
export const MODEL_TIMEOUT_MS = 600_000;

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

export interface ModelRequestInit {
  method: 'POST' | 'DELETE';
  headers: Record<string, string>;
  body: string;
  // 'manual' refuses redirects, so the key and the prompt can't be sent on to a host the caller didn't pick.
  redirect?: 'manual';
}

export async function requestJson(fetch: Fetch, url: string, init: ModelRequestInit, timeoutMs = MODEL_TIMEOUT_MS): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref();
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) throw await responseError(response);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

// A text error body is wrapped in the same `{"error": ...}` shape as a JSON one.
async function responseError(response: Response): Promise<Error> {
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get('location');
    // The body is never read, so it is released to free the connection.
    await response.body?.cancel();
    return new ModelError(
      `The model API redirected the request (HTTP ${response.status}${location ? ` to ${location}` : ''}), and redirects are not followed because the request carries the API key.`,
      { kind: 'permanent' }
    );
  }
  const errorBody: unknown = response.headers.get('content-type')?.includes('application/json')
    ? await response.json()
    : { error: { message: await response.text(), code: response.status, status: response.statusText } };
  const message = JSON.stringify(errorBody);
  if (response.status < 400 || response.status >= 600) return new Error(message);
  return new ModelApiError(message, response.status, { retryAfterSeconds: retryAfterSeconds(response.headers.get('retry-after')) });
}

// Only the whole-seconds form of Retry-After is read; HTTP dates and fractions are ignored, since the capacity schedule already waits at least 10s.
function retryAfterSeconds(header: string | null): number | undefined {
  return header && /^\d+$/.test(header.trim()) ? Number(header.trim()) : undefined;
}
