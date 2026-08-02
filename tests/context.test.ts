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

describe('buildReleaseContext', () => {
  it('includes issue labels in linked item metadata', async () => {
    const gh = makeClient({
      compare: { files: ['src/index.ts'] },
      issue: makeIssue({ labels: ['bug', 'release-note'] }),
    });

    const context = await buildReleaseContext(makeConfig(), gh);

    expect(context.linkedItems).toHaveLength(1);
    expect(context.range.changedFiles).toEqual(['src/index.ts']);
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

  it('keeps linked item body content present while truncating with max-item-length', async () => {
    const gh = makeClient({
      issue: makeIssue({
        title: 'This title is much longer than twenty characters',
        body: 'This body should remain present and be truncated by the same limit.',
      }),
    });

    const context = await buildReleaseContext(makeConfig({ maxItemLength: 20 }), gh);
    const item = context.linkedItems[0];

    expect(item?.title?.length).toBeLessThanOrEqual(20);
    expect(item?.body?.length).toBeLessThanOrEqual(20);
    expect(item?.body).toBeTruthy();
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
