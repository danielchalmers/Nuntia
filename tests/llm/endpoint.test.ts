import { describe, expect, it } from 'vitest'
import { describeEndpoint, resolveModel, type ModelEnv } from '../../src/llm/endpoint'

const DEFAULTS = { gemini: 'gemini-default', anthropic: 'claude-default', openai: 'gpt-default' }
const GEMINI = 'https://generativelanguage.googleapis.com/v1beta/openai'
const ANTHROPIC = 'https://api.anthropic.com/v1'
const OPENAI = 'https://api.openai.com/v1'

function resolve(value: string | undefined, env: ModelEnv) {
  return resolveModel('model-pro', value, env, DEFAULTS)
}

describe('resolveModel', () => {
  it('uses the default for the only key set when the input is blank', () => {
    expect(resolve('', { GEMINI_API_KEY: 'g' })).toEqual({
      provider: 'gemini',
      model: 'gemini-default',
      baseUrl: GEMINI,
      host: 'generativelanguage.googleapis.com',
      apiKey: 'g',
      keyName: 'GEMINI_API_KEY',
      isDefault: true,
    })
    expect(resolve(undefined, { ANTHROPIC_API_KEY: 'a' })).toMatchObject({ model: 'claude-default', baseUrl: ANTHROPIC, apiKey: 'a' })
    expect(resolve('  ', { OPENAI_API_KEY: 'o' })).toMatchObject({ model: 'gpt-default', baseUrl: OPENAI, apiKey: 'o' })
  })

  it('sends every model to the only key set', () => {
    expect(resolve('gemma-3-27b-it', { GEMINI_API_KEY: 'g' })).toMatchObject({ provider: 'gemini', model: 'gemma-3-27b-it', isDefault: false })
    expect(resolve('o3', { OPENAI_API_KEY: 'o' })).toMatchObject({ provider: 'openai', model: 'o3' })
  })

  it('picks the provider by name when several keys are set, sending other names to OpenAI', () => {
    const env = { GEMINI_API_KEY: 'g', ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o' }

    expect(resolve('gemini-3.5-flash', env)).toMatchObject({ provider: 'gemini', apiKey: 'g' })
    expect(resolve('claude-haiku-5-5', env)).toMatchObject({ provider: 'anthropic', apiKey: 'a' })
    expect(resolve('gpt-6-luna', env)).toMatchObject({ provider: 'openai', apiKey: 'o' })
    expect(resolve('', env)).toMatchObject({ provider: 'gemini', model: 'gemini-default' })
    expect(() => resolve('gpt-6-luna', { GEMINI_API_KEY: 'g', ANTHROPIC_API_KEY: 'a' })).toThrow('model-pro "gpt-6-luna" isn\'t a gemini-* or claude-* name, so it needs OPENAI_API_KEY or OPENAI_BASE_URL.')
  })

  it('treats empty keys as absent, as a workflow triggered from a fork gets them', () => {
    expect(() => resolve('', { GEMINI_API_KEY: '', OPENAI_API_KEY: ' ' })).toThrow('No model API key is set.')
    expect(resolve('', { GEMINI_API_KEY: '', ANTHROPIC_API_KEY: 'a' })).toMatchObject({ provider: 'anthropic' })
  })

  it('sends OpenAI traffic to OPENAI_BASE_URL, with or without a key', () => {
    expect(resolve('llama4', { OPENAI_BASE_URL: 'http://localhost:11434/v1/' })).toMatchObject({
      provider: 'openai',
      model: 'llama4',
      baseUrl: 'http://localhost:11434/v1',
      host: 'localhost:11434',
      apiKey: undefined,
    })
    expect(resolve('anthropic/claude-sonnet-5.5', { OPENAI_BASE_URL: 'https://openrouter.ai/api/v1', OPENAI_API_KEY: 'o', GEMINI_API_KEY: 'g' }))
      .toMatchObject({ baseUrl: 'https://openrouter.ai/api/v1', model: 'anthropic/claude-sonnet-5.5', apiKey: 'o' })
    expect(() => resolve('', { OPENAI_BASE_URL: 'https://openrouter.ai/api/v1' })).toThrow('model-pro is blank, and OPENAI_BASE_URL has no default model.')
  })

  it.each([
    ['not a url', 'OPENAI_BASE_URL is not a valid URL.'],
    ['http://example.com/v1', 'OPENAI_BASE_URL must use https'],
    ['https://user:secret@example.com/v1', 'OPENAI_BASE_URL includes a user name or password'],
  ])('rejects OPENAI_BASE_URL %s', (url, message) => {
    expect(() => resolve('llama4', { OPENAI_BASE_URL: url })).toThrow(message)
  })

  it('allows plain http only on loopback', () => {
    for (const url of ['http://127.0.0.1:8000/v1', 'http://[::1]:8000/v1', 'http://ollama.localhost/v1']) {
      expect(resolve('llama4', { OPENAI_BASE_URL: url }).baseUrl).toBe(url)
    }
  })
})

describe('describeEndpoint', () => {
  it('names the model and host, and the key whose default it is', () => {
    expect(describeEndpoint(resolve('', { GEMINI_API_KEY: 'g' }))).toBe('gemini-default at generativelanguage.googleapis.com (default for GEMINI_API_KEY)')
    expect(describeEndpoint(resolve('llama4', { OPENAI_BASE_URL: 'http://localhost:11434/v1' }))).toBe('llama4 at localhost:11434')
  })
})
