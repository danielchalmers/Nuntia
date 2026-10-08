import { afterEach, describe, expect, it, vi } from 'vitest'
import { AnthropicClient, PROMPT_CACHE_MARKER } from '../../src/llm/anthropic'
import { toJsonSchema } from '../../src/llm/schema'
import type { Fetch } from '../../src/llm/transport'
import { ModelError, type JsonRequest, type TextRequest } from '../../src/llm/types'

// Non-ASCII text and quotes make sure the body is serialized the same way, not just shaped the same way.
const SYSTEM_PROMPT = 'You are a triage assistant.\nFollow the "policy" below.'
const USER_PROMPT = 'Triage #42: Crash on save — naïve café 🚀\n{"title":"Crash"}'
const SCHEMA = {
  type: 'OBJECT',
  properties: {
    summary: { type: 'STRING' },
    labels: { type: 'ARRAY', items: { type: 'STRING', enum: ['bug', 'enhancement'] } },
  },
  required: ['summary', 'labels'],
}

const JSON_REQUEST: JsonRequest = { model: 'claude-haiku-5-5', systemPrompt: SYSTEM_PROMPT, userPrompt: USER_PROMPT, schema: SCHEMA }
const TEXT_REQUEST: TextRequest = { model: 'claude-haiku-5-5', systemPrompt: SYSTEM_PROMPT, userPrompt: USER_PROMPT }

const USAGE = {
  input_tokens: 120,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  output_tokens: 300,
  output_tokens_details: { thinking_tokens: 250 },
}

function message(content: unknown[], overrides: Record<string, unknown> = {}) {
  return { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', content, stop_reason: 'end_turn', stop_details: null, usage: USAGE, ...overrides }
}

const REPLY = message([
  { type: 'thinking', thinking: 'The report describes a crash.\n\n\nIt is a bug.', signature: 'sig' },
  { type: 'text', text: '{"summary":"ok",' },
  { type: 'text', text: '"labels":["bug"]}' },
])

interface Sent {
  url: string
  method: string | undefined
  headers: Headers
  redirect: string | undefined
  body: string
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
}

function errorBody(type: string, messageText: string, extra: Record<string, unknown> = {}) {
  return { type: 'error', error: { type, message: messageText, ...extra }, request_id: 'req_1' }
}

// Records each request and answers with the next response, so no request leaves the process.
function respondWith(...responses: Array<() => Response>) {
  const sent: Sent[] = []
  const fetch: Fetch = async (input, init) => {
    sent.push({
      url: String(input),
      method: init?.method,
      headers: new Headers(init?.headers),
      redirect: init?.redirect,
      body: typeof init?.body === 'string' ? init.body : '',
    })
    const next = responses[Math.min(sent.length, responses.length) - 1]
    if (!next) throw new Error('no response')
    return next()
  }
  return { sent, fetch }
}

// Retries wait on the real clock otherwise.
class TestClient extends AnthropicClient {
  readonly sleeps: number[] = []
  protected override sleep(ms: number) {
    this.sleeps.push(ms)
    return Promise.resolve()
  }
}

async function failureOf(promise: Promise<unknown>) {
  const err = await promise.catch((error: unknown) => error)
  expect(err).toBeInstanceOf(ModelError)
  return { message: (err as ModelError).message, failure: (err as ModelError).failure }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Claude requests', () => {
  it('sends the JSON request without caching', async () => {
    const { sent, fetch } = respondWith(() => jsonResponse(REPLY))
    await new TestClient('test-key', fetch).generateJson(JSON_REQUEST, 0, 1)

    expect(sent).toHaveLength(1)
    expect(sent[0]!.url).toBe('https://api.anthropic.com/v1/messages')
    expect(sent[0]!.method).toBe('POST')
    expect(sent[0]!.redirect).toBe('manual')
    expect(Object.fromEntries(sent[0]!.headers)).toEqual({
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
      'x-api-key': 'test-key',
    })
    expect(sent[0]!.body).toBe(JSON.stringify({
      model: 'claude-haiku-5-5',
      max_tokens: 20000,
      system: [{ type: 'text', text: SYSTEM_PROMPT }],
      messages: [{ role: 'user', content: USER_PROMPT }],
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort: 'high', format: { type: 'json_schema', schema: toJsonSchema(SCHEMA) } },
    }))
  })

  it('marks the system prompt for an hour of caching when the request carries the cache marker', async () => {
    const { sent, fetch } = respondWith(() => jsonResponse(REPLY))
    const client = new TestClient('test-key', fetch)

    const cache = await client.createCache('claude-haiku-5-5', SYSTEM_PROMPT, 'autotriage-pro-owner/repo')
    await client.generateJson({ ...JSON_REQUEST, cacheName: cache.name, useFlexTier: true }, 0, 1)
    await client.deleteCache(cache.name)

    // Creating and deleting the cache make no API calls, and the flex tier is Gemini's alone.
    expect(cache).toEqual({ name: PROMPT_CACHE_MARKER, tokenCount: 0 })
    expect(sent).toHaveLength(1)
    expect(sent[0]!.body).toBe(JSON.stringify({
      model: 'claude-haiku-5-5',
      max_tokens: 20000,
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral', ttl: '1h' } }],
      messages: [{ role: 'user', content: USER_PROMPT }],
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort: 'high', format: { type: 'json_schema', schema: toJsonSchema(SCHEMA) } },
    }))
  })

  it('sends the text request with only the model, the token limit, and the prompts', async () => {
    const { sent, fetch } = respondWith(() => jsonResponse(message([{ type: 'text', text: 'Release notes' }])))
    await new TestClient('test-key', fetch).generateText(TEXT_REQUEST, 0, 1)

    expect(sent[0]!.url).toBe('https://api.anthropic.com/v1/messages')
    expect(sent[0]!.body).toBe(JSON.stringify({
      model: 'claude-haiku-5-5',
      max_tokens: 20000,
      system: [{ type: 'text', text: SYSTEM_PROMPT }],
      messages: [{ role: 'user', content: USER_PROMPT }],
    }))
  })

  it('sends requests to the given base URL', async () => {
    const { sent, fetch } = respondWith(() => jsonResponse(REPLY))
    await new TestClient('test-key', fetch, 'http://127.0.0.1:8080/').generateJson(JSON_REQUEST, 0, 1)

    expect(sent[0]!.url).toBe('http://127.0.0.1:8080/v1/messages')
  })
})

describe('Claude responses', () => {
  it('splits thinking from the JSON answer and rebases usage to the shared terms', async () => {
    const { fetch } = respondWith(() => jsonResponse(REPLY))

    expect(await new TestClient('test-key', fetch).generateJson(JSON_REQUEST, 0, 1)).toEqual({
      data: { summary: 'ok', labels: ['bug'] },
      thoughts: 'The report describes a crash.\nIt is a bug.',
      inputTokens: 120,
      cachedInputTokens: 0,
      // output_tokens includes thinking, which is counted on its own.
      outputTokens: 50,
      thoughtsTokens: 250,
      cacheWriteTokens: 0,
    })
  })

  it('counts cache writes and reads in the input', async () => {
    const write = message(REPLY.content, { usage: { ...USAGE, input_tokens: 20, cache_creation_input_tokens: 4000 } })
    const read = message(REPLY.content, { usage: { ...USAGE, input_tokens: 20, cache_read_input_tokens: 4000 } })
    const { fetch } = respondWith(() => jsonResponse(write), () => jsonResponse(read))
    const client = new TestClient('test-key', fetch)

    expect(await client.generateJson(JSON_REQUEST, 0, 1)).toMatchObject({ inputTokens: 4020, cachedInputTokens: 0, cacheWriteTokens: 4000 })
    expect(await client.generateJson(JSON_REQUEST, 0, 1)).toMatchObject({ inputTokens: 4020, cachedInputTokens: 4000, cacheWriteTokens: 0 })
  })

  it('counts no thinking when the reply has none', async () => {
    const reply = message([{ type: 'text', text: '{"summary":"ok","labels":[]}' }], { usage: { input_tokens: 10, output_tokens: 40, output_tokens_details: null } })
    const { fetch } = respondWith(() => jsonResponse(reply))

    expect(await new TestClient('test-key', fetch).generateJson(JSON_REQUEST, 0, 1)).toMatchObject({ thoughts: '', outputTokens: 40, thoughtsTokens: 0 })
  })

  it('returns trimmed text without the thinking from a text call', async () => {
    const reply = message([{ type: 'thinking', thinking: 'Group the changes.', signature: 'sig' }, { type: 'text', text: '\n## Fixes\n- Crash on save\n' }])
    const { fetch } = respondWith(() => jsonResponse(reply))

    expect(await new TestClient('test-key', fetch).generateText(TEXT_REQUEST, 0, 1)).toEqual({
      text: '## Fixes\n- Crash on save',
      inputTokens: 120,
      cachedInputTokens: 0,
      outputTokens: 50,
      thoughtsTokens: 250,
      cacheWriteTokens: 0,
    })
  })

  it('throws a refusal with its category, without retrying', async () => {
    const refusal = message([], { stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber', explanation: 'Declined.' } })
    const { sent, fetch } = respondWith(() => jsonResponse(refusal))

    expect(await failureOf(new TestClient('test-key', fetch).generateJson(JSON_REQUEST, 2, 1))).toEqual({
      message: 'Claude declined to answer (stop_reason refusal, category cyber)',
      failure: { kind: 'refusal' },
    })
    expect(sent).toHaveLength(1)
  })

  it('throws a refusal without a category the same way', async () => {
    const { fetch } = respondWith(() => jsonResponse(message([], { stop_reason: 'refusal' })))

    expect(await failureOf(new TestClient('test-key', fetch).generateText(TEXT_REQUEST, 0, 1))).toEqual({
      message: 'Claude declined to answer (stop_reason refusal)',
      failure: { kind: 'refusal' },
    })
  })

  it('throws a reply cut off by the output or context limit as truncated', async () => {
    const cutOff = (stop: string) => respondWith(() => jsonResponse(message([{ type: 'text', text: '{"summary":' }], { stop_reason: stop }))).fetch

    expect(await failureOf(new TestClient('test-key', cutOff('max_tokens')).generateJson(JSON_REQUEST, 2, 1))).toEqual({
      message: 'Claude stopped at the output token limit (stop_reason max_tokens)',
      failure: { kind: 'truncated' },
    })
    expect(await failureOf(new TestClient('test-key', cutOff('model_context_window_exceeded')).generateJson(JSON_REQUEST, 2, 1))).toEqual({
      message: 'Claude stopped at the context window limit (stop_reason model_context_window_exceeded)',
      failure: { kind: 'truncated' },
    })
  })

  it('retries an empty or unparsable reply on the caller budget', async () => {
    const { sent, fetch } = respondWith(
      () => jsonResponse(message([{ type: 'thinking', thinking: 'Hmm.', signature: 'sig' }])),
      () => jsonResponse(message([{ type: 'text', text: 'not json' }])),
      () => jsonResponse(REPLY)
    )
    const client = new TestClient('test-key', fetch)

    expect((await client.generateJson(JSON_REQUEST, 2, 100)).data).toEqual({ summary: 'ok', labels: ['bug'] })
    expect(sent).toHaveLength(3)
    expect(client.sleeps).toEqual([100, 200])

    const { fetch: emptyFetch } = respondWith(() => jsonResponse(message([{ type: 'text', text: ' ' }])))
    expect(await failureOf(new TestClient('test-key', emptyFetch).generateJson(JSON_REQUEST, 0, 1))).toEqual({
      message: 'Claude responded with empty text',
      failure: { kind: 'retryable' },
    })
  })
})

describe('Claude errors', () => {
  // Each status and body the Messages API documents, and how a call that gets it fails.
  const cases: Array<[label: string, status: number, body: unknown, expected: ModelError['failure']]> = [
    ['a bad key', 401, errorBody('authentication_error', 'invalid x-api-key'), { kind: 'fatal', cause: 'auth' }],
    ['a key without access', 403, errorBody('permission_error', 'Your API key does not have permission to use the specified resource.'), { kind: 'fatal', cause: 'auth' }],
    ['an unknown model', 404, errorBody('not_found_error', 'model: claude-nope'), { kind: 'fatal', cause: 'model' }],
    ['billing', 402, errorBody('billing_error', 'There is an issue with your payment method.'), { kind: 'fatal', cause: 'quota' }],
    ['no credit', 400, errorBody('invalid_request_error', 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.'), { kind: 'fatal', cause: 'quota' }],
    ['a usage limit', 400, errorBody('invalid_request_error', 'You have reached your specified API usage limits. You will regain access on 2026-11-01 at 00:00 UTC.'), { kind: 'fatal', cause: 'quota' }],
    ['the spend limit', 429, errorBody('rate_limit_error', 'Spend limit reached.', { details: { error_code: 'enforced_spend_limit_reached' } }), { kind: 'fatal', cause: 'quota' }],
    ['a bad request', 400, errorBody('invalid_request_error', 'messages: at least one message is required'), { kind: 'permanent' }],
    ['a request that is too large', 413, errorBody('request_too_large', 'Request exceeds the maximum allowed number of bytes.'), { kind: 'permanent' }],
  ]

  it.each(cases)('fails at once on %s', async (_label, status, body, expected) => {
    const { sent, fetch } = respondWith(() => jsonResponse(body, status))
    const client = new TestClient('test-key', fetch)

    expect(await failureOf(client.generateJson(JSON_REQUEST, 2, 1))).toEqual({ message: JSON.stringify(body), failure: expected })
    expect(sent).toHaveLength(1)
  })

  it('waits out rate limits and overloads on the capacity schedule, with Retry-After as a floor', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { sent, fetch } = respondWith(
      () => jsonResponse(errorBody('rate_limit_error', 'Number of request tokens has exceeded your per-minute rate limit'), 429, { 'retry-after': '45' }),
      () => jsonResponse(errorBody('overloaded_error', 'Overloaded'), 529),
      () => new Response('Service Unavailable', { status: 503, headers: { 'content-type': 'text/plain' } }),
      () => jsonResponse(REPLY)
    )
    const client = new TestClient('test-key', fetch)

    expect((await client.generateJson(JSON_REQUEST, 0, 1)).data).toEqual({ summary: 'ok', labels: ['bug'] })
    expect(sent).toHaveLength(4)
    expect(client.sleeps).toEqual([45_000, 20_000, 40_000])
  })

  it('retries server errors and timeouts on the caller budget', async () => {
    const { sent, fetch } = respondWith(
      () => jsonResponse(errorBody('api_error', 'Internal server error'), 500),
      () => jsonResponse(errorBody('timeout_error', 'Request timed out'), 504),
      () => jsonResponse(REPLY)
    )
    const client = new TestClient('test-key', fetch)

    expect((await client.generateJson(JSON_REQUEST, 2, 100)).data).toEqual({ summary: 'ok', labels: ['bug'] })
    expect(sent).toHaveLength(3)
    expect(client.sleeps).toEqual([100, 200])
  })

  // The API may reject either setting first, and the wording for effort is not documented.
  const legacyRejections = [
    'adaptive thinking is not supported on this model',
    'output_config.effort: This model does not support the effort parameter.',
    'output_config.effort: Extra inputs are not permitted',
  ]

  it.each(legacyRejections)('fails a model that rejects the official request as an unusable model, naming the supported family: %s', async rejection => {
    const body = errorBody('invalid_request_error', rejection)
    const { sent, fetch } = respondWith(() => jsonResponse(body, 400))

    expect(await failureOf(new TestClient('test-key', fetch).generateJson({ ...JSON_REQUEST, model: 'claude-haiku-4-5' }, 2, 1))).toEqual({
      message: `claude-haiku-4-5 does not support adaptive thinking or the effort setting, which this request needs. The supported family is Claude 5.5, such as claude-haiku-5-5. ${JSON.stringify(body)}`,
      failure: { kind: 'fatal', cause: 'model' },
    })
    expect(sent).toHaveLength(1)
  })

  it('drops the enums on list items once the schema is too complex, for the rest of the run', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const body = errorBody('invalid_request_error', 'Schema is too complex for compilation.')
    const { sent, fetch } = respondWith(() => jsonResponse(body, 400), () => jsonResponse(REPLY))
    const client = new TestClient('test-key', fetch)

    await client.generateJson(JSON_REQUEST, 0, 1)
    await client.generateJson(JSON_REQUEST, 0, 1)

    const schemas = sent.map(request => JSON.parse(request.body).output_config.format.schema)
    expect(schemas[0].properties.labels.items).toEqual({ type: 'string', enum: ['bug', 'enhancement'] })
    expect(schemas[1].properties.labels.items).toEqual({ type: 'string' })
    expect(schemas[2]).toEqual(schemas[1])
    expect(sent).toHaveLength(3)
    expect(client.sleeps).toEqual([])
    expect(warn).toHaveBeenCalledOnce()
    expect(warn.mock.calls[0]![0]).toContain('Claude rejected the response schema as too complex')
  })

  it('fails as permanent when even the relaxed schema is too complex', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const body = errorBody('invalid_request_error', 'Schema is too complex for compilation.')
    const { sent, fetch } = respondWith(() => jsonResponse(body, 400))

    expect(await failureOf(new TestClient('test-key', fetch).generateJson(JSON_REQUEST, 2, 1))).toEqual({
      message: JSON.stringify(body),
      failure: { kind: 'permanent' },
    })
    expect(sent).toHaveLength(2)
  })
})
