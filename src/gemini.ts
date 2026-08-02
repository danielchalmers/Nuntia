import { ApiError, BlockedReason, FinishReason, GenerateContentResponse, GoogleGenAI, type GenerateContentParameters } from '@google/genai';

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
    return { retryable: true, message: detail };
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

export class GeminiClient {
  private client: GoogleGenAI;

  constructor(apiKey: string) {
    this.client = new GoogleGenAI({ apiKey });
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

    const textParts: string[] = [];

    for (const p of candidate?.content?.parts ?? []) {
      if (typeof p.text === 'string') {
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
