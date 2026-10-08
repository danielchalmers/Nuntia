import { afterEach, describe, expect, it, vi } from 'vitest'
import { withRetries } from '../../src/llm/retry'
import { ModelError } from '../../src/llm/types'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('withRetries', () => {
  it('logs each ordinary retry with its attempt number, wait, and reason', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const attempt = vi
      .fn()
      .mockRejectedValueOnce(new Error('Unable to parse JSON'))
      .mockRejectedValueOnce(new Error('Unable to parse JSON'))
      .mockResolvedValueOnce('ok')
    const sleeps: number[] = []

    expect(await withRetries(attempt, 2, 5000, async ms => { sleeps.push(ms) })).toBe('ok')
    expect(sleeps).toEqual([5000, 10000])
    expect(warn.mock.calls.map(call => call[0])).toEqual([
      'Model call failed (attempt 1/3); retrying in 5s: Unable to parse JSON',
      'Model call failed (attempt 2/3); retrying in 10s: Unable to parse JSON',
    ])
  })

  it('does not log or wait when the last attempt fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const sleeps: number[] = []

    await expect(withRetries(() => Promise.reject(new Error('flaky')), 0, 5000, async ms => { sleeps.push(ms) })).rejects.toBeInstanceOf(ModelError)
    expect(sleeps).toEqual([])
    expect(warn).not.toHaveBeenCalled()
  })
})
