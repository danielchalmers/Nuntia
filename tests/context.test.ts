import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import * as core from '@actions/core';
import { buildReleaseContext } from '../src/context';
import type { CommitDetails, GitHubClient } from '../src/github';
import type { Config, ReleaseRange } from '../src/types';

// Mock @actions/core so warnings raised during tests (e.g. the changed-file truncation path) are captured as spies instead of being written to stdout as `::warning::` workflow commands, which the GitHub Actions runner would otherwise surface as spurious annotations on the test job.
vi.mock('@actions/core', async (importActual) => {
  const actual = await importActual<typeof import('@actions/core')>();
  return { ...actual, warning: vi.fn() };
});

const CONFIG: Config = {
  owner: 'acme',
  repo: 'widgets',
  token: 'token',
  promptUrl: 'https://example.com/prompt.txt',
  model: 'gemini-3.5-flash-lite',
  endpoint: {
    provider: 'gemini',
    model: 'gemini-3.5-flash-lite',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    host: 'generativelanguage.googleapis.com',
    apiKey: 'gemini-key',
    keyName: 'GEMINI_API_KEY',
    isDefault: false,
  },
  trigger: { eventName: 'release', ref: 'refs/tags/v1.1.0', sha: 'run-sha', headRef: '' },
};

const RANGE: ReleaseRange = {
  base: 'v1.0.0',
  head: 'v1.1.0',
  branch: 'main',
  release: { tag: 'v1.1.0', previousTag: 'v1.0.0', name: 'Widgets 1.1', prerelease: false, hasChangeList: true },
};

function makeCommit(overrides: Partial<CommitDetails> = {}): CommitDetails {
  return {
    sha: 'a1b2c3d4e5f6',
    message: 'Fixes #42',
    url: 'https://github.com/acme/widgets/commit/a1b2c3d4e5f6',
    ...overrides,
  };
}

function makeIssue(overrides: Record<string, unknown> = {}) {
  return {
    number: 42,
    title: 'Patch release race condition',
    body: 'Resolves edge case when sync happens concurrently.',
    url: 'https://github.com/acme/widgets/issues/42',
    state: 'closed',
    labels: [],
    type: 'issue',
    owner: 'acme',
    repo: 'widgets',
    ...overrides,
  };
}

/**
 * Build a GitHubClient stub whose compare returns `commits` (one "Fixes #42" commit by default) as a complete range.
 * Pass a plain object to have a lookup resolve to it, or a vi.fn() when the test needs to assert on how the lookup was called.
 * Like the real client it counts every request, starting from `priorApiCalls` for those made before the context is built.
 */
function makeClient(
  opts: { commits?: CommitDetails[]; compare?: Record<string, unknown>; commit?: unknown; issue?: unknown; priorApiCalls?: number } = {}
): GitHubClient {
  const commits = opts.commits ?? [makeCommit()];
  const endpoints = {
    compareCommits: vi.fn().mockResolvedValue({ commits, status: 'ahead', totalCommits: commits.length, files: [], filesTruncated: false, ...opts.compare }),
    getCommit: typeof opts.commit === 'function' ? opts.commit : vi.fn().mockResolvedValue(opts.commit ?? makeCommit()),
    getIssueOrPullRequest:
      typeof opts.issue === 'function' ? opts.issue : vi.fn().mockResolvedValue(opts.issue ?? makeIssue()),
  };
  const getApiCallCount = () =>
    Object.values(endpoints).reduce((count, endpoint) => count + (endpoint as Mock).mock.calls.length, opts.priorApiCalls ?? 0);
  return { ...endpoints, getApiCallCount } as unknown as GitHubClient;
}

// Resolves issue/PR lookups from a table keyed by number, rejecting unknown numbers like a 404 would.
function issuesByNumber(issues: Record<number, ReturnType<typeof makeIssue>>) {
  return vi.fn().mockImplementation(async (_owner: string, _repo: string, number: number) => {
    const issue = issues[number];
    if (!issue) throw new Error(`Not Found: #${number}`);
    return issue;
  });
}

function build(gh: GitHubClient, range: ReleaseRange = RANGE) {
  return buildReleaseContext(CONFIG, range, gh);
}

describe('buildReleaseContext', () => {
  it('compares the release with the previous one and leaves the base commit out', async () => {
    const gh = makeClient({ commits: [makeCommit({ sha: 'b2c3d4e5f6a7', message: 'Add export' })] });

    const context = await build(gh);

    expect(gh.compareCommits).toHaveBeenCalledWith('v1.0.0', 'v1.1.0');
    expect(gh.getCommit).not.toHaveBeenCalled();
    expect(context.commits.map(commit => commit.sha)).toEqual(['b2c3d4e5f6a7']);
    expect(context.range).toMatchObject({ base: 'v1.0.0', head: 'v1.1.0', totalCommits: 1 });
  });

  it('puts the release and the branch it was created from in the context', async () => {
    const context = await build(makeClient());

    expect(context.repository).toEqual({ owner: 'acme', repo: 'widgets', branch: 'main' });
    expect(context.release).toEqual({ tag: 'v1.1.0', previousTag: 'v1.0.0', name: 'Widgets 1.1', prerelease: false, hasChangeList: true });
  });

  it('has no release when previewing the next one', async () => {
    const context = await build(makeClient(), { base: 'v1.1.0', head: 'run-sha', branch: 'dev', release: null });

    expect(context.release).toBeNull();
    expect(context.repository.branch).toBe('dev');
    expect(context.range).toMatchObject({ base: 'v1.1.0', head: 'run-sha' });
  });

  it('leaves out the generation time, the inputs, and commit authors and dates', async () => {
    const context = await build(makeClient());

    expect(Object.keys(context)).toEqual(['repository', 'release', 'range', 'commits', 'linkedItems']);
    expect(Object.keys(context.commits[0]!)).toEqual(['sha', 'message', 'url', 'references']);
  });

  it('builds an empty context when there are no commits after the base', async () => {
    const gh = makeClient({ commits: [], compare: { status: 'identical' } });

    const context = await build(gh);

    expect(context.range).toMatchObject({ totalCommits: 0, status: 'identical' });
    expect(context.commits).toEqual([]);
    expect(context.linkedItems).toEqual([]);
  });

  it('includes issue labels in linked item metadata', async () => {
    const gh = makeClient({
      compare: { files: ['src/index.ts'] },
      issue: makeIssue({ labels: ['bug', 'release-note'] }),
    });

    const context = await build(gh);

    expect(context.linkedItems).toHaveLength(1);
    expect(context.range).toMatchObject({ totalCommits: 1, changedFiles: ['src/index.ts'], status: 'ahead' });
    expect(context.linkedItems[0]).toMatchObject({
      type: 'issue',
      id: '42',
      labels: ['bug', 'release-note'],
    });
  });

  it('classifies (#123) references as pull requests and includes linked pull body', async () => {
    const gh = makeClient({
      commits: [makeCommit({ message: 'Rename and consolidate inputs (#57)' })],
      issue: makeIssue({
        number: 57,
        title: 'Rename and consolidate inputs',
        body: 'This pull request contains the full migration details.',
        url: 'https://github.com/acme/widgets/pull/57',
        labels: ['release-note'],
        type: 'pull',
      }),
    });

    const context = await build(gh);

    expect(context.commits[0]?.references.issues).toEqual([]);
    expect(context.commits[0]?.references.pulls).toEqual([57]);
    expect(context.linkedItems[0]).toMatchObject({
      type: 'pull',
      id: '57',
      body: 'This pull request contains the full migration details.',
    });
  });

  it('resolves a commit URL in a message into a linked commit item', async () => {
    const linkedSha = 'abcdef1234567890abcdef1234567890abcdef12';
    const getCommit = vi.fn().mockResolvedValue(
      makeCommit({ sha: linkedSha, message: 'Upstream fix', url: `https://github.com/other/repo/commit/${linkedSha}` })
    );

    const context = await build(
      makeClient({ commits: [makeCommit({ message: `Ports https://github.com/other/repo/commit/${linkedSha}` })], commit: getCommit })
    );

    expect(getCommit).toHaveBeenCalledTimes(1);
    expect(getCommit).toHaveBeenCalledWith('other', 'repo', linkedSha);
    expect(context.linkedItems).toHaveLength(1);
    expect(context.linkedItems[0]).toMatchObject({
      type: 'commit',
      owner: 'other',
      repo: 'repo',
      id: linkedSha,
      message: 'Upstream fix',
      referencedBy: ['commit:a1b2c3d'],
    });
  });

  it('qualifies references made inside a linked item from another repository', async () => {
    const linkedSha = 'abcdef1234567890abcdef1234567890abcdef12';
    const getIssueOrPullRequest = vi.fn(async (owner: string, repo: string, number: number) => makeIssue({ owner, repo, number }));
    const gh = makeClient({
      commits: [makeCommit({ message: `Fixes #42, ports https://github.com/other/repo/commit/${linkedSha}` })],
      commit: vi.fn().mockResolvedValue(makeCommit({ sha: linkedSha, message: 'Upstream fix for #3' })),
      issue: getIssueOrPullRequest,
    });

    const context = await build(gh);

    expect(context.commits[0]?.references).toEqual({ issues: [42], pulls: [], commits: [`other/repo@${linkedSha}`] });
    // "#3" in other/repo's commit means other/repo#3, not issue 3 of the release repository.
    expect(context.linkedItems.find(item => item.type === 'commit')?.references).toEqual({
      issues: ['other/repo#3'],
      pulls: [],
      commits: [],
    });
    expect(getIssueOrPullRequest).toHaveBeenCalledWith('other', 'repo', 3);
  });

  it('cuts commit messages and linked item fields at 5,000 characters with an ellipsis', async () => {
    const long = 'x'.repeat(6000);
    const exact = 'y'.repeat(5000);
    const gh = makeClient({
      commits: [makeCommit({ message: `Fixes #42 ${long}` })],
      issue: makeIssue({ title: long, body: exact }),
    });

    const context = await build(gh);

    expect(context.commits[0]?.message).toBe(`Fixes #42 ${'x'.repeat(4987)}...`);
    expect(context.linkedItems[0]?.title).toBe(`${'x'.repeat(4997)}...`);
    expect(context.linkedItems[0]?.body).toBe(exact);
  });

  it('links at most 5 items for each commit, not for the release as a whole', async () => {
    const getIssueOrPullRequest = vi.fn(async (_owner: string, _repo: string, number: number) => makeIssue({ number }));
    const gh = makeClient({
      commits: [
        makeCommit({ sha: 'a1b2c3d4e5f6', message: 'Fixes #1, #2, #3, #4, #5 and #6' }),
        makeCommit({ sha: 'b2c3d4e5f6a7', message: 'Fixes #7' }),
      ],
      issue: getIssueOrPullRequest,
    });

    const context = await build(gh);

    expect(context.linkedItems.map(item => item.id)).toEqual(['1', '2', '3', '4', '5', '7']);
    expect(getIssueOrPullRequest).not.toHaveBeenCalledWith('acme', 'widgets', 6);
  });

  it('follows references inside linked items 2 levels deep', async () => {
    const getIssueOrPullRequest = issuesByNumber({
      42: makeIssue({ number: 42, body: 'Duplicate of #43' }),
      43: makeIssue({ number: 43, body: 'Root cause tracked in #44' }),
      44: makeIssue({ number: 44, body: 'Should not be fetched' }),
    });
    const gh = makeClient({ issue: getIssueOrPullRequest });

    const context = await build(gh);

    expect(context.linkedItems.map(item => item.id)).toEqual(['42', '43']);
    expect(context.linkedItems[1]).toMatchObject({ referencedBy: ['issue:#42'], references: { issues: [44] } });
    expect(getIssueOrPullRequest).not.toHaveBeenCalledWith('acme', 'widgets', 44);
  });

  it('fetches an item referenced by several commits once and records every referrer', async () => {
    const getIssueOrPullRequest = vi.fn().mockResolvedValue(makeIssue());
    const gh = makeClient({
      commits: [makeCommit({ sha: 'a1b2c3d4e5f6', message: 'Fixes #42' }), makeCommit({ sha: 'b2c3d4e5f6a7', message: 'Follow-up for #42' })],
      issue: getIssueOrPullRequest,
    });

    const context = await build(gh);

    expect(getIssueOrPullRequest).toHaveBeenCalledTimes(1);
    expect(context.linkedItems).toHaveLength(1);
    expect(context.linkedItems[0]?.referencedBy).toEqual(['commit:a1b2c3d', 'commit:b2c3d4e']);
  });

  it('merges an issue-style reference into the pull request it resolves to', async () => {
    // "(#57)" is known to be a pull request; the later "#57" looks like an issue until the lookup reports a pull request.
    const getIssueOrPullRequest = vi.fn().mockResolvedValue(
      makeIssue({ number: 57, url: 'https://github.com/acme/widgets/pull/57', type: 'pull' })
    );
    const gh = makeClient({
      commits: [
        makeCommit({ sha: 'a1b2c3d4e5f6', message: 'Ship the new inputs (#57)' }),
        makeCommit({ sha: 'b2c3d4e5f6a7', message: 'Follow up on #57' }),
      ],
      issue: getIssueOrPullRequest,
    });

    const context = await build(gh);

    expect(context.linkedItems).toHaveLength(1);
    expect(context.linkedItems[0]).toMatchObject({ type: 'pull', id: '57', referencedBy: ['commit:a1b2c3d', 'commit:b2c3d4e'] });
  });

  it('keeps building the context when a reference cannot be resolved', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const gh = makeClient({
      commits: [makeCommit({ message: 'Fixes #404 and #42' })],
      issue: issuesByNumber({ 42: makeIssue() }),
    });

    try {
      const context = await build(gh);

      expect(context.linkedItems.map(item => item.id)).toEqual(['42']);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('issue:acme/widgets#404'));
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('ignores references hidden in HTML comments and strips the comments from the context', async () => {
    const getIssueOrPullRequest = issuesByNumber({
      42: makeIssue({ body: 'Real body<!-- PR template: link #7 here -->' }),
    });
    const gh = makeClient({
      commits: [makeCommit({ message: 'Fixes #42<!-- closes #99 -->' })],
      issue: getIssueOrPullRequest,
    });

    const context = await build(gh);

    expect(context.commits[0]?.message).toBe('Fixes #42');
    expect(context.commits[0]?.references.issues).toEqual([42]);
    expect(context.linkedItems).toHaveLength(1);
    expect(context.linkedItems[0]).toMatchObject({ body: 'Real body', references: { issues: [], pulls: [], commits: [] } });
    expect(getIssueOrPullRequest).toHaveBeenCalledTimes(1);
  });

  it('resolves a short SHA of a commit already in the range without fetching it', async () => {
    const earlierSha = 'aaaabbbbccccddddeeeeffff0000111122223333';
    const getCommit = vi.fn();
    const gh = makeClient({
      commits: [
        makeCommit({ sha: earlierSha, message: 'Add caching' }),
        makeCommit({ sha: 'ffffeeeeddddccccbbbbaaaa9999888877776666', message: 'Revert aaaabbb' }),
      ],
      commit: getCommit,
    });

    const context = await build(gh);

    expect(getCommit).not.toHaveBeenCalled();
    expect(context.linkedItems).toEqual([]);
    expect(context.commits[1]?.references.commits).toEqual([earlierSha]);
  });

  function makeRangeCommits(count: number) {
    return Array.from({ length: count }, (_, i) =>
      makeCommit({ sha: `range${i}`.padEnd(40, '0'), message: `Change ${i}`, url: `https://github.com/acme/widgets/commit/range${i}` })
    );
  }

  it('builds the context for a complete range of more than 250 commits', async () => {
    const gh = makeClient({ commits: makeRangeCommits(348) });

    const context = await build(gh);

    expect(context.range.totalCommits).toBe(348);
    expect(context.commits).toHaveLength(348);
  });

  it('throws instead of producing notes when the commit range is incomplete', async () => {
    // Compare reported 300 commits in the range but returned only 250 of them.
    const gh = makeClient({ commits: makeRangeCommits(250), compare: { totalCommits: 300 } });

    await expect(build(gh)).rejects.toThrow('Commit range v1.0.0...v1.1.0 is incomplete: got 250 of 300 commit(s).');
  });

  it('does not throw on a capped changed-file list (files are non-fatal)', async () => {
    const gh = makeClient({
      commits: [makeCommit({ sha: 'c1', message: 'Change one', url: '' })],
      compare: { files: ['a.ts', 'b.ts'], filesTruncated: true },
    });

    vi.mocked(core.warning).mockClear();

    // The commit range is complete, so a capped file list must not abort the run.
    const context = await build(gh);
    expect(context.range.totalCommits).toBe(1);
    expect(context.range.changedFiles).toEqual(['a.ts', 'b.ts']);
    // The truncation must surface as a warning (captured by the mock, not leaked to stdout).
    expect(core.warning).toHaveBeenCalledWith(expect.stringMatching(/300-file compare cap/));
  });
});

describe('buildReleaseContext limits', () => {
  // 150k tokens at 4 characters a token.
  const MAX_CONTEXT_CHARS = 600_000;

  function range(from: number, count: number) {
    return Array.from({ length: count }, (_, i) => from + i);
  }

  // A distinct SHA whose first 7 characters, which label it as a referrer, are the zero-padded number.
  function shaFor(number: number) {
    return String(number).padStart(7, '0').padEnd(40, 'a');
  }

  // A commit that fixes the given issues, with a SHA made from the first one.
  function commitFixing(numbers: number[]) {
    return makeCommit({ sha: shaFor(numbers[0]!), message: `Fixes ${numbers.map(n => `#${n}`).join(', ')}`, url: '' });
  }

  function issueLookup(issueFor: (number: number) => Partial<ReturnType<typeof makeIssue>>) {
    return vi.fn(async (_owner: string, _repo: string, number: number) => makeIssue({ number, title: `Issue ${number}`, ...issueFor(number) }));
  }

  function logLines() {
    return vi.mocked(console.log).mock.calls.map(args => args.join(' '));
  }

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.mocked(core.warning).mockClear();
  });

  afterEach(() => {
    vi.mocked(console.log).mockRestore();
  });

  it('stops fetching linked items at 300 GitHub API calls in the run, leaving out references inside linked items first', async () => {
    const getIssueOrPullRequest = issueLookup(number => ({ body: number === 1 ? 'Root cause tracked in #10' : 'Fixed.' }));
    const gh = makeClient({
      // Reading the release made 297 calls and the compare makes the 298th, which leaves room for two lookups.
      priorApiCalls: 297,
      commits: [commitFixing([1]), commitFixing([2]), commitFixing([3]), makeCommit({ sha: 'd'.repeat(40), message: 'Follow-up for #1' })],
      issue: getIssueOrPullRequest,
    });

    const context = await build(gh);

    expect(getIssueOrPullRequest).toHaveBeenCalledTimes(2);
    expect(context.linkedItems.map(item => item.id)).toEqual(['1', '2']);
    // An item fetched before the budget ran out still records the referrers that come after.
    expect(context.linkedItems[0]?.referencedBy).toEqual(['commit:0000001', 'commit:ddddddd']);
    expect(logLines()).toContain('Stopped following references at 300 GitHub API calls, leaving out 2 more.');
  });

  it('keeps a context that fits whole, and logs no trimming', async () => {
    const gh = makeClient({
      commits: range(1, 50).map(n => commitFixing([n])),
      compare: { files: ['src/index.ts'] },
      issue: issueLookup(() => ({ body: 'x'.repeat(5000) })),
    });

    const context = await build(gh);

    expect(context.linkedItems).toHaveLength(50);
    expect(context.linkedItems.every(item => item.body?.length === 5000)).toBe(true);
    expect(context.range.changedFiles).toEqual(['src/index.ts']);
    expect(logLines().some(line => /trimmed|Dropped|Cut/.test(line))).toBe(false);
  });

  it('first drops the linked items found through other linked items', async () => {
    // Issues 1 to 120 are short, and each refers to one of the long issues 1001 to 1120.
    const gh = makeClient({
      commits: range(1, 120).map(n => commitFixing([n])),
      compare: { files: ['src/index.ts'] },
      issue: issueLookup(number => ({ body: number < 1000 ? `Duplicate of #${number + 1000}` : 'x'.repeat(5000) })),
    });

    const context = await build(gh);

    expect(context.linkedItems.map(item => item.id)).toEqual(range(1, 120).map(String));
    expect(context.linkedItems[0]?.body).toBe('Duplicate of #1001');
    expect(context.range.changedFiles).toEqual(['src/index.ts']);
    expect(JSON.stringify(context).length).toBeLessThanOrEqual(MAX_CONTEXT_CHARS);
    const lines = logLines();
    expect(lines).toContainEqual(expect.stringMatching(/^The release context is about 1\d\dk tokens, over the limit of about 150k tokens, so it will be trimmed\.$/));
    expect(lines).toContainEqual(expect.stringMatching(/^Dropped 120 linked item\(s\) found through other linked items, leaving about \d+k tokens\.$/));
    expect(lines.some(line => /changed-file|Cut/.test(line))).toBe(false);
  });

  it('then drops the changed-file list', async () => {
    const files = range(1, 300).map(n => `src/${'nested/'.repeat(40)}file${n}.ts`);
    const gh = makeClient({
      commits: range(1, 105).map(n => commitFixing([n])),
      compare: { files, filesTruncated: true },
      issue: issueLookup(() => ({ body: 'x'.repeat(5000) })),
    });

    const context = await build(gh);

    expect(context.range).not.toHaveProperty('changedFiles');
    expect(context.linkedItems).toHaveLength(105);
    expect(context.linkedItems.every(item => item.body?.length === 5000)).toBe(true);
    expect(JSON.stringify(context).length).toBeLessThanOrEqual(MAX_CONTEXT_CHARS);
    expect(logLines()).toContainEqual(expect.stringMatching(/^Dropped the changed-file list, leaving about \d+k tokens\.$/));
    expect(logLines().some(line => /Cut/.test(line))).toBe(false);
  });

  it('last cuts linked item bodies shorter, until the context fits', async () => {
    // Each of 50 commits fixes five issues with 5,000-character bodies.
    const gh = makeClient({
      commits: range(0, 50).map(i => commitFixing(range(i * 5 + 1, 5))),
      compare: { files: ['src/index.ts'] },
      issue: issueLookup(() => ({ body: 'x'.repeat(5000) })),
    });

    const context = await build(gh);

    expect(context.linkedItems).toHaveLength(250);
    expect(context.linkedItems.every(item => item.body === `${'x'.repeat(997)}...`)).toBe(true);
    expect(context.linkedItems[0]?.title).toBe('Issue 1');
    expect(context.commits[0]?.message).toBe('Fixes #1, #2, #3, #4, #5');
    expect(context.range).not.toHaveProperty('changedFiles');
    expect(JSON.stringify(context).length).toBeLessThanOrEqual(MAX_CONTEXT_CHARS);
    const lines = logLines();
    expect(lines).toContainEqual(expect.stringMatching(/^Cut the bodies of 250 linked item\(s\) at 2,500 characters, leaving about \d+k tokens\.$/));
    expect(lines).toContainEqual(expect.stringMatching(/^Cut the bodies of 250 linked item\(s\) at 1,000 characters, leaving about \d+k tokens\.$/));
    expect(lines.some(line => line.includes('at 500 characters'))).toBe(false);
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('warns, and keeps the context, when trimming cannot make it fit', async () => {
    // Commit messages are never cut below 5,000 characters, so 130 of them are too large for any trimming.
    const commits = range(1, 130).map(n => makeCommit({ sha: shaFor(n), message: 'x'.repeat(5000), url: '' }));

    const context = await build(makeClient({ commits }));

    expect(context.commits).toHaveLength(130);
    expect(core.warning).toHaveBeenCalledWith(expect.stringMatching(/^The release context is still about 1\d\dk tokens after trimming, so the model may not accept it\.$/));
  });
});
