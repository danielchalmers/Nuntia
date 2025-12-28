import { GenerateContentResponse, GoogleGenAI, type GenerateContentParameters } from '@google/genai';

export function buildTextPayload(
  systemPrompt: string,
  userPrompt: string,
  model: string,
  temperature: number
): GenerateContentParameters {
  const config: NonNullable<GenerateContentParameters['config']> = {
    systemInstruction: systemPrompt,
    temperature,
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
  constructor(message: string) {
    super(message);
    this.name = 'GeminiResponseError';
  }
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
    const textParts: string[] = [];

    for (const p of response.candidates?.[0]?.content?.parts ?? []) {
      if (typeof p.text === 'string') {
        textParts.push(p.text);
      }
    }

    const text = textParts.join('').trim();
    if (!text) {
      throw new GeminiResponseError('Gemini responded with empty text');
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
    let lastError: unknown = undefined;
    const totalAttempts = (maxRetries | 0) + 1;

    while (attempt < totalAttempts) {
      try {
        const response = await this.client.models.generateContent(payload);
        return await this.parseText(response);
      } catch (err) {
        lastError = err;
      }

      attempt++;
      if (attempt >= totalAttempts) break;
      const backoff = Math.max(1, initialBackoffMs * Math.pow(2, attempt - 1));
      await this.sleep(backoff);
    }

    throw new GeminiResponseError(
      lastError instanceof Error ? lastError.message : String(lastError)
    );
  }
}
