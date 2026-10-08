// Source: AutoTriage (danielchalmers/AutoTriage, tests/llm/). Nuntia copies this folder verbatim, so change it in AutoTriage and copy it over in a paired PR.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GeminiClient } from '../../src/llm/gemini'
import type { Fetch } from '../../src/llm/transport'
import { ModelError, type TextRequest } from '../../src/llm/types'

// Nuntia's text call, which AutoTriage doesn't make.
const REQUEST: TextRequest = {
  model: 'gemini-3.5-flash-lite',
  systemPrompt: 'Write release notes.\nUse "Fixes" and "Features".',
  userPrompt: 'PR #7: Fix crash on save — café 🚀',
}

function respond(body: unknown, sent: string[] = []): Fetch {
  return async (_input, init) => {
    sent.push(typeof init?.body === 'string' ? init.body : '')
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
  }
}

beforeEach(() => {
  // Requests must not depend on the runner's environment.
  vi.stubEnv('GOOGLE_GEMINI_BASE_URL', '')
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('Gemini text calls', () => {
  it('sends the same bytes as Nuntia\'s @google/genai text call', async () => {
    const sent: string[] = []
    await new GeminiClient('test-key', respond({ candidates: [{ content: { parts: [{ text: 'Notes' }] } }] }, sent)).generateText(REQUEST, 0, 1)

    // Recorded from @google/genai 2.27.0 with Nuntia's buildTextPayload and these prompts, empty generationConfig included.
    expect(sent).toEqual(['{"contents":[{"parts":[{"text":"PR #7: Fix crash on save — café 🚀"}],"role":"user"}],"systemInstruction":{"parts":[{"text":"Write release notes.\\nUse \\"Fixes\\" and \\"Features\\"."}],"role":"user"},"generationConfig":{}}'])
  })

  it('returns the trimmed answer without thoughts, with its usage', async () => {
    const reply = {
      candidates: [{ content: { parts: [{ text: 'Planning the notes.', thought: true }, { text: '\n## Fixes\n' }, { text: '- Crash on save\n' }] } }],
      usageMetadata: { promptTokenCount: 90, candidatesTokenCount: 12, thoughtsTokenCount: 30 },
    }

    expect(await new GeminiClient('test-key', respond(reply)).generateText(REQUEST, 0, 1)).toEqual({
      text: '## Fixes\n- Crash on save',
      inputTokens: 90,
      cachedInputTokens: 0,
      outputTokens: 12,
      thoughtsTokens: 30,
    })
  })

  it('ignores an unspecified block reason, and names a real one with its message', async () => {
    const unspecified = { promptFeedback: { blockReason: 'BLOCKED_REASON_UNSPECIFIED' }, candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'Notes' }] } }] }
    expect((await new GeminiClient('test-key', respond(unspecified)).generateText(REQUEST, 0, 1)).text).toBe('Notes')

    const blocked = { promptFeedback: { blockReason: 'PROHIBITED_CONTENT', blockReasonMessage: 'The prompt was blocked.' } }
    const err = await new GeminiClient('test-key', respond(blocked)).generateText(REQUEST, 0, 1).catch((error: unknown) => error)
    expect(err).toBeInstanceOf(ModelError)
    expect((err as ModelError).message).toBe('Gemini blocked the prompt (blockReason PROHIBITED_CONTENT): The prompt was blocked.')
    expect((err as ModelError).failure.kind).toBe('refusal')
  })

  it('fails on a blank answer, a refusal, or a truncated answer', async () => {
    const failureOf = async (reply: unknown) => {
      const err = await new GeminiClient('test-key', respond(reply)).generateText(REQUEST, 0, 1).catch((error: unknown) => error)
      expect(err).toBeInstanceOf(ModelError)
      return { message: (err as ModelError).message, kind: (err as ModelError).failure.kind }
    }

    expect(await failureOf({ candidates: [{ content: { parts: [{ text: '  \n' }] } }] }))
      .toEqual({ message: 'Gemini responded with empty text', kind: 'retryable' })
    expect(await failureOf({ candidates: [{ finishReason: 'SAFETY' }] }))
      .toEqual({ message: 'Gemini declined to answer (finishReason SAFETY)', kind: 'refusal' })
    expect(await failureOf({ candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: '## Fixes' }] } }] }))
      .toEqual({ message: 'Gemini stopped at the output token limit (finishReason MAX_TOKENS)', kind: 'truncated' })
  })
})
