import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { ChatClient, createModelFetch, errorMessage, MODEL_TIMEOUT_MS, ModelError, type Fetch, type JsonRequest } from '../../src/llm/chat'

const SCHEMA = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false }
const REQUEST: JsonRequest = { model: 'test-model', systemPrompt: 'system', userPrompt: 'user', schema: SCHEMA }
const OPENAI = { baseUrl: 'https://api.openai.com/v1', host: 'api.openai.com', apiKey: 'test-key', keyName: 'OPENAI_API_KEY' }
const CLAUDE = { baseUrl: 'https://api.anthropic.com/v1', host: 'api.anthropic.com', apiKey: 'test-key', keyName: 'ANTHROPIC_API_KEY' }

function reply(content: unknown, extra: Record<string, unknown> = {}) {
  return { choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop', ...extra }], usage: { prompt_tokens: 100, completion_tokens: 30 } }
}

// Answers each request with the next response, and records the request bodies, so no request leaves the process.
function stubFetch(...responses: Array<unknown | Response>): Fetch & { bodies: any[] } {
  const bodies: any[] = []
  const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)))
    const next = responses.shift()
    if (next === undefined) throw new Error('unexpected request')
    return next instanceof Response ? next : new Response(JSON.stringify(next), { headers: { 'content-type': 'application/json' } })
  })
  return Object.assign(fetch as unknown as Fetch, { bodies })
}

function error(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
}

let sleep: MockInstance
let warn: MockInstance

beforeEach(() => {
  // Retries wait on the real clock otherwise.
  sleep = vi.spyOn(ChatClient.prototype as any, 'sleep').mockResolvedValue(undefined)
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('ChatClient requests', () => {
  it('asks a host that enforces schemas for strict JSON and high reasoning, and leaves the prompt alone', async () => {
    const fetch = stubFetch(reply('{"ok":true}'))

    const result = await new ChatClient(OPENAI, fetch).generateJson(REQUEST, data => data)

    expect(result.data).toEqual({ ok: true })
    expect(fetch.bodies[0]).toEqual({
      model: 'test-model',
      messages: [{ role: 'system', content: 'system' }, { role: 'user', content: 'user' }],
      response_format: { type: 'json_schema', json_schema: { name: 'response', strict: true, schema: SCHEMA } },
      reasoning_effort: 'high',
    })
  })

  it('also writes the schema into the prompt for a host that may not enforce it', async () => {
    const fetch = stubFetch(reply('{"ok":true}'))

    await new ChatClient(CLAUDE, fetch).generateJson(REQUEST, data => data)

    const userPrompt: string = fetch.bodies[0].messages[1].content
    expect(userPrompt.startsWith('user\n\n=== SECTION: RESPONSE FORMAT ===')).toBe(true)
    expect(userPrompt.endsWith(JSON.stringify(SCHEMA))).toBe(true)
    expect(fetch.bodies[0].response_format).toBeDefined()
  })

  it('sends a text call with only the model and messages', async () => {
    const fetch = stubFetch(reply('  Release notes  '))

    const result = await new ChatClient(OPENAI, fetch).generateText(REQUEST)

    expect(result.text).toBe('Release notes')
    expect(fetch.bodies[0]).toEqual({ model: 'test-model', messages: [{ role: 'system', content: 'system' }, { role: 'user', content: 'user' }] })
  })

  it('leaves off a parameter the host rejects for the rest of the run, and gives the format in the prompt without response_format', async () => {
    const fetch = stubFetch(
      error(400, { error: { message: "Unsupported parameter: 'reasoning_effort' is not supported with this model.", param: 'reasoning_effort' } }),
      error(400, { error: { message: 'response_format json_schema is not supported' } }),
      reply('{"ok":true}'),
      reply('{"ok":true}'),
    )
    const client = new ChatClient(OPENAI, fetch)

    await client.generateJson(REQUEST, data => data)
    await client.generateJson(REQUEST, data => data)

    expect(fetch.bodies.map(body => Object.keys(body).sort())).toEqual([
      ['messages', 'model', 'reasoning_effort', 'response_format'],
      ['messages', 'model', 'response_format'],
      ['messages', 'model'],
      ['messages', 'model'],
    ])
    expect(fetch.bodies[2].messages[1].content).toContain('=== SECTION: RESPONSE FORMAT ===')
    expect(warn).toHaveBeenCalledTimes(2)
    expect(sleep).not.toHaveBeenCalled()
  })
})

describe('ChatClient replies', () => {
  it('reads the answer and usage, with reasoning counted on its own', async () => {
    const fetch = stubFetch({
      choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1000, prompt_tokens_details: { cached_tokens: 800 }, completion_tokens: 300, completion_tokens_details: { reasoning_tokens: 250 } },
    })

    const result = await new ChatClient(OPENAI, fetch).generateJson(REQUEST, data => data)

    expect(result).toEqual({ data: { ok: true }, inputTokens: 1000, cachedInputTokens: 800, outputTokens: 50, reasoningTokens: 250 })
  })

  it('takes text parts, and drops a leading <think> block and a code fence', async () => {
    const fetch = stubFetch(
      reply([{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: '{"ok":' }, { type: 'text', text: 'true}' }]),
      reply('<think>Reasoning about {braces}.</think>\n```json\n{"ok":true}\n```'),
    )
    const client = new ChatClient(CLAUDE, fetch)

    expect((await client.generateJson(REQUEST, data => data)).data).toEqual({ ok: true })
    expect((await client.generateJson(REQUEST, data => data)).data).toEqual({ ok: true })
  })

  it('retries a reply that is empty, not JSON, or rejected by the parser, and then fails', async () => {
    const fetch = stubFetch(reply(''), reply('not json'), reply('{"ok":false}'))
    const parse = (data: unknown) => {
      if ((data as { ok: boolean }).ok !== true) throw new Error('not ok')
      return data
    }

    const failure = await new ChatClient(OPENAI, fetch).generateJson(REQUEST, parse).catch((err: unknown) => err)

    expect(failure).toBeInstanceOf(ModelError)
    expect(failure).toMatchObject({ kind: 'retryable', message: 'not ok' })
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([5000, 10000])
  })

  it.each([
    [reply(null, { message: { refusal: 'I cannot help with that.' } }), 'api.openai.com declined to answer: I cannot help with that.'],
    [reply('', { finish_reason: 'content_filter' }), 'api.openai.com stopped the reply with its content filter'],
    [reply('{"ok":', { finish_reason: 'length' }), 'api.openai.com stopped the reply at the output token limit'],
  ])('fails a refused or cut-off reply without retrying', async (response, message) => {
    const fetch = stubFetch(response)

    await expect(new ChatClient(OPENAI, fetch).generateJson(REQUEST, data => data)).rejects.toMatchObject({ kind: 'permanent', message })
    expect(fetch).toHaveBeenCalledOnce()
  })
})

describe('ChatClient errors', () => {
  it.each([
    [401, { error: { message: 'Incorrect API key provided' } }, ' Check OPENAI_API_KEY.'],
    [400, [{ error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT' } }], ' Check OPENAI_API_KEY.'],
    [404, { error: { message: 'The model `nope` does not exist' } }, ' Check the model name.'],
    [429, { error: { message: 'You exceeded your current quota', code: 'insufficient_quota' } }, ' Check the account\'s billing.'],
  ])('fails at once on HTTP %i, which every later call would hit too', async (status, body, hint) => {
    const fetch = stubFetch(error(status, body))

    const failure = await new ChatClient(OPENAI, fetch).generateJson(REQUEST, data => data).catch((err: unknown) => err)

    expect(failure).toMatchObject({ kind: 'fatal', message: `api.openai.com returned HTTP ${status}: ${JSON.stringify(body)}${hint}` })
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('waits out an overload on the long schedule, at least as long as Retry-After asks', async () => {
    const overloaded = () => error(503, { error: { status: 'UNAVAILABLE' } })
    const fetch = stubFetch(error(429, { error: { message: 'Rate limited' } }, { 'retry-after': '30' }), overloaded(), overloaded(), overloaded(), overloaded(), overloaded(), overloaded())

    const failure = await new ChatClient(OPENAI, fetch).generateJson(REQUEST, data => data).catch((err: unknown) => err)

    expect(failure).toMatchObject({ kind: 'capacity' })
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([30000, 20000, 40000, 60000, 60000, 60000])
  })

  it('retries a server error twice, and fails any other 4xx at once', async () => {
    const serverError = stubFetch(error(500, 'oops'), error(502, 'oops'), reply('{"ok":true}'))
    expect((await new ChatClient(OPENAI, serverError).generateJson(REQUEST, data => data)).data).toEqual({ ok: true })

    const badRequest = stubFetch(error(400, { error: { message: 'messages too long' } }))
    await expect(new ChatClient(OPENAI, badRequest).generateJson(REQUEST, data => data)).rejects.toMatchObject({ kind: 'permanent' })
    expect(badRequest).toHaveBeenCalledOnce()
  })

  it('gives up on a request that runs past the deadline, and retries it', async () => {
    vi.useFakeTimers()
    const fetch = vi.fn<Fetch>((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('This operation was aborted', 'AbortError')))
    }))
    const call = new ChatClient(OPENAI, fetch).generateText(REQUEST).catch((err: unknown) => err)

    for (let attempt = 0; attempt < 3; attempt++) await vi.advanceTimersByTimeAsync(MODEL_TIMEOUT_MS)

    expect(await call).toMatchObject({ kind: 'retryable', message: `api.openai.com did not respond within ${MODEL_TIMEOUT_MS / 1000}s` })
    expect(fetch).toHaveBeenCalledTimes(3)
  })
})

describe('transport', () => {
  // Node's real 300s cap is too slow to test, so a local server holds back its headers briefly and the dispatcher gets a shorter timeout instead.
  // undici only checks this timeout about every half second, so the server waits well past it.
  const HEADERS_DELAY_MS = 2000
  const SHORT_DISPATCHER_TIMEOUT_MS = 100
  const REPLY = reply('{"ok":true}')

  let server: Server
  let baseUrl: string
  const requests: Array<{ path: string; headers: IncomingHttpHeaders }> = []

  beforeAll(async () => {
    server = createServer((req, res) => {
      requests.push({ path: req.url ?? '', headers: req.headers })
      if (req.url?.startsWith('/moved/')) {
        res.writeHead(308, { location: `${baseUrl}/v1/chat/completions` })
        res.end()
        return
      }
      const delay = req.url?.startsWith('/slow/') ? HEADERS_DELAY_MS : 0
      const timer = setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(REPLY))
      }, delay)
      res.on('close', () => clearTimeout(timer))
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(() => {
    server.closeAllConnections()
    server.close()
  })

  beforeEach(() => {
    requests.length = 0
  })

  it('waits for slow headers by default, and goes through its own dispatcher', async () => {
    const timedOut = createModelFetch(SHORT_DISPATCHER_TIMEOUT_MS)(`${baseUrl}/slow/`).catch((err: unknown) => err)
    const completed = createModelFetch()(`${baseUrl}/slow/`)

    expect(errorMessage(await timedOut)).toBe('fetch failed (UND_ERR_HEADERS_TIMEOUT)')
    expect(await (await completed).json()).toEqual(REPLY)
  })

  // The deadline's AbortSignal comes from Node's built-in undici, so this proves undici's own fetch still honors it.
  it('honors an abort signal', async () => {
    await expect(createModelFetch()(`${baseUrl}/slow/`, { signal: AbortSignal.timeout(100) })).rejects.toMatchObject({ name: 'TimeoutError' })
  })

  // Node's built-in fetch only honors proxy variables with NODE_USE_ENV_PROXY=1, and model traffic must keep doing the same.
  it('uses the proxy from the environment only when NODE_USE_ENV_PROXY=1', async () => {
    const tunnels: string[] = []
    const proxy = createServer()
    proxy.on('connect', (req, socket) => {
      tunnels.push(req.url ?? '')
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n')
    })
    await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve))

    try {
      vi.stubEnv('http_proxy', `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`)
      vi.stubEnv('no_proxy', '')
      vi.stubEnv('NODE_USE_ENV_PROXY', '1')
      const proxied = createModelFetch()(baseUrl)
      vi.stubEnv('NODE_USE_ENV_PROXY', '')
      const direct = createModelFetch()(baseUrl)

      await expect(proxied).rejects.toThrow('fetch failed')
      expect(tunnels).toEqual([new URL(baseUrl).host])
      expect(await (await direct).json()).toEqual(REPLY)
      expect(tunnels).toHaveLength(1)
    } finally {
      vi.unstubAllEnvs()
      proxy.close()
    }
  })

  it('posts to /chat/completions with the key as a Bearer token, or with no Authorization header when there is no key', async () => {
    const endpoint = { baseUrl: `${baseUrl}/v1`, host: 'local', keyName: 'OPENAI_API_KEY' }
    await new ChatClient({ ...endpoint, apiKey: 'test-key' }).generateJson(REQUEST, data => data)
    await new ChatClient({ ...endpoint, apiKey: undefined }).generateText(REQUEST)

    expect(requests.map(request => request.path)).toEqual(['/v1/chat/completions', '/v1/chat/completions'])
    expect(requests.map(request => request.headers.authorization)).toEqual(['Bearer test-key', undefined])
  })

  // The redirect target would receive the key and the issue text, so the request fails instead of following it.
  it('fails a redirected request without following it or retrying', async () => {
    const client = new ChatClient({ baseUrl: `${baseUrl}/moved/v1`, host: 'local', apiKey: 'test-key', keyName: 'OPENAI_API_KEY' })

    await expect(client.generateJson(REQUEST, data => data)).rejects.toMatchObject({
      kind: 'permanent',
      message: 'local redirected the request (HTTP 308), and redirects are not followed because the request carries the API key.',
    })
    expect(requests.map(request => request.path)).toEqual(['/moved/v1/chat/completions'])
  })
})
