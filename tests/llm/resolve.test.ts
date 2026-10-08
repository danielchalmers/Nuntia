import { describe, expect, it } from 'vitest'
import { describeModel, ModelResolutionError, resolveModel, type ModelEnv, type ResolvedModel } from '../../src/llm/resolve'

// Each action passes its own defaults; these are AutoTriage's.
const DEFAULTS = { gemini: 'gemini-3.5-flash-lite', anthropic: 'claude-haiku-5-5', openai: 'gpt-6-luna' }

const G = { GEMINI_API_KEY: 'gemini-key' }
const A = { ANTHROPIC_API_KEY: 'anthropic-key' }
const O = { OPENAI_API_KEY: 'openai-key' }
const OPENROUTER = { OPENAI_BASE_URL: 'https://openrouter.ai/api/v1' }
const OLLAMA = { OPENAI_BASE_URL: 'http://localhost:11434/v1' }

function resolve(value: string, env: ModelEnv, input = 'model-pro'): ResolvedModel {
  return resolveModel({ input, value, env, defaults: DEFAULTS })
}

type Vector = [label: string, value: string, env: ModelEnv, expected: Partial<ResolvedModel>]

describe('resolveModel', () => {
  describe('blank input', () => {
    const vectors: Vector[] = [
      ['Gemini keeps the model it had before other providers', '', G, { provider: 'gemini', model: 'gemini-3.5-flash-lite', tier: 'official', apiKey: 'gemini-key', isDefault: true, reason: 'default for GEMINI_API_KEY' }],
      ['Anthropic', '', A, { provider: 'anthropic', model: 'claude-haiku-5-5', tier: 'official', apiKey: 'anthropic-key', baseUrl: 'https://api.anthropic.com', reason: 'default for ANTHROPIC_API_KEY' }],
      ['OpenAI', '', O, { provider: 'openai', model: 'gpt-6-luna', tier: 'official', baseUrl: 'https://api.openai.com/v1', reason: 'default for OPENAI_API_KEY' }],
      ['several keys, Gemini first', '', { ...O, ...A, ...G }, { provider: 'gemini', model: 'gemini-3.5-flash-lite' }],
      ['Anthropic before OpenAI', '', { ...O, ...A }, { provider: 'anthropic', model: 'claude-haiku-5-5' }],
      ['OPENAI_BASE_URL does not stop another key default', '', { ...G, ...O, ...OPENROUTER }, { provider: 'gemini', model: 'gemini-3.5-flash-lite' }],
      ['an empty key is absent, as on fork PRs', '', { GEMINI_API_KEY: '', ANTHROPIC_API_KEY: '  ', ...O }, { provider: 'openai', model: 'gpt-6-luna' }],
    ]

    it.each(vectors)('%s', (_label, value, env, expected) => {
      expect(resolve(value, env)).toMatchObject(expected)
    })

    it('needs an explicit model when OPENAI_BASE_URL is the only route', () => {
      for (const env of [{ ...O, ...OPENROUTER }, OPENROUTER]) {
        expect(() => resolve('', env)).toThrow('model-pro is blank, and OPENAI_BASE_URL (openrouter.ai) has no default model. Set model-pro to a model that endpoint serves.')
      }
    })

    it('names every accepted key when none is set, and ignores ambient credentials', () => {
      const ambient = { AWS_ACCESS_KEY_ID: 'x', AWS_SECRET_ACCESS_KEY: 'x', GOOGLE_APPLICATION_CREDENTIALS: '/creds.json', GITHUB_TOKEN: 'x' } as ModelEnv
      for (const env of [{}, ambient]) {
        expect(() => resolve('', env)).toThrow(ModelResolutionError)
        expect(() => resolve('  ', env)).toThrow('model-pro is blank and no model API key is set. Add GEMINI_API_KEY, ANTHROPIC_API_KEY or OPENAI_API_KEY as a secret and map it in the step\'s env. Secrets are not passed to workflows triggered from forks.')
      }
    })
  })

  describe('named models', () => {
    const vectors: Vector[] = [
      ['a recognized Claude name', 'claude-haiku-5-5', { ...G, ...A }, { provider: 'anthropic', model: 'claude-haiku-5-5', tier: 'official', isDefault: false, reason: 'set by model-pro' }],
      ['another Claude 5.5 model', 'claude-sonnet-5-5', A, { provider: 'anthropic', tier: 'official' }],
      ['an older Claude model is best effort', 'claude-haiku-4-5', A, { provider: 'anthropic', model: 'claude-haiku-4-5', tier: 'best-effort' }],
      ['a dotted Claude ID is sent as given', 'claude-sonnet-5.5', A, { provider: 'anthropic', model: 'claude-sonnet-5.5', tier: 'best-effort' }],
      ['a Gemini 3.x name', 'gemini-3.8-flash', { ...G, ...A }, { provider: 'gemini', model: 'gemini-3.8-flash', tier: 'official' }],
      ['a Gemini -latest alias', 'gemini-flash-latest', G, { provider: 'gemini', tier: 'official' }],
      ['a Gemini preview name', 'gemini-3-flash-preview', G, { provider: 'gemini', tier: 'official' }],
      ['an older Gemini model is best effort', 'gemini-2.5-flash', G, { provider: 'gemini', tier: 'best-effort' }],
      ['a models/ name is unchanged', 'models/gemini-3.5-flash', { ...G, ...O }, { provider: 'gemini', model: 'models/gemini-3.5-flash', tier: 'official' }],
      ['a tunedModels/ name is unchanged', 'tunedModels/triage-123', { ...G, ...O }, { provider: 'gemini', model: 'tunedModels/triage-123', tier: 'best-effort' }],
      ['a GPT-6 name', 'gpt-6-luna', { ...G, ...O }, { provider: 'openai', model: 'gpt-6-luna', tier: 'official' }],
      ['a GPT-6.x name', 'gpt-6.1-sol', O, { provider: 'openai', tier: 'official' }],
      ['an older GPT model is best effort', 'gpt-5.6-luna', O, { provider: 'openai', tier: 'best-effort' }],
      ['a fine-tuned GPT name', 'ft:gpt-4o-mini-2024-07-18:org::abc', { ...G, ...O }, { provider: 'openai', model: 'ft:gpt-4o-mini-2024-07-18:org::abc', tier: 'best-effort' }],
      ['surrounding whitespace is trimmed', '  claude-haiku-5-5 ', A, { model: 'claude-haiku-5-5' }],
    ]

    it.each(vectors)('%s', (_label, value, env, expected) => {
      expect(resolve(value, env)).toMatchObject(expected)
    })

    it('asks for the key a recognized name needs', () => {
      expect(() => resolve('claude-haiku-5-5', G)).toThrow('model-pro "claude-haiku-5-5" is served by anthropic, which needs ANTHROPIC_API_KEY, and it is not set.')
      expect(() => resolve('gpt-6-luna', { ...G, ...A }, 'model-fast')).toThrow('model-fast "gpt-6-luna" is served by openai, which needs OPENAI_API_KEY')
      expect(() => resolve('gemini-3.5-flash', {})).toThrow('needs GEMINI_API_KEY')
    })
  })

  describe('provider prefixes', () => {
    const vectors: Vector[] = [
      ['an explicit provider', 'anthropic/claude-sonnet-5-5', { ...G, ...A }, { provider: 'anthropic', model: 'claude-sonnet-5-5', tier: 'official' }],
      ['the prefix is case-insensitive', 'Anthropic/claude-sonnet-5-5', A, { provider: 'anthropic', model: 'claude-sonnet-5-5' }],
      ['GEMINI/ works too', 'GEMINI/gemini-3.5-flash', { ...G, ...A }, { provider: 'gemini', model: 'gemini-3.5-flash' }],
      ['a prefix picks the provider for an unrecognized name', 'gemini/gemma-4-31b-it', { ...G, ...A }, { provider: 'gemini', model: 'gemma-4-31b-it', tier: 'best-effort' }],
      ['openai/ for a model with no recognized name', 'openai/o3', { ...G, ...O }, { provider: 'openai', model: 'o3', tier: 'best-effort' }],
      ['a prefix keeps the rest of the ID', 'gemini/models/gemini-3.5-flash', G, { provider: 'gemini', model: 'models/gemini-3.5-flash' }],
    ]

    it.each(vectors)('%s', (_label, value, env, expected) => {
      expect(resolve(value, env)).toMatchObject(expected)
    })

    it('asks for the key an explicit provider needs', () => {
      expect(() => resolve('openai/o3', G)).toThrow('model-pro "openai/o3" is served by openai, which needs OPENAI_API_KEY')
    })

    it('rejects provider:model with a did-you-mean hint, because ":" belongs to real model IDs', () => {
      expect(() => resolve('anthropic:claude-sonnet-5-5', A)).toThrow('model-pro "anthropic:claude-sonnet-5-5" uses ":" after the provider. Did you mean "anthropic/claude-sonnet-5-5"?')
      expect(() => resolve('OpenAI:gpt-6-luna', O)).toThrow('Did you mean "OpenAI/gpt-6-luna"?')
    })

    it('rejects a prefix with no model after it', () => {
      expect(() => resolve('openai/', O)).toThrow('model-pro "openai/" names no model after "openai/".')
    })
  })

  describe('unrecognized names', () => {
    const vectors: Vector[] = [
      ['go to the only key set, as gemma and preview names do today', 'gemma-4-31b-it', G, { provider: 'gemini', model: 'gemma-4-31b-it', tier: 'best-effort', reason: 'set by model-pro; GEMINI_API_KEY is the only key set' }],
      ['learnlm keeps working on Gemini', 'learnlm-2.0-flash-experimental', G, { provider: 'gemini' }],
      ['other OpenAI models such as o3', 'o3', O, { provider: 'openai', model: 'o3', tier: 'best-effort' }],
      ['gpt-oss is not an OpenAI name', 'gpt-oss-120b', A, { provider: 'anthropic', model: 'gpt-oss-120b' }],
    ]

    it.each(vectors)('%s', (_label, value, env, expected) => {
      expect(resolve(value, env)).toMatchObject(expected)
    })

    it('asks for a prefix when several keys are set', () => {
      expect(() => resolve('gemma-4-31b-it', { ...G, ...A })).toThrow('Can\'t tell which provider serves model-pro "gemma-4-31b-it", because GEMINI_API_KEY and ANTHROPIC_API_KEY are both set. Write "gemini/gemma-4-31b-it" or "anthropic/gemma-4-31b-it".')
      expect(() => resolve('o3', { ...G, ...A, ...O })).toThrow('because GEMINI_API_KEY, ANTHROPIC_API_KEY and OPENAI_API_KEY are all set. Write "gemini/o3", "anthropic/o3" or "openai/o3".')
    })

    it('asks for a key when none is set', () => {
      expect(() => resolve('gemma-4-31b-it', {})).toThrow('model-pro "gemma-4-31b-it" needs a model API key, and none is set.')
    })
  })

  describe('OPENAI_BASE_URL', () => {
    const vectors: Vector[] = [
      ['an unrecognized name goes there unchanged', 'Qwen/Qwen3-Coder-30B', { ...G, ...O, ...OPENROUTER }, { provider: 'openai', model: 'Qwen/Qwen3-Coder-30B', baseUrl: 'https://openrouter.ai/api/v1', host: 'openrouter.ai', tier: 'best-effort', reason: 'set by model-pro; sent to OPENAI_BASE_URL' }],
      ['a name whose key is not set goes there unchanged', 'anthropic/claude-sonnet-5.5', { ...O, ...OPENROUTER }, { provider: 'openai', model: 'anthropic/claude-sonnet-5.5', apiKey: 'openai-key' }],
      ['a recognized name whose key is not set goes there too', 'claude-haiku-5-5', { ...O, ...OPENROUTER }, { provider: 'openai', model: 'claude-haiku-5-5', tier: 'best-effort' }],
      ['a name whose key is set still goes to its provider', 'anthropic/claude-sonnet-5.5', { ...A, ...O, ...OPENROUTER }, { provider: 'anthropic', model: 'claude-sonnet-5.5', baseUrl: 'https://api.anthropic.com' }],
      ['openai/ sends it to the endpoint, with the prefix removed', 'openai/anthropic/claude-sonnet-5.5', { ...A, ...O, ...OPENROUTER }, { provider: 'openai', model: 'anthropic/claude-sonnet-5.5', host: 'openrouter.ai' }],
      ['a Gemini name with its key set stays on Gemini', 'gemini-3.5-flash-lite', { ...G, ...OPENROUTER }, { provider: 'gemini', model: 'gemini-3.5-flash-lite', tier: 'official' }],
      ['GPT names go to the endpoint, at best effort', 'gpt-6-luna', { ...O, OPENAI_BASE_URL: 'https://litellm.example.com/v1/' }, { provider: 'openai', model: 'gpt-6-luna', baseUrl: 'https://litellm.example.com/v1', tier: 'best-effort' }],
      ['an unrecognized name goes there even when one other key is set', 'gemma-3-27b-it', { ...G, ...OPENROUTER }, { provider: 'openai', model: 'gemma-3-27b-it' }],
      ['a local server needs no key, and Ollama tags keep their ":"', 'llama3:8b', OLLAMA, { provider: 'openai', model: 'llama3:8b', apiKey: undefined, host: 'localhost:11434', baseUrl: 'http://localhost:11434/v1' }],
      ['Azure OpenAI is a plain endpoint', 'my-gpt-deploy', { ...O, OPENAI_BASE_URL: 'https://contoso.openai.azure.com/openai/v1' }, { provider: 'openai', model: 'my-gpt-deploy', host: 'contoso.openai.azure.com', tier: 'best-effort' }],
      ['the first-party host keeps the official tier', 'gpt-6-luna', { ...O, OPENAI_BASE_URL: 'https://api.openai.com/v1' }, { provider: 'openai', tier: 'official' }],
      ['plain http is allowed on loopback addresses', 'llama3', { OPENAI_BASE_URL: 'http://127.0.0.1:8000/v1' }, { host: '127.0.0.1:8000' }],
      ['plain http is allowed on IPv6 loopback', 'llama3', { OPENAI_BASE_URL: 'http://[::1]:8000/v1' }, { host: '[::1]:8000' }],
      ['an empty OPENAI_BASE_URL is absent', 'o3', { ...O, OPENAI_BASE_URL: '' }, { provider: 'openai', baseUrl: 'https://api.openai.com/v1' }],
    ]

    it.each(vectors)('%s', (_label, value, env, expected) => {
      expect(resolve(value, env)).toMatchObject(expected)
    })

    it('requires https except on loopback, because it receives the key and the issue text', () => {
      expect(() => resolve('llama3', { OPENAI_BASE_URL: 'http://models.example.com/v1' })).toThrow('OPENAI_BASE_URL must use https (http://models.example.com was given), because it receives the API key and the issue text. Plain http is allowed only for localhost.')
      expect(() => resolve('llama3', { OPENAI_BASE_URL: 'http://localhost.example.com/v1' })).toThrow('must use https')
      expect(() => resolve('llama3', { OPENAI_BASE_URL: 'ftp://localhost/v1' })).toThrow('must use https')
    })

    it('rejects a value that is not a URL', () => {
      expect(() => resolve('llama3', { OPENAI_BASE_URL: 'openrouter.ai/api/v1' })).toThrow('OPENAI_BASE_URL is not a valid URL.')
    })

    it('never puts credentials from the URL in an error', () => {
      expect(() => resolve('llama3', { OPENAI_BASE_URL: 'http://user:secret@models.example.com/v1' })).toThrow(/^(?!.*secret).*$/s)
    })

    // fetch refuses such a URL and prints it, password included, in an error on every call.
    it('rejects a user name or password in the URL, without echoing them', () => {
      for (const value of ['https://user:secret@proxy.example.com/v1', 'https://secret@proxy.example.com/v1']) {
        expect(() => resolve('llama3', { OPENAI_BASE_URL: value })).toThrow('OPENAI_BASE_URL for proxy.example.com includes a user name or password, which would show up in error messages. Remove them from the URL and put the key in OPENAI_API_KEY.')
        expect(() => resolve('llama3', { OPENAI_BASE_URL: value })).toThrow(/^(?!.*secret).*$/s)
      }
    })

    it('keeps a query string, such as Azure\'s api-version', () => {
      expect(resolve('my-gpt-deploy', { ...O, OPENAI_BASE_URL: 'https://contoso.openai.azure.com/openai/v1?api-version=preview' })).toMatchObject({
        baseUrl: 'https://contoso.openai.azure.com/openai/v1?api-version=preview',
        host: 'contoso.openai.azure.com',
      })
    })
  })

  describe('GOOGLE_GEMINI_BASE_URL', () => {
    it('sends Gemini to another host at best effort', () => {
      expect(resolve('', { ...G, GOOGLE_GEMINI_BASE_URL: 'https://gemini-proxy.example.com/' })).toMatchObject({
        provider: 'gemini',
        baseUrl: 'https://gemini-proxy.example.com',
        host: 'gemini-proxy.example.com',
        tier: 'best-effort',
      })
    })

    it('does not select a provider on its own', () => {
      expect(() => resolve('', { GOOGLE_GEMINI_BASE_URL: 'https://gemini-proxy.example.com' })).toThrow('no model API key is set')
    })
  })
})

describe('describeModel', () => {
  it('states the model, provider, tier and reason', () => {
    expect(describeModel(resolve('', A))).toBe('claude-haiku-5-5 via anthropic [official] — default for ANTHROPIC_API_KEY')
    expect(describeModel(resolve('gemma-4-31b-it', G))).toBe('gemma-4-31b-it via gemini [best effort] — set by model-pro; GEMINI_API_KEY is the only key set')
  })

  it('names the host whenever it is not the provider own API', () => {
    expect(describeModel(resolve('anthropic/claude-sonnet-5.5', { ...O, ...OPENROUTER }))).toBe('anthropic/claude-sonnet-5.5 via openai at openrouter.ai [best effort] — set by model-pro; sent to OPENAI_BASE_URL')
    expect(describeModel(resolve('', { ...G, GOOGLE_GEMINI_BASE_URL: 'https://gemini-proxy.example.com' }))).toContain('via gemini at gemini-proxy.example.com [best effort]')
  })

  it('never includes the key', () => {
    expect(describeModel(resolve('', O))).not.toContain('openai-key')
  })
})
