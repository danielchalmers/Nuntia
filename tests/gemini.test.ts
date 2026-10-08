import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, it, expect, vi } from 'vitest';
import { ApiError } from '@google/genai';
import { Agent } from 'undici';
import { buildTextPayload, GeminiClient, GeminiResponseError } from '../src/gemini';

const PAYLOAD = buildTextPayload('system', 'user', 'gemini-flash-latest');

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

describe('buildTextPayload', () => {
  it('sends the system prompt as a system instruction and leaves sampling at the model default', () => {
    expect(buildTextPayload('system text', 'user text', 'gemini-flash-latest')).toEqual({
      model: 'gemini-flash-latest',
      contents: [{ role: 'user', parts: [{ text: 'user text' }] }],
      config: { systemInstruction: 'system text' },
    });
  });
});

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

  it('backs off exponentially between attempts', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const generateContent = vi.fn().mockRejectedValue(new ApiError({ message: 'Unavailable', status: 503 }));
    const client = makeClient(generateContent);
    const sleep = vi.spyOn(client as any, 'sleep').mockResolvedValue(undefined);

    try {
      await expect(client.generateText(PAYLOAD, 3, 5000)).rejects.toThrow(/4 attempts/);
      expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([5000, 10000, 20000]);
    } finally {
      logSpy.mockRestore();
    }
  });

  it.each([
    ['408 request timeout', new ApiError({ message: 'Timeout', status: 408 })],
    ['a non-ApiError that still carries an HTTP status', Object.assign(new Error('Bad gateway'), { status: 502 })],
  ])('retries %s', async (_label, error) => {
    const generateContent = vi.fn().mockRejectedValueOnce(error).mockResolvedValueOnce(makeTextResponse('notes'));
    const client = makeClient(generateContent);

    const result = await client.generateText(PAYLOAD, 2, 1);

    expect(result.text).toBe('notes');
    expect(generateContent).toHaveBeenCalledTimes(2);
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

  it('names the cause that fetch hides behind "fetch failed"', async () => {
    const cause = Object.assign(new Error('Headers Timeout Error'), { code: 'UND_ERR_HEADERS_TIMEOUT' });
    const client = makeClient(vi.fn().mockRejectedValue(Object.assign(new TypeError('fetch failed'), { cause })));

    await expect(client.generateText(PAYLOAD, 0, 1)).rejects.toThrow('fetch failed (UND_ERR_HEADERS_TIMEOUT) (1 attempts)');
  });

  // Errors that can never succeed on a retry: one attempt, and the message must point at the input to fix.
  it.each([
    ['404, naming the model input', { message: 'models/gemini-flash-latets is not found', status: 404 }, /model "gemini-flash-latest".*"model" input/s],
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

  it('fails fast instead of returning notes cut off at the output token limit', async () => {
    const generateContent = vi.fn().mockResolvedValue({
      candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: '## Notes\n- Fixed th' }] } }],
    });
    const client = makeClient(generateContent);

    await expect(client.generateText(PAYLOAD, 2, 1)).rejects.toThrow(/output token limit \(MAX_TOKENS\).*not written/s);
    expect(generateContent).toHaveBeenCalledTimes(1);
  });

  it('ignores an unspecified block reason and joins the text parts', async () => {
    const generateContent = vi.fn().mockResolvedValue({
      promptFeedback: { blockReason: 'BLOCKED_REASON_UNSPECIFIED' },
      candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '## Notes\n' }, { inlineData: {} }, { text: '- Fixed it\n\n' }] } }],
    });
    const client = makeClient(generateContent);

    const result = await client.generateText(PAYLOAD, 2, 1);

    expect(result).toEqual({ text: '## Notes\n- Fixed it', inputTokens: 0, outputTokens: 0 });
  });

  it('leaves thought parts out of the text', async () => {
    const generateContent = vi.fn().mockResolvedValue({
      candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'Planning the highlights first.', thought: true }, { text: '## Notes\n- Fixed it' }] } }],
    });
    const client = makeClient(generateContent);

    const result = await client.generateText(PAYLOAD, 2, 1);

    expect(result.text).toBe('## Notes\n- Fixed it');
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

// Real requests to a local stand-in for Gemini that is slow to send response headers, as a busy model is.
describe('GeminiClient over HTTP', () => {
  const HEADERS_DELAY_MS = 1000;
  let lastHeaders: IncomingHttpHeaders | undefined;
  let baseUrl = '';
  const server = createServer((req, res) => {
    lastHeaders = req.headers;
    req.resume();
    setTimeout(() => {
      if (res.destroyed) return;
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(makeTextResponse('notes')));
    }, HEADERS_DELAY_MS);
  });

  beforeAll(async () => {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });

  function localPayload() {
    return { ...PAYLOAD, config: { ...PAYLOAD.config, httpOptions: { baseUrl } } };
  }

  it('sends requests through its own dispatcher, so that dispatcher decides how long to wait for headers', async () => {
    const dispatcher = new Agent({ headersTimeout: 100 });
    const client = new GeminiClient('test-key', dispatcher);

    try {
      await expect(client.generateText(localPayload(), 0, 1)).rejects.toThrow('fetch failed (UND_ERR_HEADERS_TIMEOUT) (1 attempts)');
    } finally {
      await dispatcher.close();
    }
  });

  it('waits for slow headers by default and tells Gemini about its 10-minute deadline', async () => {
    const client = new GeminiClient('test-key');

    const result = await client.generateText(localPayload(), 0, 1);

    expect(result).toEqual({ text: 'notes', inputTokens: 10, outputTokens: 20 });
    expect(lastHeaders?.['x-server-timeout']).toBe('600');
  });
});
