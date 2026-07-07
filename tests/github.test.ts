import { describe, it, expect, vi } from 'vitest';
import { GitHubClient } from '../src/github';

function makeCompareCommit(index: number) {
  const sha = index.toString(16).padStart(40, '0');
  return {
    sha,
    html_url: `https://github.com/acme/widgets/commit/${sha}`,
    commit: {
      message: `Commit ${index}`,
      author: {
        name: 'Dev User',
        date: '2024-01-01T00:00:00Z',
      },
    },
    author: {
      login: 'dev',
    },
  };
}

function makePage(start: number, count: number) {
  return Array.from({ length: count }, (_, idx) => makeCompareCommit(start + idx));
}

describe('GitHubClient.compareCommits', () => {
  it('paginates compare results to include all commits', async () => {
    const compareCommits = vi
      .fn()
      .mockResolvedValueOnce({
        data: {
          status: 'ahead',
          total_commits: 306,
          commits: makePage(0, 100),
          files: [{ filename: 'src/index.ts' }, { filename: 'src/context.ts' }],
        },
      })
      .mockResolvedValueOnce({
        data: {
          status: 'ahead',
          total_commits: 306,
          commits: makePage(100, 100),
          files: [{ filename: 'src/context.ts' }, { filename: 'tests/context.test.ts' }],
        },
      })
      .mockResolvedValueOnce({
        data: {
          status: 'ahead',
          total_commits: 306,
          commits: makePage(200, 100),
          files: [],
        },
      })
      .mockResolvedValueOnce({
        data: {
          status: 'ahead',
          total_commits: 306,
          commits: makePage(300, 6),
        },
      });

    const client = new GitHubClient('token', 'acme', 'widgets') as any;
    client.octokit = {
      rest: {
        repos: {
          compareCommits,
        },
      },
    };

    const result = await client.compareCommits('base-sha', 'head-sha');

    expect(compareCommits).toHaveBeenCalledTimes(4);
    expect(compareCommits).toHaveBeenNthCalledWith(1, {
      owner: 'acme',
      repo: 'widgets',
      base: 'base-sha',
      head: 'head-sha',
      per_page: 100,
      page: 1,
    });
    expect(compareCommits).toHaveBeenNthCalledWith(4, {
      owner: 'acme',
      repo: 'widgets',
      base: 'base-sha',
      head: 'head-sha',
      per_page: 100,
      page: 4,
    });
    expect(result.status).toBe('ahead');
    expect(result.totalCommits).toBe(306);
    expect(result.commits).toHaveLength(306);
    expect(result.files).toEqual(['src/index.ts', 'src/context.ts', 'tests/context.test.ts']);
    expect(client.getApiCallCount()).toBe(4);
  });

  it('recovers the full range and confirms completion when the walk reaches the merge-base', async () => {
    const total = 260; // compare caps at 250, so the range is recovered via list-commits
    const baseCommit = makeCompareCommit(100000); // a sha outside the 0..399 range
    const baseSha = baseCommit.sha;

    const compareCommits = vi
      .fn()
      .mockResolvedValueOnce({ data: { status: 'ahead', total_commits: total, merge_base_commit: { sha: baseSha }, commits: makePage(0, 100), files: [] } })
      .mockResolvedValueOnce({ data: { status: 'ahead', total_commits: total, merge_base_commit: { sha: baseSha }, commits: makePage(100, 100), files: [] } })
      .mockResolvedValueOnce({ data: { status: 'ahead', total_commits: total, merge_base_commit: { sha: baseSha }, commits: makePage(200, 50), files: [] } });

    // Newest-first stream: 260 range commits (0..259), then the merge-base at index 260.
    const listCommits = vi
      .fn()
      .mockResolvedValueOnce({ data: makePage(0, 100) })
      .mockResolvedValueOnce({ data: makePage(100, 100) })
      .mockResolvedValueOnce({ data: [...makePage(200, 60), baseCommit, ...makePage(261, 39)] });

    const client = new GitHubClient('token', 'acme', 'widgets') as any;
    client.octokit = { rest: { repos: { compareCommits, listCommits } } };

    const result = await client.compareCommits('BASE', 'HEAD');

    expect(compareCommits).toHaveBeenCalledTimes(3);
    expect(listCommits).toHaveBeenCalledTimes(3);
    expect(result.commits).toHaveLength(260);
    expect(result.commitsTruncated).toBe(false); // merge-base reached, count matches
    expect(result.filesTruncated).toBe(false);
    expect(result.commits.some((c: any) => c.sha === baseSha)).toBe(false); // base excluded
    // Reversed to oldest-first.
    expect(result.commits[0].sha).toBe(makeCompareCommit(259).sha);
    expect(result.commits[259].sha).toBe(makeCompareCommit(0).sha);
  });

  it('flags truncation when the merge-base is never reached in the stream', async () => {
    const total = 300;
    const compareCommits = vi
      .fn()
      .mockResolvedValueOnce({ data: { status: 'ahead', total_commits: total, merge_base_commit: { sha: 'DEADBEEF' }, commits: makePage(0, 100), files: [] } })
      .mockResolvedValueOnce({ data: { status: 'ahead', total_commits: total, merge_base_commit: { sha: 'DEADBEEF' }, commits: makePage(100, 100), files: [] } })
      .mockResolvedValueOnce({ data: { status: 'ahead', total_commits: total, merge_base_commit: { sha: 'DEADBEEF' }, commits: makePage(200, 50), files: [] } });

    // The stream never contains the merge-base sha, so the walk stops on the scan bound.
    const listCommits = vi
      .fn()
      .mockResolvedValueOnce({ data: makePage(0, 100) })
      .mockResolvedValueOnce({ data: makePage(100, 100) })
      .mockResolvedValueOnce({ data: makePage(200, 100) })
      .mockResolvedValueOnce({ data: makePage(300, 100) });

    const client = new GitHubClient('token', 'acme', 'widgets') as any;
    client.octokit = { rest: { repos: { compareCommits, listCommits } } };

    const result = await client.compareCommits('BASE', 'HEAD');

    expect(result.commits).toHaveLength(300); // trimmed to the expected total (best effort)
    expect(result.commitsTruncated).toBe(true); // unconfirmed -> flagged, not silently trusted
  });

  it('flags files truncation at the 300-file compare cap', async () => {
    const files = Array.from({ length: 300 }, (_, i) => ({ filename: `src/file${i}.ts` }));
    const compareCommits = vi.fn().mockResolvedValueOnce({
      data: { status: 'ahead', total_commits: 2, merge_base_commit: { sha: 'BASE' }, commits: makePage(0, 2), files },
    });
    const listCommits = vi.fn();

    const client = new GitHubClient('token', 'acme', 'widgets') as any;
    client.octokit = { rest: { repos: { compareCommits, listCommits } } };

    const result = await client.compareCommits('BASE', 'HEAD');

    expect(result.filesTruncated).toBe(true);
    expect(result.files).toHaveLength(300);
    expect(result.commits).toHaveLength(2);
    expect(result.commitsTruncated).toBe(false); // 2 == total_commits, no commit cap hit
    expect(listCommits).not.toHaveBeenCalled();
  });

  it('caps and flags an overshoot when the merge-base is found beyond the expected total', async () => {
    const total = 260;
    const baseCommit = makeCompareCommit(100000);
    const baseSha = baseCommit.sha;

    const compareCommits = vi
      .fn()
      .mockResolvedValueOnce({ data: { status: 'ahead', total_commits: total, merge_base_commit: { sha: baseSha }, commits: makePage(0, 100), files: [] } })
      .mockResolvedValueOnce({ data: { status: 'ahead', total_commits: total, merge_base_commit: { sha: baseSha }, commits: makePage(100, 100), files: [] } })
      .mockResolvedValueOnce({ data: { status: 'ahead', total_commits: total, merge_base_commit: { sha: baseSha }, commits: makePage(200, 50), files: [] } });

    // Non-linear: 300 commits sort ahead of the merge-base by date (base at stream index 300).
    const listCommits = vi
      .fn()
      .mockResolvedValueOnce({ data: makePage(0, 100) })
      .mockResolvedValueOnce({ data: makePage(100, 100) })
      .mockResolvedValueOnce({ data: makePage(200, 100) })
      .mockResolvedValueOnce({ data: [baseCommit, ...makePage(301, 99)] });

    const client = new GitHubClient('token', 'acme', 'widgets') as any;
    client.octokit = { rest: { repos: { compareCommits, listCommits } } };

    const result = await client.compareCommits('BASE', 'HEAD');

    expect(result.commits).toHaveLength(260); // capped to total_commits, not the 300 superset
    expect(result.commitsTruncated).toBe(true); // overshoot -> unverified -> flagged
    expect(result.commits.some((c: any) => c.sha === baseSha)).toBe(false);
  });

  it('resolves the merge-base via getCommit when the compare response omits it', async () => {
    const total = 260;
    const baseCommit = makeCompareCommit(100000);
    const baseSha = baseCommit.sha;

    // Compare response omits merge_base_commit / base_commit.
    const compareCommits = vi
      .fn()
      .mockResolvedValueOnce({ data: { status: 'ahead', total_commits: total, commits: makePage(0, 100), files: [] } })
      .mockResolvedValueOnce({ data: { status: 'ahead', total_commits: total, commits: makePage(100, 100), files: [] } })
      .mockResolvedValueOnce({ data: { status: 'ahead', total_commits: total, commits: makePage(200, 50), files: [] } });
    const getCommit = vi.fn().mockResolvedValue({ data: baseCommit }); // resolves the canonical base sha
    const listCommits = vi
      .fn()
      .mockResolvedValueOnce({ data: makePage(0, 100) })
      .mockResolvedValueOnce({ data: makePage(100, 100) })
      .mockResolvedValueOnce({ data: [...makePage(200, 60), baseCommit, ...makePage(261, 39)] });

    const client = new GitHubClient('token', 'acme', 'widgets') as any;
    client.octokit = { rest: { repos: { compareCommits, listCommits, getCommit } } };

    const result = await client.compareCommits('BASE', 'HEAD');

    expect(getCommit).toHaveBeenCalled();
    expect(result.commits).toHaveLength(260);
    expect(result.commitsTruncated).toBe(false);
  });
});
