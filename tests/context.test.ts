import { describe, it, expect, vi } from 'vitest';
import * as core from '@actions/core';
import { buildReleaseContext } from '../src/context';
import type { GitHubClient } from '../src/github';
import type { Config } from '../src/types';

// Mock @actions/core so warnings raised during tests (e.g. the changed-file truncation path) are
// captured as spies instead of being written to stdout as `::warning::` workflow commands, which the
// GitHub Actions runner would otherwise surface as spurious annotations on the test job.
vi.mock('@actions/core', async (importActual) => {
  const actual = await importActual<typeof import('@actions/core')>();
  return { ...actual, warning: vi.fn() };
});

describe('buildReleaseContext', () => {
  it('includes issue labels in linked item metadata', async () => {
    const cfg: Config = {
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

    const gh = {
      compareCommits: vi.fn().mockResolvedValue({
        commits: [],
        status: 'identical',
        totalCommits: 0,
        files: ['src/index.ts'],
      }),
      getCommit: vi.fn().mockResolvedValue({
        sha: 'a1b2c3d4e5f6',
        message: 'Fixes #42',
        url: 'https://github.com/acme/widgets/commit/a1b2c3d4e5f6',
        author: '@dev',
        date: '2024-01-01T00:00:00Z',
      }),
      getIssueOrPullRequest: vi.fn().mockResolvedValue({
        number: 42,
        title: 'Patch release race condition',
        body: 'Resolves edge case when sync happens concurrently.',
        url: 'https://github.com/acme/widgets/issues/42',
        state: 'closed',
        labels: ['bug', 'release-note'],
        type: 'issue',
        owner: 'acme',
        repo: 'widgets',
      }),
    } as unknown as GitHubClient;

    const context = await buildReleaseContext(cfg, gh);

    expect(context.linkedItems).toHaveLength(1);
    expect(context.range.changedFiles).toEqual(['src/index.ts']);
    expect(context.linkedItems[0]).toMatchObject({
      type: 'issue',
      id: '42',
      labels: ['bug', 'release-note'],
    });
  });

  it('classifies (#123) references as pull requests and includes linked pull body', async () => {
    const cfg: Config = {
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

    const gh = {
      compareCommits: vi.fn().mockResolvedValue({
        commits: [],
        status: 'identical',
        totalCommits: 0,
        files: [],
      }),
      getCommit: vi.fn().mockResolvedValue({
        sha: 'a1b2c3d4e5f6',
        message: 'Rename and consolidate inputs (#57)',
        url: 'https://github.com/acme/widgets/commit/a1b2c3d4e5f6',
        author: '@dev',
        date: '2024-01-01T00:00:00Z',
      }),
      getIssueOrPullRequest: vi.fn().mockResolvedValue({
        number: 57,
        title: 'Rename and consolidate inputs',
        body: 'This pull request contains the full migration details.',
        url: 'https://github.com/acme/widgets/pull/57',
        state: 'closed',
        labels: ['release-note'],
        type: 'pull',
        owner: 'acme',
        repo: 'widgets',
      }),
    } as unknown as GitHubClient;

    const context = await buildReleaseContext(cfg, gh);

    expect(context.commits[0]?.references.issues).toEqual([]);
    expect(context.commits[0]?.references.pulls).toEqual([57]);
    expect(context.linkedItems[0]).toMatchObject({
      type: 'pull',
      id: '57',
      body: 'This pull request contains the full migration details.',
    });
  });

  it('keeps linked item body content present while truncating with max-item-length', async () => {
    const cfg: Config = {
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
      maxItemLength: 20,
    };

    const gh = {
      compareCommits: vi.fn().mockResolvedValue({
        commits: [],
        status: 'identical',
        totalCommits: 0,
        files: [],
      }),
      getCommit: vi.fn().mockResolvedValue({
        sha: 'a1b2c3d4e5f6',
        message: 'Fixes #42',
        url: 'https://github.com/acme/widgets/commit/a1b2c3d4e5f6',
        author: '@dev',
        date: '2024-01-01T00:00:00Z',
      }),
      getIssueOrPullRequest: vi.fn().mockResolvedValue({
        number: 42,
        title: 'This title is much longer than twenty characters',
        body: 'This body should remain present and be truncated by the same limit.',
        url: 'https://github.com/acme/widgets/issues/42',
        state: 'closed',
        labels: [],
        type: 'issue',
        owner: 'acme',
        repo: 'widgets',
      }),
    } as unknown as GitHubClient;

    const context = await buildReleaseContext(cfg, gh);
    const item = context.linkedItems[0];

    expect(item?.title?.length).toBeLessThanOrEqual(20);
    expect(item?.body?.length).toBeLessThanOrEqual(20);
    expect(item?.body).toBeTruthy();
  });

  it('applies max-linked-items per commit instead of globally', async () => {
    const cfg: Config = {
      owner: 'acme',
      repo: 'widgets',
      branch: 'main',
      baseCommit: 'base1234',
      headCommit: 'head5678',
      token: 'token',
      geminiApiKey: 'gemini-key',
      promptUrl: 'https://example.com/prompt.txt',
      model: 'gemini-3.1-flash-lite',
      maxLinkedItems: 1,
      maxReferenceDepth: 2,
      maxItemLength: 5000,
    };

    const getIssueOrPullRequest = vi.fn().mockImplementation(async (_owner: string, _repo: string, number: number) => {
      if (number === 40) {
        return {
          number: 40,
          title: 'First linked item',
          body: 'Body for #40',
          url: 'https://github.com/acme/widgets/pull/40',
          state: 'closed',
          labels: [],
          type: 'pull',
          owner: 'acme',
          repo: 'widgets',
        };
      }
      return {
        number: 57,
        title: 'Second linked item',
        body: 'Body for #57',
        url: 'https://github.com/acme/widgets/pull/57',
        state: 'closed',
        labels: [],
        type: 'pull',
        owner: 'acme',
        repo: 'widgets',
      };
    });

    const gh = {
      compareCommits: vi.fn().mockResolvedValue({
        commits: [
          {
            sha: 'head5678',
            message: 'Follow-up change (#57)',
            url: 'https://github.com/acme/widgets/commit/head5678',
            author: '@dev',
            date: '2024-01-02T00:00:00Z',
          },
        ],
        status: 'ahead',
        totalCommits: 1,
        files: [],
      }),
      getCommit: vi.fn().mockResolvedValue({
        sha: 'base1234',
        message: 'Initial change (#40)',
        url: 'https://github.com/acme/widgets/commit/base1234',
        author: '@dev',
        date: '2024-01-01T00:00:00Z',
      }),
      getIssueOrPullRequest,
    } as unknown as GitHubClient;

    const context = await buildReleaseContext(cfg, gh);
    const linkedIds = context.linkedItems.map(item => item.id);

    expect(linkedIds).toContain('40');
    expect(linkedIds).toContain('57');
    expect(getIssueOrPullRequest).toHaveBeenCalledTimes(2);
  });

  it('throws instead of producing notes when the commit range is incomplete', async () => {
    const cfg: Config = {
      owner: 'acme',
      repo: 'widgets',
      branch: 'main',
      baseCommit: 'base1',
      headCommit: 'head1',
      token: 'token',
      geminiApiKey: 'gemini-key',
      promptUrl: 'https://example.com/prompt.txt',
      model: 'gemini-3.1-flash-lite',
      maxLinkedItems: 0,
      maxReferenceDepth: 2,
      maxItemLength: 5000,
    };

    const gh = {
      // Simulate a range whose commits could not be fully recovered.
      compareCommits: vi.fn().mockResolvedValue({
        commits: [],
        status: 'ahead',
        totalCommits: 300,
        files: [],
        filesTruncated: false,
        commitsTruncated: false,
      }),
      getCommit: vi.fn().mockResolvedValue({
        sha: 'base1full',
        message: 'Base commit',
        url: 'https://github.com/acme/widgets/commit/base1full',
        author: '@dev',
        date: '2024-01-01T00:00:00Z',
      }),
      getIssueOrPullRequest: vi.fn(),
    } as unknown as GitHubClient;

    await expect(buildReleaseContext(cfg, gh)).rejects.toThrow(/incomplete/i);
  });

  it('throws when the recovery is unverified even if the counts match', async () => {
    const cfg: Config = {
      owner: 'acme', repo: 'widgets', branch: 'main',
      baseCommit: 'base1', headCommit: 'head1',
      token: 'token', geminiApiKey: 'gemini-key',
      promptUrl: 'https://example.com/prompt.txt', model: 'gemini-3.1-flash-lite',
      maxLinkedItems: 0, maxReferenceDepth: 2, maxItemLength: 5000,
    };

    const rangeCommits = Array.from({ length: 300 }, (_, i) => ({
      sha: `range${i}`.padEnd(40, '0'),
      message: `Change ${i}`,
      url: `https://github.com/acme/widgets/commit/range${i}`,
      author: '@dev',
      date: '2024-01-01T00:00:00Z',
    }));

    const gh = {
      compareCommits: vi.fn().mockResolvedValue({
        commits: rangeCommits,
        status: 'ahead',
        totalCommits: 300,
        files: [],
        filesTruncated: false,
        commitsTruncated: true, // recovery could not confirm completeness
      }),
      getCommit: vi.fn().mockResolvedValue({
        sha: 'base1full', message: 'Base commit',
        url: 'https://github.com/acme/widgets/commit/base1full', author: '@dev', date: '2024-01-01T00:00:00Z',
      }),
      getIssueOrPullRequest: vi.fn(),
    } as unknown as GitHubClient;

    // base + 300 range commits = 301 == authoritative total, but the client signalled
    // the recovery was unconfirmed, so it must still abort rather than lie.
    await expect(buildReleaseContext(cfg, gh)).rejects.toThrow(/incomplete/i);
  });

  it('does not throw on a capped changed-file list (files are non-fatal)', async () => {
    const cfg: Config = {
      owner: 'acme', repo: 'widgets', branch: 'main',
      baseCommit: 'base1', headCommit: 'head1',
      token: 'token', geminiApiKey: 'gemini-key',
      promptUrl: 'https://example.com/prompt.txt', model: 'gemini-3.1-flash-lite',
      maxLinkedItems: 0, maxReferenceDepth: 2, maxItemLength: 5000,
    };

    const gh = {
      compareCommits: vi.fn().mockResolvedValue({
        commits: [{ sha: 'c1', message: 'Change one', url: '', author: '@dev', date: '2024-01-01T00:00:00Z' }],
        status: 'ahead',
        totalCommits: 1,
        files: ['a.ts', 'b.ts'],
        filesTruncated: true,
        commitsTruncated: false,
      }),
      getCommit: vi.fn().mockResolvedValue({
        sha: 'base1full', message: 'Base commit',
        url: 'https://github.com/acme/widgets/commit/base1full', author: '@dev', date: '2024-01-01T00:00:00Z',
      }),
      getIssueOrPullRequest: vi.fn(),
    } as unknown as GitHubClient;

    vi.mocked(core.warning).mockClear();

    // The commit range is complete, so a capped file list must not abort the run.
    const context = await buildReleaseContext(cfg, gh);
    expect(context.range.totalCommits).toBe(2); // base + 1 range commit
    expect(context.range.changedFiles).toEqual(['a.ts', 'b.ts']);
    // The truncation must surface as a warning (captured by the mock, not leaked to stdout).
    expect(core.warning).toHaveBeenCalledWith(expect.stringMatching(/300-file compare cap/));
  });

  it("throws on a 'behind' range instead of emitting base-only notes", async () => {
    const cfg: Config = {
      owner: 'acme', repo: 'widgets', branch: 'main',
      baseCommit: 'newer', headCommit: 'older', // reversed
      token: 'token', geminiApiKey: 'gemini-key',
      promptUrl: 'https://example.com/prompt.txt', model: 'gemini-3.1-flash-lite',
      maxLinkedItems: 0, maxReferenceDepth: 2, maxItemLength: 5000,
    };

    const gh = {
      compareCommits: vi.fn().mockResolvedValue({
        commits: [], status: 'behind', totalCommits: 0, files: [],
        filesTruncated: false, commitsTruncated: false,
      }),
      getCommit: vi.fn(),
      getIssueOrPullRequest: vi.fn(),
    } as unknown as GitHubClient;

    await expect(buildReleaseContext(cfg, gh)).rejects.toThrow(/behind/i);
    // Must fail before fetching the base commit, not after producing a single-commit range.
    expect((gh.getCommit as any)).not.toHaveBeenCalled();
  });
});
