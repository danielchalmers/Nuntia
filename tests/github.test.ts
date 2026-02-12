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
});
