import { ApiError, BlockedReason, FinishReason, GenerateContentResponse, GoogleGenAI, type Fetch, type GenerateContentParameters } from '@google/genai';
import { Agent, EnvHttpProxyAgent, fetch, type Dispatcher, type RequestInit as UndiciRequestInit } from 'undici';

// Deadline for each Gemini attempt. Large releases on slower models can take minutes before Gemini sends any response headers.
const REQUEST_TIMEOUT_MS = 600_000;

export function buildTextPayload(
  systemPrompt: string,
  userPrompt: string,
  model: string
): GenerateContentParameters {
  // No temperature is set: Gemini 3 models are tuned for their default and can degrade when it is overridden, so we let the API use the model default.
  const config: NonNullable<GenerateContentParameters['config']> = {
    systemInstruction: systemPrompt,
  };

  return {
    model,
    contents: [
      {
        role: 'user',
        parts: [{ text: userPrompt }],
      },
    ],
    config,
  };
}

export class GeminiResponseError extends Error {
  constructor(message: string, readonly retryable = false) {
    super(message);
    this.name = 'GeminiResponseError';
  }
}

// Finish reasons where Gemini deterministically refused this exact content, so resending the same payload can never succeed.
const BLOCKING_FINISH_REASONS = new Set<FinishReason>([
  FinishReason.SAFETY,
  FinishReason.RECITATION,
  FinishReason.BLOCKLIST,
  FinishReason.PROHIBITED_CONTENT,
  FinishReason.SPII,
  FinishReason.IMAGE_SAFETY,
]);

function httpStatusOf(err: unknown): number | undefined {
  if (err instanceof ApiError) return err.status;
  // Fallback for error shapes from other SDK layers that carry an HTTP status without being an ApiError.
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : undefined;
}

// fetch reports every network failure as "fetch failed" and keeps the real reason (e.g. UND_ERR_HEADERS_TIMEOUT) on its cause.
function causeCodeOf(err: unknown): string | undefined {
  const code = (err as { cause?: { code?: unknown } } | null)?.cause?.code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * Decide whether an error is worth retrying, and build the message shown when it is not (or when retries run out).
 * Quota, server, and network problems are transient.
 * Auth, bad-model, and content-block errors fail identically on every attempt, so they fail fast with a hint at the action input to fix.
 */
function classifyError(err: unknown, model: string): { retryable: boolean; message: string } {
  if (err instanceof GeminiResponseError) {
    return { retryable: err.retryable, message: err.message };
  }

  const status = httpStatusOf(err);
  const detail = err instanceof Error ? err.message : String(err);

  // No HTTP status means the request never got an answer (DNS failure, reset connection, timeout).
  if (status === undefined) {
    // genai aborts the request when REQUEST_TIMEOUT_MS runs out, and the abort error itself says nothing about a deadline.
    if (err instanceof Error && err.name === 'AbortError') {
      return { retryable: true, message: `Gemini did not respond within ${REQUEST_TIMEOUT_MS / 1000}s` };
    }
    const code = causeCodeOf(err);
    return { retryable: true, message: code ? `${detail} (${code})` : detail };
  }

  if (status === 429 || status === 408 || status >= 500) {
    return { retryable: true, message: `Gemini request failed (HTTP ${status}): ${detail}` };
  }

  // Gemini reports invalid API keys as HTTP 400 INVALID_ARGUMENT, not only 401/403.
  if (status === 401 || status === 403 || (status === 400 && /api key/i.test(detail))) {
    return {
      retryable: false,
      message: `Gemini rejected the credentials (HTTP ${status}): ${detail} Check that the GEMINI_API_KEY secret is a valid Gemini API key with access to model "${model}".`,
    };
  }

  if (status === 404) {
    return {
      retryable: false,
      message: `Gemini does not recognize model "${model}" (HTTP 404): ${detail} Check the "model" input for a typo.`,
    };
  }

  return {
    retryable: false,
    message: `Gemini rejected the request (HTTP ${status}): ${detail} Check the "model" input (currently "${model}") and the request payload.`,
  };
}

function defaultDispatcher(): Dispatcher {
  const options = { headersTimeout: 0, bodyTimeout: 0 };
  return process.env.NODE_USE_ENV_PROXY === '1' ? new EnvHttpProxyAgent(options) : new Agent(options);
}

export class GeminiClient {
  private client: GoogleGenAI;

  /**
   * Node's built-in fetch gives up when response headers, or a gap between body chunks, take longer than five minutes, whatever timeout the caller sets.
   * Gemini requests therefore go through undici's own fetch with those limits turned off, which leaves REQUEST_TIMEOUT_MS as the only deadline.
   * The dispatcher is set per request, so GitHub traffic is unchanged.
   * Node's built-in fetch only honors HTTP(S)_PROXY and NO_PROXY when NODE_USE_ENV_PROXY=1, so Gemini traffic keeps that behavior.
   */
  constructor(apiKey: string, dispatcher: Dispatcher = defaultDispatcher()) {
    // Typed against undici's own fetch, whose types differ from the global fetch types in @types/node. genai only ever passes a URL string, so the cast is safe.
    const geminiFetch = (input: string | URL, init?: UndiciRequestInit) => fetch(input, { ...init, dispatcher });
    this.client = new GoogleGenAI({
      apiKey,
      httpOptions: { timeout: REQUEST_TIMEOUT_MS, fetch: geminiFetch as unknown as Fetch },
    });
  }

  private sleep(ms: number) {
    return new Promise<void>(resolve => setTimeout(resolve, ms));
  }

  private async parseText(response: GenerateContentResponse): Promise<{ text: string; inputTokens: number; outputTokens: number }> {
    const blockReason = response.promptFeedback?.blockReason;
    if (blockReason && blockReason !== BlockedReason.BLOCKED_REASON_UNSPECIFIED) {
      const detail = response.promptFeedback?.blockReasonMessage;
      throw new GeminiResponseError(
        `Gemini blocked the prompt (${blockReason})${detail ? `: ${detail}` : ''}. The same request would be blocked again, so it is not retried.`
      );
    }

    const candidate = response.candidates?.[0];
    if (candidate?.finishReason && BLOCKING_FINISH_REASONS.has(candidate.finishReason)) {
      throw new GeminiResponseError(
        `Gemini refused to complete the response (${candidate.finishReason}). The same request would be refused again, so it is not retried.`
      );
    }

    // A response cut off at the output limit would publish notes that end mid-sentence, so fail instead of returning them.
    if (candidate?.finishReason === FinishReason.MAX_TOKENS) {
      throw new GeminiResponseError(
        `Gemini stopped at the model's output token limit (${FinishReason.MAX_TOKENS}), so the release notes would be incomplete and were not written. A response that long would likely hit the limit again, so it is not retried. Narrow the commit range, use a prompt that asks for shorter notes, or choose a model with a larger output limit.`
      );
    }

    const textParts: string[] = [];

    for (const p of candidate?.content?.parts ?? []) {
      // Thought parts are the model's reasoning, not release notes.
      if (typeof p.text === 'string' && !p.thought) {
        textParts.push(p.text);
      }
    }

    const text = textParts.join('').trim();
    if (!text) {
      throw new GeminiResponseError('Gemini responded with empty text', true);
    }

    const inputTokens = response.usageMetadata?.promptTokenCount ?? 0;
    const outputTokens = response.usageMetadata?.candidatesTokenCount ?? 0;

    return { text, inputTokens, outputTokens };
  }

  async generateText(
    payload: GenerateContentParameters,
    maxRetries: number,
    initialBackoffMs: number
  ): Promise<{ text: string; inputTokens: number; outputTokens: number }> {
    let attempt = 0;
    let lastMessage = '';
    const totalAttempts = (maxRetries | 0) + 1;

    while (attempt < totalAttempts) {
      try {
        const response = await this.client.models.generateContent(payload);
        return await this.parseText(response);
      } catch (err) {
        const { retryable, message } = classifyError(err, payload.model);
        if (!retryable) {
          throw new GeminiResponseError(message);
        }
        lastMessage = message;
      }

      attempt++;
      if (attempt >= totalAttempts) break;
      const backoff = Math.max(1, initialBackoffMs * Math.pow(2, attempt - 1));
      console.log(`Attempt ${attempt}/${totalAttempts} failed (${lastMessage}); retrying in ${backoff}ms.`);
      await this.sleep(backoff);
    }

    throw new GeminiResponseError(`${lastMessage} (${totalAttempts} attempts)`, true);
  }
}
