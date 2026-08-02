import { describe, it, expect, vi } from 'vitest';
import { ApiError } from '@google/genai';
import { buildTextPayload, GeminiClient, GeminiResponseError } from '../src/gemini';

const PAYLOAD = buildTextPayload('system', 'user', 'gemini-3.5-flash');

function makeTextResponse(text: string) {
  return {
    candidates: [{ content: { parts: [{ text }] } }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20 },
  };
}

function makeClient(generateContent: ReturnType<typeof vi.fn>) {
  const client = new GeminiClient('test-key');
  (client as any).client = { models: { generateContent } };
  return client;
}

describe('GeminiClient.generateText', () => {
  it('returns text and token counts on success', async () => {
    const generateContent = vi.fn().mockResolvedValue(makeTextResponse('notes'));
    const client = makeClient(generateContent);

    const result = await client.generateText(PAYLOAD, 2, 1);

    expect(result).toEqual({ text: 'notes', inputTokens: 10, outputTokens: 20 });
    expect(generateContent).toHaveBeenCalledTimes(1);
  });

  it('retries 429 and succeeds on a later attempt', async () => {
    const generateContent = vi
      .fn()
      .mockRejectedValueOnce(new ApiError({ message: 'Resource exhausted', status: 429 }))
      .mockResolvedValueOnce(makeTextResponse('notes'));
    const client = makeClient(generateContent);

    const result = await client.generateText(PAYLOAD, 2, 1);

    expect(result.text).toBe('notes');
    expect(generateContent).toHaveBeenCalledTimes(2);
  });

  it('retries server errors until attempts run out, then reports the attempt count', async () => {
    const generateContent = vi.fn().mockRejectedValue(new ApiError({ message: 'Internal error', status: 500 }));
    const client = makeClient(generateContent);

    await expect(client.generateText(PAYLOAD, 2, 1)).rejects.toThrow(/HTTP 500.*3 attempts/s);
    expect(generateContent).toHaveBeenCalledTimes(3);
  });

  it('retries network errors that carry no HTTP status', async () => {
    const generateContent = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(makeTextResponse('notes'));
    const client = makeClient(generateContent);

    const result = await client.generateText(PAYLOAD, 2, 1);

    expect(result.text).toBe('notes');
    expect(generateContent).toHaveBeenCalledTimes(2);
  });

  // Errors that can never succeed on a retry: one attempt, and the message must point at the input to fix.
  it.each([
    ['404, naming the model input', { message: 'models/gemini-3.5-flahs is not found', status: 404 }, /model "gemini-3\.5-flash".*"model" input/s],
    ['403, naming GEMINI_API_KEY', { message: 'Permission denied', status: 403 }, /GEMINI_API_KEY/],
    ['the 400 invalid-API-key error, naming GEMINI_API_KEY', { message: 'API key not valid. Please pass a valid API key.', status: 400 }, /GEMINI_API_KEY/],
    ['other 400 errors, naming the model input', { message: 'Invalid argument', status: 400 }, /"model" input/],
  ])('fails fast on %s', async (_label, apiError, expected) => {
    const generateContent = vi.fn().mockRejectedValue(new ApiError(apiError));
    const client = makeClient(generateContent);

    await expect(client.generateText(PAYLOAD, 2, 1)).rejects.toThrow(expected);
    expect(generateContent).toHaveBeenCalledTimes(1);
  });

  it('fails fast when the prompt is blocked for safety', async () => {
    const generateContent = vi.fn().mockResolvedValue({
      promptFeedback: { blockReason: 'SAFETY', blockReasonMessage: 'Blocked by safety filters' },
    });
    const client = makeClient(generateContent);

    await expect(client.generateText(PAYLOAD, 2, 1)).rejects.toThrow(/blocked the prompt \(SAFETY\)/);
    expect(generateContent).toHaveBeenCalledTimes(1);
  });

  it('fails fast when the response is stopped for safety', async () => {
    const generateContent = vi.fn().mockResolvedValue({
      candidates: [{ finishReason: 'SAFETY', content: { parts: [] } }],
    });
    const client = makeClient(generateContent);

    await expect(client.generateText(PAYLOAD, 2, 1)).rejects.toThrow(/refused to complete the response \(SAFETY\)/);
    expect(generateContent).toHaveBeenCalledTimes(1);
  });

  it('retries an empty response because it can be transient', async () => {
    const generateContent = vi
      .fn()
      .mockResolvedValueOnce({ candidates: [{ content: { parts: [{ text: '  ' }] } }] })
      .mockResolvedValueOnce(makeTextResponse('notes'));
    const client = makeClient(generateContent);

    const result = await client.generateText(PAYLOAD, 2, 1);

    expect(result.text).toBe('notes');
    expect(generateContent).toHaveBeenCalledTimes(2);
  });

  it('throws GeminiResponseError for both fail-fast and retry-exhausted paths', async () => {
    const failFast = makeClient(vi.fn().mockRejectedValue(new ApiError({ message: 'Unauthorized', status: 401 })));
    await expect(failFast.generateText(PAYLOAD, 2, 1)).rejects.toBeInstanceOf(GeminiResponseError);

    const exhausted = makeClient(vi.fn().mockRejectedValue(new ApiError({ message: 'Unavailable', status: 503 })));
    await expect(exhausted.generateText(PAYLOAD, 0, 1)).rejects.toBeInstanceOf(GeminiResponseError);
  });
});
