import { describe, it, expect, vi, afterEach } from 'vitest';
import { buildPrompt, fetchPrompt } from '../src/prompt';
import type { ReleaseContext } from '../src/types';

describe('buildPrompt', () => {
  const context: ReleaseContext = {
    generatedAt: '2024-01-01T00:00:00.000Z',
    inputs: {
      baseCommit: 'a1b2c3d',
      headCommit: 'd4e5f6g',
      branch: 'main',
      promptUrl: 'https://example.com/prompt.txt',
      model: 'gemini-3.5-flash-lite',
      maxLinkedItems: 3,
      maxReferenceDepth: 2,
      maxItemLength: 5000,
    },
    repository: { owner: 'acme', repo: 'widgets', branch: 'main' },
    range: { base: 'a1b2c3d', head: 'd4e5f6g', totalCommits: 1, changedFiles: [] },
    commits: [],
    linkedItems: [
      {
        type: 'issue',
        owner: 'acme',
        repo: 'widgets',
        id: '42',
        title: 'Fix flaky cache invalidation',
        labels: ['bug', 'release-note'],
        referencedBy: ['commit:a1b2c3d'],
      },
    ],
  };

  it('puts the fetched prompt in the system prompt, followed by the input guidance', () => {
    const { systemPrompt } = buildPrompt(context, 'Test prompt content');

    expect(systemPrompt.startsWith('Test prompt content\n\n=== INPUT GUIDANCE ===')).toBe(true);
  });

  it('sends the complete release context as JSON in the user prompt', () => {
    const { userPrompt } = buildPrompt(context, 'Test prompt content');
    const header = '=== RELEASE CONTEXT (JSON) ===\n';

    expect(userPrompt.startsWith(header)).toBe(true);
    expect(JSON.parse(userPrompt.slice(header.length))).toEqual(context);
  });
});

describe('fetchPrompt', () => {
  // stubGlobal restores the real fetch in afterEach, including when an assertion throws.
  afterEach(() => vi.unstubAllGlobals());

  function stubFetch(response: Record<string, unknown>) {
    const fetchMock = vi.fn().mockResolvedValue(response);
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('fetches prompt text from the trimmed url', async () => {
    const fetchMock = stubFetch({ ok: true, text: async () => 'Test prompt content' });

    const promptText = await fetchPrompt('  https://example.com/prompt.txt\n');

    expect(fetchMock).toHaveBeenCalledWith('https://example.com/prompt.txt');
    expect(promptText).toBe('Test prompt content');
  });

  it('rejects an empty url without making a request', async () => {
    const fetchMock = stubFetch({ ok: true, text: async () => 'unused' });

    await expect(fetchPrompt('   ')).rejects.toThrow('Prompt URL is required and cannot be empty.');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws when the url fetch fails', async () => {
    stubFetch({ ok: false, status: 404, statusText: 'Not Found', text: async () => 'Missing prompt' });

    await expect(fetchPrompt('https://example.com/missing.txt')).rejects.toThrow(
      'Failed to fetch prompt from https://example.com/missing.txt: 404 Not Found'
    );
  });

  it('throws when the prompt is blank', async () => {
    stubFetch({ ok: true, text: async () => ' \n\t ' });

    await expect(fetchPrompt('https://example.com/blank.txt')).rejects.toThrow(
      'Prompt at https://example.com/blank.txt is empty.'
    );
  });

  it('names the url when the request itself fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));

    await expect(fetchPrompt('https://example.com/prompt.txt')).rejects.toThrow(
      'Failed to fetch prompt from https://example.com/prompt.txt: fetch failed'
    );
  });
});
