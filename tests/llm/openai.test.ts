// Source: AutoTriage (danielchalmers/AutoTriage, tests/llm/). Nuntia copies this folder verbatim, so change it in AutoTriage and copy it over in a paired PR.
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { OpenAIClient, PROMPT_CACHE_BREAKPOINT, responseFormatNote } from '../../src/llm/openai'
import { toJsonSchema } from '../../src/llm/schema'
import type { Fetch } from '../../src/llm/transport'
import { ModelError, type JsonRequest, type TextRequest } from '../../src/llm/types'

// Non-ASCII text and quotes make sure the body is serialized the same way, not just shaped the same way.
const SYSTEM_PROMPT = 'You are a triage assistant.\nFollow the "policy" below.'
const USER_PROMPT = 'Triage #42: Crash on save — naïve café 🚀\n{"title":"Crash"}\n'
const SCHEMA = {
  type: 'OBJECT',
  properties: {
    summary: { type: 'STRING' },
    labels: { type: 'ARRAY', items: { type: 'STRING', enum: ['bug', 'enhancement'] } },
  },
  required: ['summary', 'labels'],
}
const STRICT_SCHEMA = toJsonSchema(SCHEMA)

const JSON_REQUEST: JsonRequest = { model: 'gpt-6-luna', systemPrompt: SYSTEM_PROMPT, userPrompt: USER_PROMPT, schema: SCHEMA }
const TEXT_REQUEST: TextRequest = { model: 'gpt-6-luna', systemPrompt: SYSTEM_PROMPT, userPrompt: USER_PROMPT }

const COMPATIBLE_URL = 'https://openrouter.ai/api/v1'
const NOTE = responseFormatNote(STRICT_SCHEMA)

const USAGE = {
  prompt_tokens: 1200,
  completion_tokens: 300,
  total_tokens: 1500,
  prompt_tokens_details: { cached_tokens: 1024, cache_write_tokens: 0 },
  completion_tokens_details: { reasoning_tokens: 250 },
}

function completion(message: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  return {
    id: 'chatcmpl-1',
    object: 'chat.completion',
    model: 'gpt-6-luna',
    choices: [{ index: 0, message: { role: 'assistant', refusal: null, ...message }, finish_reason: 'stop' }],
    usage: USAGE,
    ...overrides,
  }
}

const REPLY = completion({ content: '{"summary":"ok","labels":["bug"]}' })

// OpenAI's wording for each enum limit, which best-effort hosts that copy OpenAI's errors send too.
const schemaLimits = [
  'Invalid schema for response_format \'triage_plan\': Expected at most 1000 enum values in total within a single schema when using structured outputs, but received 1208. Consider reducing the number of enums, or opt out of structured outputs by setting \'strict: false\'.',
  'Invalid schema for response_format \'triage_plan\': Expected at most 15000 total characters across enum values when there are more than 250 enum values, but received 15342. Consider reducing the number of enums, or opt out of structured outputs by setting \'strict: false\'.',
]

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

function errorBody(message: string, type: string, code: string | null = null, param: string | null = null) {
  return { error: { message, type, param, code } }
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
class TestClient extends OpenAIClient {
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

let log: MockInstance<typeof console.log>
let warn: MockInstance<typeof console.warn>

beforeEach(() => {
  log = vi.spyOn(console, 'log').mockImplementation(() => {})
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('OpenAI requests', () => {
  it('sends the official JSON request with explicit caching and no breakpoint', async () => {
    const { sent, fetch } = respondWith(() => jsonResponse(REPLY))
    await new TestClient('test-key', fetch).generateJson(JSON_REQUEST, 0, 1)

    expect(sent).toHaveLength(1)
    expect(sent[0]!.url).toBe('https://api.openai.com/v1/chat/completions')
    expect(sent[0]!.method).toBe('POST')
    expect(sent[0]!.redirect).toBe('manual')
    expect(Object.fromEntries(sent[0]!.headers)).toEqual({
      authorization: 'Bearer test-key',
      'content-type': 'application/json',
    })
    expect(sent[0]!.body).toBe(JSON.stringify({
      model: 'gpt-6-luna',
      messages: [
        { role: 'system', content: [{ type: 'text', text: SYSTEM_PROMPT }] },
        { role: 'user', content: USER_PROMPT },
      ],
      response_format: { type: 'json_schema', json_schema: { name: 'triage_plan', strict: true, schema: STRICT_SCHEMA } },
      reasoning_effort: 'high',
      store: false,
      max_completion_tokens: 32000,
      prompt_cache_options: { mode: 'explicit' },
    }))
  })

  it('places a cache breakpoint after the system prompt when the request carries the cache marker', async () => {
    const { sent, fetch } = respondWith(() => jsonResponse(REPLY))
    const client = new TestClient('test-key', fetch)

    const cache = await client.createCache('gpt-6-luna', SYSTEM_PROMPT, 'autotriage-pro-owner/repo')
    await client.generateJson({ ...JSON_REQUEST, cacheName: cache?.name, useFlexTier: true }, 0, 1)
    await client.deleteCache(PROMPT_CACHE_BREAKPOINT)

    // Creating and deleting the cache make no API calls, and the flex tier is Gemini's alone.
    expect(cache).toEqual({ name: PROMPT_CACHE_BREAKPOINT, tokenCount: 0 })
    expect(sent).toHaveLength(1)
    expect(sent[0]!.body).toBe(JSON.stringify({
      model: 'gpt-6-luna',
      messages: [
        { role: 'system', content: [{ type: 'text', text: SYSTEM_PROMPT, prompt_cache_breakpoint: { mode: 'explicit' } }] },
        { role: 'user', content: USER_PROMPT },
      ],
      response_format: { type: 'json_schema', json_schema: { name: 'triage_plan', strict: true, schema: STRICT_SCHEMA } },
      reasoning_effort: 'high',
      store: false,
      max_completion_tokens: 32000,
      prompt_cache_options: { mode: 'explicit' },
    }))
  })

  it('sends the official text request with only the model, the prompts, store false, and explicit caching with no breakpoint', async () => {
    const { sent, fetch } = respondWith(() => jsonResponse(completion({ content: 'Release notes' })))
    await new TestClient('test-key', fetch).generateText(TEXT_REQUEST, 0, 1)

    expect(sent[0]!.url).toBe('https://api.openai.com/v1/chat/completions')
    expect(sent[0]!.body).toBe(JSON.stringify({
      model: 'gpt-6-luna',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: USER_PROMPT },
      ],
      store: false,
      prompt_cache_options: { mode: 'explicit' },
    }))
  })

  it('logs the host once', async () => {
    const { fetch } = respondWith(() => jsonResponse(REPLY))
    const client = new TestClient('test-key', fetch)

    await client.generateJson(JSON_REQUEST, 0, 1)
    await client.generateJson(JSON_REQUEST, 0, 1)

    expect(log.mock.calls).toEqual([['Chat Completions requests go to api.openai.com.']])
  })
})

describe('OpenAI-compatible requests', () => {
  it('sends the best-effort JSON request with the reply format in the user message and no caching', async () => {
    const { sent, fetch } = respondWith(() => jsonResponse(REPLY))
    await new TestClient('test-key', fetch, `${COMPATIBLE_URL}/`).generateJson({ ...JSON_REQUEST, model: 'anthropic/claude-sonnet-5.5', cacheName: 'ignored' }, 0, 1)

    expect(sent[0]!.url).toBe('https://openrouter.ai/api/v1/chat/completions')
    expect(sent[0]!.redirect).toBe('manual')
    expect(sent[0]!.body).toBe(JSON.stringify({
      model: 'anthropic/claude-sonnet-5.5',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `${USER_PROMPT.trimEnd()}\n\n${NOTE}` },
      ],
      response_format: { type: 'json_schema', json_schema: { name: 'triage_plan', strict: true, schema: STRICT_SCHEMA } },
      reasoning_effort: 'high',
      store: false,
      max_completion_tokens: 32000,
    }))
    expect(log).toHaveBeenCalledWith('Chat Completions requests go to openrouter.ai.')
  })

  it('keeps the base URL\'s query string after the path', async () => {
    const { sent, fetch } = respondWith(() => jsonResponse(REPLY))
    await new TestClient('test-key', fetch, 'https://contoso.openai.azure.com/openai/v1/?api-version=preview').generateJson(JSON_REQUEST, 0, 1)

    expect(sent[0]!.url).toBe('https://contoso.openai.azure.com/openai/v1/chat/completions?api-version=preview')
    expect(log).toHaveBeenCalledWith('Chat Completions requests go to contoso.openai.azure.com.')
  })

  it('spells out the schema and the JSON rules, overriding any claim that the schema is enforced', () => {
    expect(NOTE).toBe([
      '=== SECTION: RESPONSE FORMAT ===',
      'This service may not enforce the response schema, so any earlier statement that the reply is decoded against an enforced schema does not apply.',
      '- Return exactly one valid JSON object that matches the JSON Schema below. Do not wrap it in markdown, comments, extra text, or code fences. Avoid trailing commas.',
      '- Include every field the schema requires, and no others.',
      '',
      'JSON Schema:',
      JSON.stringify(STRICT_SCHEMA, null, 2),
    ].join('\n'))
  })

  it('sends the best-effort text request without caching, and without a key for a local server', async () => {
    const { sent, fetch } = respondWith(() => jsonResponse(completion({ content: 'Release notes' })))
    await new TestClient(undefined, fetch, 'http://localhost:11434/v1').generateText({ ...TEXT_REQUEST, model: 'llama4' }, 0, 1)

    expect(sent[0]!.url).toBe('http://localhost:11434/v1/chat/completions')
    expect(Object.fromEntries(sent[0]!.headers)).toEqual({ 'content-type': 'application/json' })
    expect(sent[0]!.body).toBe(JSON.stringify({
      model: 'llama4',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: USER_PROMPT },
      ],
      store: false,
    }))
  })

  it('has no prompt cache to create', async () => {
    const { sent, fetch } = respondWith(() => jsonResponse(REPLY))

    expect(await new TestClient('test-key', fetch, COMPATIBLE_URL).createCache('model', SYSTEM_PROMPT)).toBeUndefined()
    expect(sent).toHaveLength(0)
  })
})

describe('Chat Completions responses', () => {
  it('reads the JSON answer and rebases usage to the shared terms', async () => {
    const { fetch } = respondWith(() => jsonResponse(REPLY))

    expect(await new TestClient('test-key', fetch).generateJson(JSON_REQUEST, 0, 1)).toEqual({
      data: { summary: 'ok', labels: ['bug'] },
      // OpenAI returns no reasoning text on Chat Completions.
      thoughts: '',
      inputTokens: 1200,
      cachedInputTokens: 1024,
      // completion_tokens includes reasoning, which is counted on its own.
      outputTokens: 50,
      thoughtsTokens: 250,
      cacheWriteTokens: 0,
    })
  })

  it('counts cache writes, and DeepSeek-style cache reads', async () => {
    const write = completion(REPLY.choices[0]!.message, { usage: { prompt_tokens: 5000, completion_tokens: 40, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 4096 } } })
    const deepSeek = completion(REPLY.choices[0]!.message, { usage: { prompt_tokens: 5000, completion_tokens: 40, prompt_cache_hit_tokens: 4096, prompt_cache_miss_tokens: 904 } })
    const bare = completion(REPLY.choices[0]!.message, { usage: undefined })
    const { fetch } = respondWith(() => jsonResponse(write), () => jsonResponse(deepSeek), () => jsonResponse(bare))
    const client = new TestClient('test-key', fetch)

    expect(await client.generateJson(JSON_REQUEST, 0, 1)).toMatchObject({ inputTokens: 5000, cachedInputTokens: 0, cacheWriteTokens: 4096, outputTokens: 40, thoughtsTokens: 0 })
    expect(await client.generateJson(JSON_REQUEST, 0, 1)).toMatchObject({ inputTokens: 5000, cachedInputTokens: 4096, cacheWriteTokens: 0 })
    expect(await client.generateJson(JSON_REQUEST, 0, 1)).toMatchObject({ inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, thoughtsTokens: 0, cacheWriteTokens: 0 })
  })

  it('reads the answer from content parts', async () => {
    const { fetch } = respondWith(() => jsonResponse(completion({ content: [{ type: 'text', text: '{"summary":"ok",' }, { type: 'text', text: '"labels":[]}' }] })))

    expect((await new TestClient('test-key', fetch).generateJson(JSON_REQUEST, 0, 1)).data).toEqual({ summary: 'ok', labels: [] })
  })

  // Each place a compatible host puts its reasoning, and the answer left once it is taken out.
  const thoughtCases: Array<[host: string, message: Record<string, unknown>]> = [
    ['DeepSeek and Fireworks', { content: '{"summary":"ok","labels":[]}', reasoning_content: 'It is a bug.\n\n\nLabel it.' }],
    ['Groq, Cerebras and OpenRouter', { content: '{"summary":"ok","labels":[]}', reasoning: 'It is a bug.\n\n\nLabel it.' }],
    ['Mistral', { content: [{ type: 'thinking', thinking: [{ type: 'text', text: 'It is a bug.\n\n' }, { type: 'text', text: '\nLabel it.' }] }, { type: 'text', text: '{"summary":"ok","labels":[]}' }] }],
    ['an inline <think> block', { content: '<think>\nIt is a bug.\n\n\nLabel it.\n</think>\n\n{"summary":"ok","labels":[]}' }],
    ['a <think> block opened by the chat template', { content: 'It is a bug.\n\n\nLabel it.\n</think>\n\n{"summary":"ok","labels":[]}' }],
  ]

  it.each(thoughtCases)('takes the thoughts from %s out of the answer', async (_host, message) => {
    const { fetch } = respondWith(() => jsonResponse(completion(message)))

    expect(await new TestClient(undefined, fetch, COMPATIBLE_URL).generateJson(JSON_REQUEST, 0, 1)).toMatchObject({
      data: { summary: 'ok', labels: [] },
      thoughts: 'It is a bug.\nLabel it.',
    })
  })

  it('caps the thoughts at 20,000 characters', async () => {
    const { fetch } = respondWith(() => jsonResponse(completion({ content: '{"summary":"ok","labels":[]}', reasoning_content: 'x'.repeat(25_000) })))

    expect((await new TestClient(undefined, fetch, COMPATIBLE_URL).generateJson(JSON_REQUEST, 0, 1)).thoughts).toBe('x'.repeat(20_000))
  })

  it('takes JSON out of a code fence on a best-effort host only', async () => {
    const fenced = () => jsonResponse(completion({ content: '```json\n{"summary":"ok","labels":[]}\n```' }))

    expect((await new TestClient(undefined, respondWith(fenced).fetch, COMPATIBLE_URL).generateJson(JSON_REQUEST, 0, 1)).data).toEqual({ summary: 'ok', labels: [] })
    expect(await failureOf(new TestClient('test-key', respondWith(fenced).fetch).generateJson(JSON_REQUEST, 0, 1))).toEqual({
      message: 'Unable to parse JSON from OpenAI response',
      failure: { kind: 'retryable' },
    })
  })

  it('keeps a </think> that is part of a JSON answer', async () => {
    const { fetch } = respondWith(() => jsonResponse(completion({ content: '{"summary":"Closes a stray </think> tag","labels":[]}' })))

    expect(await new TestClient(undefined, fetch, COMPATIBLE_URL).generateJson(JSON_REQUEST, 0, 1)).toMatchObject({
      data: { summary: 'Closes a stray </think> tag', labels: [] },
      thoughts: '',
    })
  })

  it.each([
    ['a <think> block', '<think>Group the changes.</think>\n## Fixes\n- Crash on save\n'],
    ['a <think> block opened by the chat template', 'Group the changes.\n</think>\n\n## Fixes\n- Crash on save\n'],
  ])('returns trimmed text without the thoughts from a text call with %s', async (_label, content) => {
    const { fetch } = respondWith(() => jsonResponse(completion({ content })))

    expect(await new TestClient(undefined, fetch, COMPATIBLE_URL).generateText(TEXT_REQUEST, 0, 1)).toEqual({
      text: '## Fixes\n- Crash on save',
      inputTokens: 1200,
      cachedInputTokens: 1024,
      outputTokens: 50,
      thoughtsTokens: 250,
      cacheWriteTokens: 0,
    })
  })

  // Release notes for reasoning-model tooling quote the tag, and nothing may be cut from them.
  it('keeps a </think> quoted in a text answer, on OpenAI and on a compatible host', async () => {
    const content = '## Fixes\n- Reasoning models: strip the `</think>` tag from streamed output (#812)\n- Fix crash on save (#7)'
    for (const client of [
      new TestClient('test-key', respondWith(() => jsonResponse(completion({ content }))).fetch),
      new TestClient(undefined, respondWith(() => jsonResponse(completion({ content }))).fetch, COMPATIBLE_URL),
    ]) {
      expect((await client.generateText(TEXT_REQUEST, 0, 1)).text).toBe(content)
    }
  })

  it('keeps a </think> inside fenced JSON on a best-effort host', async () => {
    const { fetch } = respondWith(() => jsonResponse(completion({ content: '```json\n{"summary":"Model output leaks a stray </think> tag","labels":["bug"]}\n```' })))

    expect((await new TestClient(undefined, fetch, COMPATIBLE_URL).generateJson(JSON_REQUEST, 0, 1)).data).toEqual({
      summary: 'Model output leaks a stray </think> tag',
      labels: ['bug'],
    })
  })

  it('sends explicit prompt caching on text calls to GPT-6.x only', async () => {
    const bodyFor = async (model: string) => {
      const { sent, fetch } = respondWith(() => jsonResponse(completion({ content: 'Notes' })))
      await new TestClient('test-key', fetch).generateText({ ...TEXT_REQUEST, model }, 0, 1)
      return JSON.parse(sent[0]!.body) as Record<string, unknown>
    }

    expect((await bodyFor('gpt-6.1-sol')).prompt_cache_options).toEqual({ mode: 'explicit' })
    expect((await bodyFor('gpt-4o-mini')).prompt_cache_options).toBeUndefined()
  })

  it('throws a refusal, without retrying', async () => {
    const { sent, fetch } = respondWith(() => jsonResponse(completion({ content: null, refusal: 'I can\'t help with that.' })))

    expect(await failureOf(new TestClient('test-key', fetch).generateJson(JSON_REQUEST, 2, 1))).toEqual({
      message: 'OpenAI declined to answer: I can\'t help with that.',
      failure: { kind: 'refusal' },
    })
    expect(sent).toHaveLength(1)
  })

  it('throws a content filter stop as a refusal, naming the host', async () => {
    const { fetch } = respondWith(() => jsonResponse({ ...completion({ content: '' }), choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'content_filter' }] }))

    expect(await failureOf(new TestClient('test-key', fetch, COMPATIBLE_URL).generateJson(JSON_REQUEST, 2, 1))).toEqual({
      message: 'openrouter.ai stopped the reply with its content filter (finish_reason content_filter)',
      failure: { kind: 'refusal' },
    })
  })

  it('throws a reply cut off by the token limit as truncated', async () => {
    const { fetch } = respondWith(() => jsonResponse({ ...REPLY, choices: [{ index: 0, message: { role: 'assistant', content: '{"summary":' }, finish_reason: 'length' }] }))

    expect(await failureOf(new TestClient('test-key', fetch).generateText(TEXT_REQUEST, 2, 1))).toEqual({
      message: 'OpenAI stopped at the output token limit (finish_reason length)',
      failure: { kind: 'truncated' },
    })
  })

  it('retries an empty, thoughts-only or unparsable reply on the caller budget', async () => {
    const { sent, fetch } = respondWith(
      () => jsonResponse(completion({ content: null })),
      () => jsonResponse(completion({ content: '<think>Hmm.</think>' })),
      () => jsonResponse(completion({ content: 'not json' })),
      () => jsonResponse(REPLY)
    )
    const client = new TestClient(undefined, fetch, COMPATIBLE_URL)

    expect((await client.generateJson(JSON_REQUEST, 3, 100)).data).toEqual({ summary: 'ok', labels: ['bug'] })
    expect(sent).toHaveLength(4)
    expect(client.sleeps).toEqual([100, 200, 400])

    const { fetch: emptyFetch } = respondWith(() => jsonResponse(completion({ content: ' ' })))
    expect(await failureOf(new TestClient('test-key', emptyFetch).generateJson(JSON_REQUEST, 0, 1))).toEqual({
      message: 'OpenAI responded with empty text',
      failure: { kind: 'retryable' },
    })
  })
})

describe('Chat Completions errors', () => {
  // Each status and body OpenAI documents, and how a call that gets it fails.
  const cases: Array<[label: string, status: number, body: unknown, expected: ModelError['failure']]> = [
    ['a bad key', 401, errorBody('Incorrect API key provided: sk-test.', 'invalid_request_error', 'invalid_api_key'), { kind: 'fatal', cause: 'auth' }],
    ['an unsupported region', 403, errorBody('Country, region, or territory not supported', 'request_forbidden', 'unsupported_country_region_territory'), { kind: 'fatal', cause: 'auth' }],
    ['an unknown model', 404, errorBody('The model `gpt-nope` does not exist or you do not have access to it.', 'invalid_request_error', 'model_not_found'), { kind: 'fatal', cause: 'model' }],
    ['no quota', 429, errorBody('You exceeded your current quota, please check your plan and billing details.', 'insufficient_quota', 'insufficient_quota'), { kind: 'fatal', cause: 'quota' }],
    ['no credit', 429, errorBody('Your credit balance is exhausted.', 'insufficient_quota', 'credit_balance_exhausted'), { kind: 'fatal', cause: 'quota' }],
    ['the organization spend limit', 429, errorBody('You have reached your organization spend limit.', 'insufficient_quota', 'organization_spend_limit_exceeded'), { kind: 'fatal', cause: 'quota' }],
    ['the project spend limit', 429, errorBody('You have reached your project spend limit.', 'insufficient_quota', 'project_spend_limit_exceeded'), { kind: 'fatal', cause: 'quota' }],
    ['the organization usage limit', 429, errorBody('You have reached your organization usage limit.', 'insufficient_quota', 'organization_usage_limit_exceeded'), { kind: 'fatal', cause: 'quota' }],
    ['a bad request', 400, errorBody('Invalid value for \'reasoning_effort\': \'extreme\'.', 'invalid_request_error', 'invalid_value', 'reasoning_effort'), { kind: 'permanent' }],
  ]

  it.each(cases)('fails at once on %s', async (_label, status, body, expected) => {
    const { sent, fetch } = respondWith(() => jsonResponse(body, status))
    const client = new TestClient('test-key', fetch)

    expect(await failureOf(client.generateJson(JSON_REQUEST, 2, 1))).toEqual({ message: JSON.stringify(body), failure: expected })
    expect(sent).toHaveLength(1)
    expect(warn).not.toHaveBeenCalled()
  })

  it('waits out rate limits and overloads on the capacity schedule, with Retry-After as a floor', async () => {
    const { sent, fetch } = respondWith(
      () => jsonResponse(errorBody('Rate limit reached for gpt-6-luna on tokens per min (TPM).', 'tokens', 'rate_limit_exceeded'), 429, { 'retry-after': '45' }),
      () => jsonResponse(errorBody('Traffic ramped up too fast.', 'rate_limit_error', 'slow_down'), 429),
      () => jsonResponse(errorBody('The server is overloaded.', 'service_unavailable_error', 'server_is_overloaded'), 503),
      () => jsonResponse(REPLY)
    )
    const client = new TestClient('test-key', fetch)

    expect((await client.generateJson(JSON_REQUEST, 0, 1)).data).toEqual({ summary: 'ok', labels: ['bug'] })
    expect(sent).toHaveLength(4)
    expect(client.sleeps).toEqual([45_000, 20_000, 40_000])
  })

  it('retries server errors on the caller budget', async () => {
    const { sent, fetch } = respondWith(
      () => jsonResponse(errorBody('The server had an error while processing your request.', 'server_error'), 500),
      () => new Response('Bad Gateway', { status: 502, headers: { 'content-type': 'text/plain' } }),
      () => new Response('Gateway Timeout', { status: 504, headers: { 'content-type': 'text/plain' } }),
      () => jsonResponse(REPLY)
    )
    const client = new TestClient('test-key', fetch)

    expect((await client.generateJson(JSON_REQUEST, 3, 100)).data).toEqual({ summary: 'ok', labels: ['bug'] })
    expect(sent).toHaveLength(4)
    expect(client.sleeps).toEqual([100, 200, 400])
  })

  it('fails a model that rejects the official request as an unusable model, without dropping the parameter', async () => {
    const body = errorBody('Unsupported parameter: \'reasoning_effort\' is not supported with this model.', 'invalid_request_error', 'unsupported_parameter', 'reasoning_effort')
    const { sent, fetch } = respondWith(() => jsonResponse(body, 400))

    expect(await failureOf(new TestClient('test-key', fetch).generateJson({ ...JSON_REQUEST, model: 'gpt-4.1' }, 2, 1))).toEqual({
      message: `gpt-4.1 does not support the official request. The supported family is GPT-6.x, such as gpt-6-luna. ${JSON.stringify(body)}`,
      failure: { kind: 'fatal', cause: 'model' },
    })
    expect(sent).toHaveLength(1)
    expect(warn).not.toHaveBeenCalled()
  })

  it('throws a prompt stopped by a content filter as a refusal, without retrying', async () => {
    const body = { error: { message: 'The response was filtered due to the prompt triggering Azure OpenAI\'s content management policy.', type: null, param: 'prompt', code: 'content_filter', status: 400 } }
    const { sent, fetch } = respondWith(() => jsonResponse(body, 400))

    expect(await failureOf(new TestClient('test-key', fetch, 'https://res.openai.azure.com/openai/v1').generateJson(JSON_REQUEST, 2, 1))).toEqual({
      message: `res.openai.azure.com stopped the prompt with its content filter: ${JSON.stringify(body)}`,
      failure: { kind: 'refusal' },
    })
    expect(sent).toHaveLength(1)
    expect(warn).not.toHaveBeenCalled()
  })

  it.each(schemaLimits)('drops the enums on list items once the schema is too large, for the rest of the run: %s', async limit => {
    const body = errorBody(limit, 'invalid_request_error', null, 'response_format')
    const { sent, fetch } = respondWith(() => jsonResponse(body, 400), () => jsonResponse(REPLY))
    const client = new TestClient('test-key', fetch)

    await client.generateJson(JSON_REQUEST, 0, 1)
    await client.generateJson(JSON_REQUEST, 0, 1)

    const schemas = sent.map(request => JSON.parse(request.body).response_format.json_schema.schema)
    expect(schemas[0].properties.labels.items).toEqual({ type: 'string', enum: ['bug', 'enhancement'] })
    expect(schemas[1].properties.labels.items).toEqual({ type: 'string' })
    expect(schemas[2]).toEqual(schemas[1])
    expect(sent).toHaveLength(3)
    expect(client.sleeps).toEqual([])
    expect(warn).toHaveBeenCalledOnce()
    expect(warn.mock.calls[0]![0]).toContain('OpenAI rejected the response schema as too large or complex')
  })

  it('fails as permanent when even the relaxed schema is too large', async () => {
    const body = errorBody('Invalid schema for response_format \'triage_plan\': schema exceeds the maximum size.', 'invalid_request_error', null, 'response_format')
    const { sent, fetch } = respondWith(() => jsonResponse(body, 400))

    expect(await failureOf(new TestClient('test-key', fetch).generateJson(JSON_REQUEST, 2, 1))).toEqual({
      message: JSON.stringify(body),
      failure: { kind: 'permanent' },
    })
    expect(sent).toHaveLength(2)
  })
})

describe('OpenAI-compatible errors', () => {
  it('leaves off each parameter a host rejects for the rest of the run, with one warning each', async () => {
    const { sent, fetch } = respondWith(
      () => jsonResponse(errorBody('Unrecognized request argument supplied: reasoning_effort', 'invalid_request_error'), 400),
      // Hosts that validate with Pydantic answer 422 and name the field in `loc`.
      () => jsonResponse({ detail: [{ type: 'extra_forbidden', loc: ['body', 'store'], msg: 'Extra inputs are not permitted', input: false }] }, 422),
      () => jsonResponse(REPLY)
    )
    const client = new TestClient('test-key', fetch, COMPATIBLE_URL)

    await client.generateJson(JSON_REQUEST, 0, 1)
    await client.generateText(TEXT_REQUEST, 0, 1)
    await client.generateJson(JSON_REQUEST, 0, 1)

    const bodies = sent.map(request => JSON.parse(request.body))
    expect(Object.keys(bodies[0])).toEqual(['model', 'messages', 'response_format', 'reasoning_effort', 'store', 'max_completion_tokens'])
    expect(Object.keys(bodies[1])).toEqual(['model', 'messages', 'response_format', 'store', 'max_completion_tokens'])
    expect(Object.keys(bodies[2])).toEqual(['model', 'messages', 'response_format', 'max_completion_tokens'])
    expect(Object.keys(bodies[3])).toEqual(['model', 'messages'])
    expect(Object.keys(bodies[4])).toEqual(['model', 'messages', 'response_format', 'max_completion_tokens'])
    expect(sent).toHaveLength(5)
    expect(client.sleeps).toEqual([])
    expect(warn.mock.calls.map(call => String(call[0]).split(':')[0])).toEqual([
      'openrouter.ai rejected reasoning_effort, so it is left off for the rest of the run',
      'openrouter.ai rejected store, so it is left off for the rest of the run',
    ])
  })

  it('steps a rejected strict schema down to JSON mode, keeping the schema in the prompt', async () => {
    const { sent, fetch } = respondWith(
      () => jsonResponse(errorBody('This response_format type is unavailable now', 'invalid_request_error'), 400),
      () => jsonResponse(REPLY)
    )
    const client = new TestClient('test-key', fetch, 'https://api.deepseek.com')

    await client.generateJson(JSON_REQUEST, 0, 1)
    await client.generateJson(JSON_REQUEST, 0, 1)

    const bodies = sent.map(request => JSON.parse(request.body))
    expect(bodies[0].response_format.type).toBe('json_schema')
    expect(bodies[1].response_format).toEqual({ type: 'json_object' })
    expect(bodies[1].messages[1].content).toBe(`${USER_PROMPT.trimEnd()}\n\n${NOTE}`)
    expect(bodies[2]).toEqual(bodies[1])
    expect(warn).toHaveBeenCalledOnce()
    expect(warn.mock.calls[0]![0]).toContain('api.deepseek.com rejected the strict response schema, so JSON mode is used for the rest of the run')
  })

  it('drops the enums rather than the strict schema when a host rejects the schema as too large', async () => {
    const { sent, fetch } = respondWith(
      () => jsonResponse(errorBody(schemaLimits[0]!, 'invalid_request_error', null, 'response_format'), 400),
      () => jsonResponse(REPLY)
    )

    await new TestClient('test-key', fetch, 'https://res.openai.azure.com/openai/v1').generateJson(JSON_REQUEST, 0, 1)

    const bodies = sent.map(request => JSON.parse(request.body))
    expect(bodies[1].response_format.type).toBe('json_schema')
    expect(bodies[1].response_format.json_schema.schema.properties.labels.items).toEqual({ type: 'string' })
  })

  it('leaves the response format off when JSON mode is rejected too', async () => {
    const rejected = () => jsonResponse(errorBody('response_format is not supported by this model', 'invalid_request_error'), 400)
    const { sent, fetch } = respondWith(rejected, rejected, () => jsonResponse(REPLY))

    await new TestClient(undefined, fetch, 'http://127.0.0.1:1234/v1').generateJson(JSON_REQUEST, 0, 1)

    const bodies = sent.map(request => JSON.parse(request.body))
    expect(bodies.map(body => body.response_format?.type)).toEqual(['json_schema', 'json_object', undefined])
    expect(Object.keys(bodies[2])).toEqual(['model', 'messages', 'reasoning_effort', 'store', 'max_completion_tokens'])
  })

  it('fails as permanent on a 400 that names nothing it can leave off', async () => {
    const body = errorBody('messages: at least one message is required', 'invalid_request_error')
    const { sent, fetch } = respondWith(() => jsonResponse(body, 400))

    expect(await failureOf(new TestClient('test-key', fetch, COMPATIBLE_URL).generateJson(JSON_REQUEST, 2, 1))).toEqual({
      message: JSON.stringify(body),
      failure: { kind: 'permanent' },
    })
    expect(sent).toHaveLength(1)
    expect(warn).not.toHaveBeenCalled()
  })

  it('fails as permanent when a host rejects a parameter it already left off', async () => {
    const body = errorBody('Unrecognized request argument supplied: store', 'invalid_request_error')
    const { sent, fetch } = respondWith(() => jsonResponse(body, 400))

    expect(await failureOf(new TestClient('test-key', fetch, COMPATIBLE_URL).generateText(TEXT_REQUEST, 2, 1))).toEqual({
      message: JSON.stringify(body),
      failure: { kind: 'permanent' },
    })
    expect(sent).toHaveLength(2)
  })

  it('fails a billing error at once, even when it names a parameter', async () => {
    const body = errorBody('You exceeded your current quota for reasoning_effort requests.', 'insufficient_quota', 'insufficient_quota')
    const { sent, fetch } = respondWith(() => jsonResponse(body, 400))

    expect(await failureOf(new TestClient('test-key', fetch, COMPATIBLE_URL).generateJson(JSON_REQUEST, 2, 1))).toEqual({
      message: JSON.stringify(body),
      failure: { kind: 'fatal', cause: 'quota' },
    })
    expect(sent).toHaveLength(1)
  })
})
