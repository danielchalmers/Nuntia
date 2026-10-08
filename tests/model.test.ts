import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Agent } from 'undici';
import { AnthropicClient } from '../src/llm/anthropic';
import { GeminiClient } from '../src/llm/gemini';
import { OpenAIClient } from '../src/llm/openai';
import type { ProviderId, ResolvedModel } from '../src/llm/resolve';
import { ModelApiError, ModelError, type TextRequest } from '../src/llm/types';
import { buildTextPayload, createModelClient, explainFailure, generateNotes } from '../src/model';

// Record the options of every Agent, so a test can check the default dispatcher, while each Agent still works for real.
vi.mock('undici', async (importActual) => {
  const actual = await importActual<typeof import('undici')>();
  return { ...actual, Agent: vi.fn(function (options?: Agent.Options) { return new actual.Agent(options); }) };
});

const REQUEST: TextRequest = { model: 'test-model', systemPrompt: 'Write release notes.', userPrompt: '=== RELEASE CONTEXT (JSON) ===\n{}\n' };

type Reply = { status?: number; body: unknown };
type Received = { method: string; url: string; headers: Record<string, string | string[] | undefined>; body: Record<string, unknown> };

let baseUrl = '';
let replies: Reply[] = [];
let received: Received[] = [];

// A local stand-in for every provider's API, which answers each request with the next queued reply.
const server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', chunk => chunks.push(chunk as Buffer));
  req.on('end', () => {
    received.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
    const reply = replies.shift() ?? { status: 500, body: { error: { message: 'No reply queued', code: 500 } } };
    res.writeHead(reply.status ?? 200, { 'Content-Type': 'application/json' }).end(JSON.stringify(reply.body));
  });
});

beforeAll(async () => {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
});

beforeEach(() => {
  replies = [];
  received = [];
  vi.stubEnv('GOOGLE_GEMINI_BASE_URL', baseUrl);
  vi.stubEnv('NODE_USE_ENV_PROXY', '');
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

// A route to the local server, as resolution would build it for that provider.
function route(provider: ProviderId, overrides: Partial<ResolvedModel> = {}): ResolvedModel {
  return {
    provider,
    model: REQUEST.model,
    tier: 'best-effort',
    baseUrl: provider === 'openai' ? `${baseUrl}/v1` : baseUrl,
    host: new URL(baseUrl).host,
    apiKey: 'test-key',
    reason: 'set by model',
    isDefault: false,
    ...overrides,
  };
}

// Waits between retries are skipped, and each one is recorded.
function skipSleeps() {
  const waits: number[] = [];
  for (const client of [GeminiClient, AnthropicClient, OpenAIClient]) {
    vi.spyOn(client.prototype as unknown as { sleep: (ms: number) => Promise<void> }, 'sleep').mockImplementation(async (ms: number) => {
      waits.push(ms);
    });
  }
  return waits;
}

async function notes(resolved: ResolvedModel) {
  return generateNotes(createModelClient(resolved), resolved, REQUEST);
}

async function failure(resolved: ResolvedModel): Promise<string> {
  const err = await notes(resolved).catch((error: unknown) => error);
  expect(err).toBeInstanceOf(Error);
  return (err as Error).message;
}

const GEMINI_NOTES = { candidates: [{ content: { parts: [{ text: '## Notes\n- Fixed it' }] }, finishReason: 'STOP' }] };

describe('buildTextPayload', () => {
  it('keeps the shape nuntia-payload.json had with @google/genai', () => {
    expect(JSON.stringify(buildTextPayload('system text', 'user text', 'gemini-flash-latest'))).toBe(
      '{"model":"gemini-flash-latest","contents":[{"role":"user","parts":[{"text":"user text"}]}],"config":{"systemInstruction":"system text"}}'
    );
  });
});

describe('generateNotes with Claude', () => {
  it('sends a text request with max_tokens 20000 and no thinking or effort settings', async () => {
    replies.push({ body: { content: [{ type: 'text', text: 'Notes' }], stop_reason: 'end_turn' } });

    await notes(route('anthropic'));

    expect(received).toHaveLength(1);
    expect(received[0]!.url).toBe('/v1/messages');
    expect(received[0]!.headers['x-api-key']).toBe('test-key');
    expect(received[0]!.body).toEqual({
      model: 'test-model',
      max_tokens: 20000,
      system: [{ type: 'text', text: 'Write release notes.' }],
      messages: [{ role: 'user', content: REQUEST.userPrompt }],
    });
  });

  it('keeps thinking out of the notes and out of output tokens, and counts cached prompt tokens as input', async () => {
    replies.push({
      body: {
        content: [{ type: 'thinking', thinking: 'Group by area first.' }, { type: 'text', text: '\n## Notes\n- Fixed it\n' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 100, cache_read_input_tokens: 20, cache_creation_input_tokens: 0, output_tokens: 70, output_tokens_details: { thinking_tokens: 50 } },
      },
    });

    expect(await notes(route('anthropic'))).toMatchObject({ text: '## Notes\n- Fixed it', inputTokens: 120, outputTokens: 20 });
  });

  it('fails without retrying when the notes stop at max_tokens', async () => {
    replies.push({ body: { content: [{ type: 'text', text: '## Notes\n- Fixed th' }], stop_reason: 'max_tokens' } });

    expect(await failure(route('anthropic'))).toMatch(/^Claude stopped at the output token limit \(stop_reason max_tokens\), so the release notes would be incomplete and were not written\./);
    expect(received).toHaveLength(1);
  });

  it('fails without retrying on a refusal', async () => {
    replies.push({ body: { content: [], stop_reason: 'refusal', stop_details: { category: 'cyber' } } });

    expect(await failure(route('anthropic'))).toBe('Claude declined to answer (stop_reason refusal, category cyber). The same request would most likely be refused again, so it is not retried.');
    expect(received).toHaveLength(1);
  });

  it('fails fast on a rejected key and names ANTHROPIC_API_KEY', async () => {
    replies.push({ status: 401, body: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } } });

    expect(await failure(route('anthropic'))).toMatch(/^Claude rejected the credentials: .*invalid x-api-key.* Check that the ANTHROPIC_API_KEY secret is a valid Anthropic API key with access to model "test-model"\.$/);
    expect(received).toHaveLength(1);
  });
});

describe('generateNotes with an OpenAI-compatible endpoint', () => {
  it('sends store false and no reasoning or token settings', async () => {
    replies.push({ body: { choices: [{ message: { content: 'Notes' }, finish_reason: 'stop' }] } });

    await notes(route('openai'));

    expect(received[0]!.url).toBe('/v1/chat/completions');
    expect(received[0]!.headers.authorization).toBe('Bearer test-key');
    expect(received[0]!.body).toEqual({
      model: 'test-model',
      messages: [
        { role: 'system', content: 'Write release notes.' },
        { role: 'user', content: REQUEST.userPrompt },
      ],
      store: false,
    });
  });

  it('keeps reasoning fields and <think> blocks out of the notes and out of output tokens', async () => {
    replies.push({
      body: {
        choices: [{ message: { content: '<think>Which commits matter?</think>\n## Notes\n- Fixed it', reasoning_content: 'Read the commits.' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 300, completion_tokens: 90, prompt_tokens_details: { cached_tokens: 100 }, completion_tokens_details: { reasoning_tokens: 60 } },
      },
    });

    expect(await notes(route('openai'))).toMatchObject({ text: '## Notes\n- Fixed it', inputTokens: 300, outputTokens: 30 });
  });

  it('fails without retrying when the notes stop at the length limit', async () => {
    replies.push({ body: { choices: [{ message: { content: '## Notes\n- Fixed th' }, finish_reason: 'length' }] } });

    expect(await failure(route('openai'))).toMatch(/stopped at the output token limit \(finish_reason length\), so the release notes would be incomplete and were not written\./);
    expect(received).toHaveLength(1);
  });

  it('names the endpoint and asks for OPENAI_API_KEY when it rejects a request sent without a key', async () => {
    replies.push({ status: 401, body: { error: { message: 'Missing bearer token', code: 'invalid_api_key' } } });

    const message = await failure(route('openai', { apiKey: undefined }));

    expect(received[0]!.headers.authorization).toBeUndefined();
    const host = new URL(baseUrl).host;
    expect(message.startsWith(`${host} rejected the credentials: `)).toBe(true);
    expect(message.endsWith(` Set OPENAI_API_KEY to a key for ${host}.`)).toBe(true);
  });
});

describe('generateNotes with Gemini', () => {
  it('retries ordinary failures twice, 5s and then 10s apart, and says when they run out', async () => {
    const waits = skipSleeps();
    replies.push(...Array.from({ length: 3 }, () => ({ status: 500, body: { error: { code: 500, message: 'Internal error', status: 'INTERNAL' } } })));

    expect(await failure(route('gemini'))).toMatch(/^Gemini request failed, and retries ran out: .*Internal error/);
    expect(received).toHaveLength(3);
    expect(waits).toEqual([5000, 10000]);
  });

  it('waits out capacity errors on the long schedule instead of failing after the ordinary retries', async () => {
    const waits = skipSleeps();
    for (let i = 0; i < 3; i++) {
      replies.push({ status: 503, body: { error: { code: 503, message: 'The model is overloaded.', status: 'UNAVAILABLE' } } });
    }
    replies.push({ body: GEMINI_NOTES });

    expect((await notes(route('gemini'))).text).toBe('## Notes\n- Fixed it');
    expect(waits).toEqual([10000, 20000, 40000]);
  });

  it('says the provider is still overloaded when the capacity schedule runs out', async () => {
    skipSleeps();
    replies.push(...Array.from({ length: 7 }, () => ({ status: 429, body: { error: { code: 429, message: 'Resource exhausted', status: 'RESOURCE_EXHAUSTED' } } })));

    expect(await failure(route('gemini'))).toMatch(/^Gemini is overloaded or rate limited, and still was after retrying for several minutes: /);
    expect(received).toHaveLength(7);
  });

  it.each([
    ['the 400 invalid-API-key error, naming GEMINI_API_KEY', 400, 'API key not valid. Please pass a valid API key.', /^Gemini rejected the credentials: .* Check that the GEMINI_API_KEY secret is a valid Gemini API key with access to model "test-model"\.$/],
    ['403, naming GEMINI_API_KEY', 403, 'Permission denied', /GEMINI_API_KEY/],
    ['404, naming the model input', 404, 'models/test-model is not found', /^Gemini does not recognize model "test-model".* Check the "model" input for a typo\.$/],
    ['a billing error, naming the account', 402, 'Payment required', /out of credit.*GEMINI_API_KEY belongs to\.$/],
    ['other 400 errors, naming the model input', 400, 'Invalid argument', /^Gemini rejected the request: .* Check the "model" input \(currently "test-model"\) and the request payload\.$/],
  ])('fails fast on %s', async (_label, status, message, expected) => {
    replies.push({ status, body: { error: { code: status, message, status: 'ERROR' } } });

    expect(await failure(route('gemini'))).toMatch(expected);
    expect(received).toHaveLength(1);
  });

  it('fails without retrying when the prompt is blocked', async () => {
    replies.push({ body: { promptFeedback: { blockReason: 'SAFETY' } } });

    expect(await failure(route('gemini'))).toBe('Gemini blocked the prompt (blockReason SAFETY). The same request would most likely be refused again, so it is not retried.');
    expect(received).toHaveLength(1);
  });

  it('fails without retrying when the notes stop at MAX_TOKENS', async () => {
    replies.push({ body: { candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: '## Notes\n- Fixed th' }] } }] } });

    expect(await failure(route('gemini'))).toMatch(/^Gemini stopped at the output token limit \(finishReason MAX_TOKENS\), so the release notes would be incomplete and were not written\. .*Narrow the commit range/);
    expect(received).toHaveLength(1);
  });

  it('retries an empty reply because it can be transient', async () => {
    skipSleeps();
    replies.push({ body: { candidates: [{ content: { parts: [{ text: '  ' }] } }] } }, { body: GEMINI_NOTES });

    expect((await notes(route('gemini'))).text).toBe('## Notes\n- Fixed it');
    expect(received).toHaveLength(2);
  });
});

describe('explainFailure', () => {
  it('names the deadline when the request was aborted for taking too long', () => {
    expect(explainFailure(new ModelError('This operation was aborted'), route('gemini'))).toBe('Gemini did not respond within 600s, and retries ran out.');
  });

  it('names fetch\'s hidden cause for a network failure', () => {
    expect(explainFailure(new ModelError('fetch failed (ECONNRESET)'), route('anthropic'))).toBe('Claude request failed, and retries ran out: fetch failed (ECONNRESET)');
  });

  it('names OpenAI on its own API and the host elsewhere', () => {
    const err = new ModelApiError('{"error":{"message":"Unknown model"}}', 404);

    expect(explainFailure(err, route('openai', { host: 'api.openai.com' }))).toMatch(/^OpenAI does not recognize model/);
    expect(explainFailure(err, route('openai', { host: 'openrouter.ai' }))).toMatch(/^openrouter\.ai does not recognize model/);
  });

  it('passes other errors through unchanged', () => {
    expect(explainFailure(new Error('Something else'), route('gemini'))).toBe('Something else');
  });
});

describe('model traffic', () => {
  it('turns off the dispatcher\'s own headers and body timeouts, so the 10-minute request deadline is the only one', () => {
    createModelClient(route('anthropic'));

    expect(vi.mocked(Agent).mock.lastCall).toEqual([{ headersTimeout: 0, bodyTimeout: 0 }]);
  });

  // Node's built-in fetch only honors proxy variables with NODE_USE_ENV_PROXY=1, and model traffic must keep doing the same.
  it('uses the proxy from the environment when NODE_USE_ENV_PROXY=1', async () => {
    const tunnels: string[] = [];
    const proxy = createServer();
    proxy.on('connect', (req, socket) => {
      tunnels.push(req.url ?? '');
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    });
    await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));

    try {
      skipSleeps();
      vi.stubEnv('http_proxy', `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`);
      vi.stubEnv('no_proxy', '');
      vi.stubEnv('NODE_USE_ENV_PROXY', '1');

      expect(await failure(route('gemini'))).toMatch(/fetch failed/);
      expect(tunnels).toContain(new URL(baseUrl).host);
      expect(received).toHaveLength(0);
    } finally {
      proxy.close();
    }
  });
});
