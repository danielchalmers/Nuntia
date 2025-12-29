import { describe, it, expect, vi } from 'vitest';
import { buildPrompt, fetchPrompt } from '../src/prompt';
import type { ReleaseContext } from '../src/types';

describe('buildPrompt', () => {
  const context: ReleaseContext = {
    generatedAt: '2024-01-01T00:00:00.000Z',
    inputs: {
      baseCommit: 'a1b2c3d',
      headCommit: 'd4e5f6g',
      branch: 'main',
      model: 'gemini-3-flash-preview',
      temperature: 1,
      maxLinkedItems: 3,
      maxReferenceDepth: 2,
      maxItemBodyLength: 3000,
    },
    stats: {
      commitCount: 0,
      linkedItemCount: 0,
    },
    repository: { owner: 'acme', repo: 'widgets', branch: 'main' },
    range: { base: 'a1b2c3d', head: 'd4e5f6g', totalCommits: 1 },
    commits: [],
    linkedItems: [],
  };

  it('injects the prompt text and release context JSON', () => {
    const { systemPrompt, userPrompt } = buildPrompt(context, 'Test prompt content');
    expect(systemPrompt).toContain('Test prompt content');
    expect(userPrompt).toContain('"base": "a1b2c3d"');
    expect(userPrompt).toContain('"head": "d4e5f6g"');
  });

  it('fetches prompt text from the provided url', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => 'Test prompt content',
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      const promptText = await fetchPrompt('https://example.com/prompt.txt');
      expect(fetchMock).toHaveBeenCalledWith('https://example.com/prompt.txt');
      expect(promptText).toBe('Test prompt content');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('throws when the url fetch fails', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      text: async () => 'Missing prompt',
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      await expect(fetchPrompt('https://example.com/missing.txt')).rejects.toThrow(
        'Failed to fetch prompt from https://example.com/missing.txt: 404 Not Found'
      );
      expect(fetchMock).toHaveBeenCalledWith('https://example.com/missing.txt');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
