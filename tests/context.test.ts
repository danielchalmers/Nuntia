import { describe, it, expect, vi } from 'vitest';
import * as core from '@actions/core';
import { buildReleaseContext } from '../src/context';
import type { CommitDetails, GitHubClient } from '../src/github';
import type { Config } from '../src/types';

// Mock @actions/core so warnings raised during tests (e.g. the changed-file truncation path) are captured as spies instead of being written to stdout as `::warning::` workflow commands, which the GitHub Actions runner would otherwise surface as spurious annotations on the test job.
vi.mock('@actions/core', async (importActual) => {
  const actual = await importActual<typeof import('@actions/core')>();
  return { ...actual, warning: vi.fn() };
});

const BASE_CONFIG: Config = {
  owner: 'acme',
  repo: 'widgets',
  branch: 'main',
  baseCommit: 'a1b2c3d4',
  headCommit: 'a1b2c3d4',
  token: 'token',
  geminiApiKey: 'gemini-key',
  promptUrl: 'https://example.com/prompt.txt',
  model: 'gemini-3.1-flash-lite',
  maxLinkedItems: 3,
  maxReferenceDepth: 2,
  maxItemLength: 5000,
};

function makeConfig(overrides: Partial<Config> = {}): Config {
  return { ...BASE_CONFIG, ...overrides };
}

function makeCommit(overrides: Partial<CommitDetails> = {}): CommitDetails {
  return {
    sha: 'a1b2c3d4e5f6',
    message: 'Fixes #42',
    url: 'https://github.com/acme/widgets/commit/a1b2c3d4e5f6',
    author: '@dev',
    date: '2024-01-01T00:00:00Z',
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

// Matches an identical base==head range with no changed files; individual tests override what they exercise.
const COMPARE_DEFAULTS = { commits: [], status: 'identical', totalCommits: 0, files: [] };

/**
 * Build a GitHubClient stub.
 * Pass a plain object to have the method resolve to it, or a vi.fn() when the test needs to assert on how the method was called.
 */
function makeClient(opts: { compare?: Record<string, unknown>; commit?: unknown; issue?: unknown } = {}): GitHubClient {
  return {
    compareCommits: vi.fn().mockResolvedValue({ ...COMPARE_DEFAULTS, ...opts.compare }),
    getCommit: typeof opts.commit === 'function' ? opts.commit : vi.fn().mockResolvedValue(opts.commit ?? makeCommit()),
    getIssueOrPullRequest:
      typeof opts.issue === 'function' ? opts.issue : vi.fn().mockResolvedValue(opts.issue ?? makeIssue()),
  } as unknown as GitHubClient;
}

// Resolves issue/PR lookups from a table keyed by number, rejecting unknown numbers like a 404 would.
function issuesByNumber(issues: Record<number, ReturnType<typeof makeIssue>>) {
  return vi.fn().mockImplementation(async (_owner: string, _repo: string, number: number) => {
    const issue = issues[number];
    if (!issue) throw new Error(`Not Found: #${number}`);
    return issue;
  });
}

describe('buildReleaseContext', () => {
  it('includes issue labels in linked item metadata', async () => {
    const gh = makeClient({
      compare: { files: ['src/index.ts'] },
      issue: makeIssue({ labels: ['bug', 'release-note'] }),
    });

    const context = await buildReleaseContext(makeConfig(), gh);

    expect(context.linkedItems).toHaveLength(1);
    expect(context.range).toMatchObject({ totalCommits: 1, changedFiles: ['src/index.ts'], status: 'identical' });
    expect(context.linkedItems[0]).toMatchObject({
      type: 'issue',
      id: '42',
      labels: ['bug', 'release-note'],
    });
  });

  it('classifies (#123) references as pull requests and includes linked pull body', async () => {
    const gh = makeClient({
      commit: makeCommit({ message: 'Rename and consolidate inputs (#57)' }),
      issue: makeIssue({
        number: 57,
        title: 'Rename and consolidate inputs',
        body: 'This pull request contains the full migration details.',
        url: 'https://github.com/acme/widgets/pull/57',
        labels: ['release-note'],
        type: 'pull',
      }),
    });

    const context = await buildReleaseContext(makeConfig(), gh);

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
    const getCommit = vi
      .fn()
      .mockResolvedValueOnce(makeCommit({ message: `Ports https://github.com/other/repo/commit/${linkedSha}` }))
      .mockResolvedValueOnce(
        makeCommit({
          sha: linkedSha,
          message: 'Upstream fix',
          url: `https://github.com/other/repo/commit/${linkedSha}`,
        })
      );

    const context = await buildReleaseContext(makeConfig(), makeClient({ commit: getCommit }));

    expect(getCommit).toHaveBeenCalledTimes(2);
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
    const getCommit = vi
      .fn()
      .mockResolvedValueOnce(makeCommit({ message: `Fixes #42, ports https://github.com/other/repo/commit/${linkedSha}` }))
      .mockResolvedValueOnce(makeCommit({ sha: linkedSha, message: 'Upstream fix for #3' }));

    const context = await buildReleaseContext(makeConfig({ maxReferenceDepth: 1 }), makeClient({ commit: getCommit }));

    expect(context.commits[0]?.references).toEqual({ issues: [42], pulls: [], commits: [`other/repo@${linkedSha}`] });
    // "#3" in other/repo's commit means other/repo#3, not issue 3 of the release repository.
    expect(context.linkedItems.find(item => item.type === 'commit')?.references).toEqual({
      issues: ['other/repo#3'],
      pulls: [],
      commits: [],
    });
  });

  it('truncates commit messages and linked item fields to max-item-length with an ellipsis', async () => {
    const gh = makeClient({
      commit: makeCommit({ message: 'Fixes #42 with a commit message that is long' }),
      issue: makeIssue({
        title: 'This title is much longer than twenty characters',
        body: 'This body should remain present and be truncated by the same limit.',
      }),
    });

    const context = await buildReleaseContext(makeConfig({ maxItemLength: 20 }), gh);

    expect(context.commits[0]?.message).toBe('Fixes #42 with a...');
    expect(context.linkedItems[0]).toMatchObject({
      title: 'This title is muc...',
      body: 'This body should...',
    });
  });

  it('does not truncate when max-item-length is 0', async () => {
    const body = 'x'.repeat(10000);
    const gh = makeClient({ issue: makeIssue({ body }) });

    const context = await buildReleaseContext(makeConfig({ maxItemLength: 0 }), gh);

    expect(context.linkedItems[0]?.body).toBe(body);
  });

  it('applies max-linked-items per commit instead of globally', async () => {
    const getIssueOrPullRequest = vi.fn().mockImplementation(async (_owner: string, _repo: string, number: number) =>
      number === 40
        ? makeIssue({ number: 40, title: 'First linked item', body: 'Body for #40', url: 'https://github.com/acme/widgets/pull/40', type: 'pull' })
        : makeIssue({ number: 57, title: 'Second linked item', body: 'Body for #57', url: 'https://github.com/acme/widgets/pull/57', type: 'pull' })
    );

    const gh = makeClient({
      compare: {
        commits: [makeCommit({ sha: 'head5678', message: 'Follow-up change (#57)', url: 'https://github.com/acme/widgets/commit/head5678', date: '2024-01-02T00:00:00Z' })],
        status: 'ahead',
        totalCommits: 1,
      },
      commit: makeCommit({ sha: 'base1234', message: 'Initial change (#40)', url: 'https://github.com/acme/widgets/commit/base1234' }),
      issue: getIssueOrPullRequest,
    });

    const context = await buildReleaseContext(makeConfig({ baseCommit: 'base1234', headCommit: 'head5678', maxLinkedItems: 1 }), gh);
    const linkedIds = context.linkedItems.map(item => item.id);

    expect(linkedIds).toContain('40');
    expect(linkedIds).toContain('57');
    expect(getIssueOrPullRequest).toHaveBeenCalledTimes(2);
  });

  it('follows references inside linked items up to max-reference-depth', async () => {
    const getIssueOrPullRequest = issuesByNumber({
      42: makeIssue({ number: 42, body: 'Duplicate of #43' }),
      43: makeIssue({ number: 43, body: 'Root cause tracked in #44' }),
      44: makeIssue({ number: 44, body: 'Should not be fetched' }),
    });
    const gh = makeClient({ issue: getIssueOrPullRequest });

    const context = await buildReleaseContext(makeConfig({ maxReferenceDepth: 2 }), gh);

    expect(context.linkedItems.map(item => item.id)).toEqual(['42', '43']);
    expect(context.linkedItems[1]).toMatchObject({ referencedBy: ['issue:#42'], references: { issues: [44] } });
    expect(getIssueOrPullRequest).not.toHaveBeenCalledWith('acme', 'widgets', 44);
  });

  it('links nothing when max-reference-depth is 0 but still reports the commit references', async () => {
    const getIssueOrPullRequest = vi.fn();
    const gh = makeClient({ issue: getIssueOrPullRequest });

    const context = await buildReleaseContext(makeConfig({ maxReferenceDepth: 0 }), gh);

    expect(context.linkedItems).toEqual([]);
    expect(context.commits[0]?.references.issues).toEqual([42]);
    expect(getIssueOrPullRequest).not.toHaveBeenCalled();
  });

  it('stops linking items for a commit once max-linked-items is reached', async () => {
    const getIssueOrPullRequest = issuesByNumber({
      1: makeIssue({ number: 1 }),
      2: makeIssue({ number: 2 }),
      3: makeIssue({ number: 3 }),
    });
    const gh = makeClient({ commit: makeCommit({ message: 'Fixes #1, #2 and #3' }), issue: getIssueOrPullRequest });

    const context = await buildReleaseContext(makeConfig({ maxLinkedItems: 2 }), gh);

    expect(context.linkedItems.map(item => item.id)).toEqual(['1', '2']);
    expect(getIssueOrPullRequest).toHaveBeenCalledTimes(2);
  });

  it('treats max-linked-items 0 as no limit', async () => {
    const getIssueOrPullRequest = issuesByNumber({
      1: makeIssue({ number: 1 }),
      2: makeIssue({ number: 2 }),
      3: makeIssue({ number: 3 }),
    });
    const gh = makeClient({ commit: makeCommit({ message: 'Fixes #1, #2 and #3' }), issue: getIssueOrPullRequest });

    const context = await buildReleaseContext(makeConfig({ maxLinkedItems: 0 }), gh);

    expect(context.linkedItems.map(item => item.id)).toEqual(['1', '2', '3']);
  });

  it('fetches an item referenced by several commits once and records every referrer', async () => {
    const getIssueOrPullRequest = vi.fn().mockResolvedValue(makeIssue());
    const gh = makeClient({
      compare: {
        commits: [makeCommit({ sha: 'b2c3d4e5f6a7', message: 'Follow-up for #42' })],
        status: 'ahead',
        totalCommits: 1,
      },
      commit: makeCommit({ sha: 'a1b2c3d4e5f6', message: 'Fixes #42' }),
      issue: getIssueOrPullRequest,
    });

    const context = await buildReleaseContext(makeConfig({ baseCommit: 'a1b2c3d4', headCommit: 'b2c3d4e5' }), gh);

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
      compare: {
        commits: [makeCommit({ sha: 'b2c3d4e5f6a7', message: 'Follow up on #57' })],
        status: 'ahead',
        totalCommits: 1,
      },
      commit: makeCommit({ sha: 'a1b2c3d4e5f6', message: 'Ship the new inputs (#57)' }),
      issue: getIssueOrPullRequest,
    });

    const context = await buildReleaseContext(makeConfig({ baseCommit: 'a1b2c3d4', headCommit: 'b2c3d4e5' }), gh);

    expect(context.linkedItems).toHaveLength(1);
    expect(context.linkedItems[0]).toMatchObject({ type: 'pull', id: '57', referencedBy: ['commit:a1b2c3d', 'commit:b2c3d4e'] });
  });

  it('keeps building the context when a reference cannot be resolved', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const gh = makeClient({
      commit: makeCommit({ message: 'Fixes #404 and #42' }),
      issue: issuesByNumber({ 42: makeIssue() }),
    });

    try {
      const context = await buildReleaseContext(makeConfig(), gh);

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
      commit: makeCommit({ message: 'Fixes #42<!-- closes #99 -->' }),
      issue: getIssueOrPullRequest,
    });

    const context = await buildReleaseContext(makeConfig(), gh);

    expect(context.commits[0]?.message).toBe('Fixes #42');
    expect(context.commits[0]?.references.issues).toEqual([42]);
    expect(context.linkedItems).toHaveLength(1);
    expect(context.linkedItems[0]).toMatchObject({ body: 'Real body', references: { issues: [], pulls: [], commits: [] } });
    expect(getIssueOrPullRequest).toHaveBeenCalledTimes(1);
  });

  it('resolves a short SHA of a commit already in the range without fetching it again', async () => {
    const baseSha = 'aaaabbbbccccddddeeeeffff0000111122223333';
    const getCommit = vi.fn().mockResolvedValue(makeCommit({ sha: baseSha, message: 'Add caching' }));
    const gh = makeClient({
      compare: {
        commits: [makeCommit({ sha: 'ffffeeeeddddccccbbbbaaaa9999888877776666', message: 'Revert aaaabbb' })],
        status: 'ahead',
        totalCommits: 1,
      },
      commit: getCommit,
    });

    const context = await buildReleaseContext(makeConfig({ baseCommit: 'aaaabbb', headCommit: 'ffffeee' }), gh);

    expect(getCommit).toHaveBeenCalledTimes(1); // the base commit only
    expect(context.linkedItems).toEqual([]);
    expect(context.commits[1]?.references.commits).toEqual([baseSha]);
  });

  it('throws instead of producing notes when the commit range is incomplete', async () => {
    // Simulate a range whose commits could not be fully recovered.
    const gh = makeClient({
      compare: { status: 'ahead', totalCommits: 300, filesTruncated: false, commitsTruncated: false },
      commit: makeCommit({ sha: 'base1full', message: 'Base commit' }),
    });

    await expect(buildReleaseContext(makeConfig({ baseCommit: 'base1', headCommit: 'head1', maxLinkedItems: 0 }), gh)).rejects.toThrow(/incomplete/i);
  });

  it('throws when the recovery is unverified even if the counts match', async () => {
    const rangeCommits = Array.from({ length: 300 }, (_, i) =>
      makeCommit({ sha: `range${i}`.padEnd(40, '0'), message: `Change ${i}`, url: `https://github.com/acme/widgets/commit/range${i}` })
    );

    const gh = makeClient({
      compare: { commits: rangeCommits, status: 'ahead', totalCommits: 300, filesTruncated: false, commitsTruncated: true },
      commit: makeCommit({ sha: 'base1full', message: 'Base commit' }),
    });

    // base + 300 range commits = 301 == authoritative total, but the client signalled the recovery was unconfirmed, so it must still abort rather than lie.
    await expect(buildReleaseContext(makeConfig({ baseCommit: 'base1', headCommit: 'head1', maxLinkedItems: 0 }), gh)).rejects.toThrow(/incomplete/i);
  });

  it('does not throw on a capped changed-file list (files are non-fatal)', async () => {
    const gh = makeClient({
      compare: {
        commits: [makeCommit({ sha: 'c1', message: 'Change one', url: '' })],
        status: 'ahead',
        totalCommits: 1,
        files: ['a.ts', 'b.ts'],
        filesTruncated: true,
        commitsTruncated: false,
      },
      commit: makeCommit({ sha: 'base1full', message: 'Base commit' }),
    });

    vi.mocked(core.warning).mockClear();

    // The commit range is complete, so a capped file list must not abort the run.
    const context = await buildReleaseContext(makeConfig({ baseCommit: 'base1', headCommit: 'head1', maxLinkedItems: 0 }), gh);
    expect(context.range.totalCommits).toBe(2); // base + 1 range commit
    expect(context.range.changedFiles).toEqual(['a.ts', 'b.ts']);
    // The truncation must surface as a warning (captured by the mock, not leaked to stdout).
    expect(core.warning).toHaveBeenCalledWith(expect.stringMatching(/300-file compare cap/));
  });
});
