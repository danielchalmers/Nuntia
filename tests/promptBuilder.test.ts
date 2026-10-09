import * as fs from 'fs';
import { describe, it, expect, vi, afterEach, beforeEach, type MockInstance } from 'vitest';
import { buildPrompt, loadPrompt } from '../src/prompt';
import { sanitizeNotes } from '../src/sanitize';
import type { ReleaseContext } from '../src/types';

const PROMPT_URL = 'https://example.com/prompt.txt';
const HINT = 'Check prompt-url, or leave it blank to use the bundled prompt.';

describe('buildPrompt', () => {
  const context: ReleaseContext = {
    repository: { owner: 'acme', repo: 'widgets', branch: 'main' },
    release: { tag: 'v1.1.0', previousTag: 'v1.0.0', name: 'Widgets 1.1', prerelease: false, hasChangeList: true },
    range: { base: 'v1.0.0', head: 'v1.1.0', totalCommits: 1, changedFiles: [] },
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

  it('uses the prompt unchanged as the system prompt', () => {
    const { systemPrompt } = buildPrompt(context, 'Test prompt content\n');

    expect(systemPrompt).toBe('Test prompt content\n');
  });

  it('sends the complete release context as compact JSON in the user prompt', () => {
    const { userPrompt } = buildPrompt(context, 'Test prompt content');
    const header = '=== RELEASE CONTEXT (JSON) ===\n';

    expect(userPrompt.startsWith(header)).toBe(true);
    expect(JSON.parse(userPrompt.slice(header.length))).toEqual(context);
    expect(userPrompt).toBe(`${header}${JSON.stringify(context)}\n`);
    expect(userPrompt).toContain('"repository":{"owner":"acme"');
  });
});

describe('loadPrompt', () => {
  let warn: MockInstance;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  // stubGlobal restores the real fetch in afterEach, including when an assertion throws.
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  // Answers each request with the next result in turn: a response to build, or an error to throw.
  function stubFetch(...results: Array<{ status?: number; statusText?: string; body?: string } | Error>) {
    const fetchMock = vi.fn(async () => {
      const next = results.length > 1 ? results.shift() : results[0];
      if (next === undefined) throw new Error('unexpected request');
      if (next instanceof Error) throw next;
      return new Response(next.body ?? '', { status: next.status ?? 200, statusText: next.statusText ?? '' });
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  // Runs the retry waits on a fake clock, so a test that retries doesn't wait on the real one.
  async function loadWithRetries(promptUrl: string) {
    vi.useFakeTimers();
    const result = loadPrompt(promptUrl).then(
      prompt => ({ prompt }),
      (error: unknown) => ({ error: error instanceof Error ? error.message : String(error) })
    );
    await vi.runAllTimersAsync();
    return result;
  }

  it('uses the prompt bundled from examples/Nuntia.prompt without fetching when the url is blank', async () => {
    const fetchMock = stubFetch();

    const prompt = await loadPrompt('');

    expect(prompt).toEqual({ text: fs.readFileSync(new URL('../examples/Nuntia.prompt', import.meta.url), 'utf8'), source: 'built-in' });
    expect(prompt.text).toContain('You are Nuntia');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('tells the model, for a published release, to skip the H1 and leave out maintenance work', async () => {
    const { text } = await loadPrompt('');

    expect(text).toContain("When `release` is set, the release page already shows its title, so don't write an H1.");
    expect(text).toContain(
      'When `release` is set, leave out build, CI, documentation, test, dependency-update and refactoring work, and anything labeled `skip changelog`.'
    );
  });

  it("asks for changes by area only when GitHub's list isn't already in the release", async () => {
    const { text } = await loadPrompt('');

    expect(text).toContain('release: { tag, previousTag, name, prerelease, hasChangeList }');
    expect(text).toContain("4. `## Changes by area`: only when `release` is null or `release.hasChangeList` is false, because otherwise GitHub's list follows these notes.");
  });

  it('tells the model to size up the release before choosing the shape of the notes', async () => {
    const { text } = await loadPrompt('');

    expect(text).toContain('A major release, or any release that breaks existing code, is a migration.');
    expect(text).toContain('A minor release adds features and fixes and usually asks nothing of users.');
    expect(text).toContain('A patch release fixes things.');
    expect(text).toContain("Match the examples' voice and formatting, and follow the shape of the one closer to this release.");
  });

  it('fetches the prompt from the url with a timeout', async () => {
    const fetchMock = stubFetch({ body: 'Test prompt content' });

    const prompt = await loadPrompt(PROMPT_URL);

    expect(prompt).toEqual({ text: 'Test prompt content', source: PROMPT_URL });
    expect(fetchMock).toHaveBeenCalledWith(PROMPT_URL, { signal: expect.any(AbortSignal) });
  });

  it.each([400, 401, 403, 404])('fails at once on HTTP %i, which retrying cannot fix', async (status) => {
    const fetchMock = stubFetch({ status, statusText: 'Nope', body: 'Missing prompt' });

    await expect(loadPrompt(PROMPT_URL)).rejects.toThrow(`Failed to fetch prompt from ${PROMPT_URL}: ${status} Nope. ${HINT}`);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('fails at once when the prompt is blank', async () => {
    const fetchMock = stubFetch({ body: ' \n\t ' });

    await expect(loadPrompt(PROMPT_URL)).rejects.toThrow(`Prompt at ${PROMPT_URL} is empty. ${HINT}`);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([408, 429, 500, 502, 503])('retries HTTP %i, and uses the prompt once it arrives', async (status) => {
    const fetchMock = stubFetch({ status, statusText: 'Busy' }, { body: 'Test prompt content' });

    const result = await loadWithRetries(PROMPT_URL);

    expect(result).toEqual({ prompt: { text: 'Test prompt content', source: PROMPT_URL } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(`Failed to fetch prompt from ${PROMPT_URL}; retrying in 5s: ${status} Busy`);
  });

  it('retries a network failure, naming its cause', async () => {
    const fetchMock = stubFetch(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }), { body: 'Test prompt content' });

    const result = await loadWithRetries(PROMPT_URL);

    expect(result).toEqual({ prompt: { text: 'Test prompt content', source: PROMPT_URL } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('fetch failed (ECONNRESET)'));
  });

  it('gives up after three attempts, naming the last failure', async () => {
    const fetchMock = stubFetch({ status: 503, statusText: 'Service Unavailable' });

    const result = await loadWithRetries(PROMPT_URL);

    expect(result).toEqual({ error: `Failed to fetch prompt from ${PROMPT_URL} after 3 attempts: 503 Service Unavailable. ${HINT}` });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('retries a request that times out, and says so when it keeps timing out', async () => {
    const fetchMock = stubFetch(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));

    const result = await loadWithRetries(PROMPT_URL);

    expect(result).toEqual({ error: `Failed to fetch prompt from ${PROMPT_URL} after 3 attempts: no response within 30s. ${HINT}` });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

// The worked examples teach the model what to write, so they have to be notes that Nuntia would publish exactly as they are.
describe("the bundled prompt's worked examples", () => {
  async function examples(): Promise<{ major: string; minor: string }> {
    const { text } = await loadPrompt('');
    const notes = [...text.matchAll(/^=== EXAMPLE NOTES ===\n([\s\S]*?)\n=== END OF EXAMPLE NOTES ===$/gm)].map(match => match[1]!);
    if (notes.length !== 2) throw new Error(`The bundled prompt should have a major and a minor example, but has ${notes.length}.`);
    return { major: notes[0]!, minor: notes[1]! };
  }

  function highlights(notes: string): string[] {
    return (notes.split('## Highlights\n')[1]?.split(/^## /m)[0] ?? '').split('\n').filter(line => line.startsWith('- '));
  }

  it('come through cleaning unchanged', async () => {
    for (const notes of Object.values(await examples())) expect(sanitizeNotes(notes, 'MudBlazor', 'MudBlazor')).toBe(notes);
  });

  it("are shaped for a published release that already has GitHub's list", async () => {
    for (const notes of Object.values(await examples())) {
      expect(notes).not.toMatch(/^# /m);
      expect(notes).not.toContain('## Changes by area');
    }
  });

  it('show a major release as a headline, 2-4 highlights and numbered migration steps', async () => {
    const { major } = await examples();

    expect(major).not.toMatch(/^#/);
    expect(highlights(major).length).toBeGreaterThanOrEqual(2);
    expect(highlights(major).length).toBeLessThanOrEqual(4);
    expect(major).toMatch(/^1\. /m);
  });

  it('show a minor release as 1-3 highlights and upgrading bullets, with no headline', async () => {
    const { minor } = await examples();

    expect(minor).toMatch(/^## Highlights\n/);
    expect(highlights(minor).length).toBeGreaterThanOrEqual(1);
    expect(highlights(minor).length).toBeLessThanOrEqual(3);
    expect(minor).not.toMatch(/^\d+\. /m);
  });

  it('end every bullet and step with links to its pull requests or issues', async () => {
    const reference = String.raw`\[#\d+\]\(https://github\.com/MudBlazor/MudBlazor/(?:pull|issues)/\d+\)`;
    for (const notes of Object.values(await examples())) {
      const items = notes.split('\n').filter(line => /^(?:- |\d+\. )/.test(line));

      expect(items.length).toBeGreaterThan(0);
      for (const item of items) expect(item).toMatch(new RegExp(String.raw`\(${reference}(?:, ${reference})*\)$`));
    }
  });
});
