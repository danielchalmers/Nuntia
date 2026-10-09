import { describe, it, expect, vi } from 'vitest';
import * as core from '@actions/core';
import * as github from '@actions/github';
import { GitHubClient } from '../src/github';

// Capture the octokit options (for the throttle callbacks) and keep rate-limit warnings out of the test log as ::warning:: commands.
vi.mock('@actions/github', async (importActual) => {
  const actual = await importActual<typeof import('@actions/github')>();
  return { ...actual, getOctokit: vi.fn(() => ({})) };
});
vi.mock('@actions/core', async (importActual) => {
  const actual = await importActual<typeof import('@actions/core')>();
  return { ...actual, warning: vi.fn() };
});

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

// Each argument becomes one octokit response, in order, wrapped in the { data } envelope the SDK returns.
function mockResponses(...pages: unknown[]) {
  const fn = vi.fn();
  for (const page of pages) fn.mockResolvedValueOnce({ data: page });
  return fn;
}

function comparePage(total: number, commits: unknown[], files: unknown[] = []) {
  return { status: 'ahead', total_commits: total, commits, files };
}

// GitHubClient builds a real octokit in its constructor, so swap in a stub of just the endpoints under test.
function makeClient(rest: Record<string, unknown>, graphql?: unknown) {
  const client = new GitHubClient('token', 'acme', 'widgets') as any;
  client.octokit = { rest, graphql };
  return client;
}

function httpError(status: number) {
  return Object.assign(new Error(`HTTP ${status}`), { status });
}

const RELEASE_DATA = {
  tag_name: 'v1.1.0',
  name: 'Widgets 1.1',
  body: '**Full Changelog**: https://github.com/acme/widgets/compare/v1.0.0...v1.1.0',
  prerelease: false,
  target_commitish: 'main',
};

const RELEASE_DETAILS = {
  tag: 'v1.1.0',
  name: 'Widgets 1.1',
  body: '**Full Changelog**: https://github.com/acme/widgets/compare/v1.0.0...v1.1.0',
  prerelease: false,
  targetCommitish: 'main',
};

describe('GitHubClient.compareCommits', () => {
  it('paginates compare results to include all commits', async () => {
    const compareCommits = mockResponses(
      { status: 'ahead', total_commits: 306, commits: makePage(0, 100), files: [{ filename: 'src/index.ts' }, { filename: 'src/context.ts' }] },
      { status: 'ahead', total_commits: 306, commits: makePage(100, 100), files: [{ filename: 'src/context.ts' }, { filename: 'tests/context.test.ts' }] },
      { status: 'ahead', total_commits: 306, commits: makePage(200, 100), files: [] },
      { status: 'ahead', total_commits: 306, commits: makePage(300, 6) }
    );

    const client = makeClient({ repos: { compareCommits } });
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

  it('pages past 250 commits to the end of a large range', async () => {
    // Shaped like microsoft/vscode 1.93.0...1.95.0, which paged to all 2,077 commits: 20 full pages, then 77.
    const total = 2077;
    const pages = Array.from({ length: 21 }, (_, i) => comparePage(total, makePage(i * 100, Math.min(100, total - i * 100))));
    const compareCommits = mockResponses(...pages);

    const client = makeClient({ repos: { compareCommits } });
    const result = await client.compareCommits('BASE', 'HEAD');

    expect(compareCommits).toHaveBeenCalledTimes(21);
    expect(result.totalCommits).toBe(2077);
    expect(result.commits).toHaveLength(2077);
    expect(result.commits[0].sha).toBe(makeCompareCommit(0).sha);
    expect(result.commits[2076].sha).toBe(makeCompareCommit(2076).sha);
  });

  it('stops once total_commits is reached without fetching an empty trailing page', async () => {
    const compareCommits = mockResponses(
      comparePage(300, makePage(0, 100)),
      comparePage(300, makePage(100, 100)),
      comparePage(300, makePage(200, 100))
    );

    const client = makeClient({ repos: { compareCommits } });
    const result = await client.compareCommits('BASE', 'HEAD');

    expect(compareCommits).toHaveBeenCalledTimes(3);
    expect(result.commits).toHaveLength(300);
  });

  it('returns the commits it got when compare comes back short of total_commits', async () => {
    // The caller compares the count with total_commits and fails the run, so the client must not pad or trim the list.
    const compareCommits = mockResponses(
      comparePage(300, makePage(0, 100)),
      comparePage(300, makePage(100, 100)),
      comparePage(300, makePage(200, 50)),
      comparePage(300, [])
    );

    const client = makeClient({ repos: { compareCommits } });
    const result = await client.compareCommits('BASE', 'HEAD');

    expect(compareCommits).toHaveBeenCalledTimes(4);
    expect(result.totalCommits).toBe(300);
    expect(result.commits).toHaveLength(250);
  });

  it('flags files truncation at the 300-file compare cap', async () => {
    const files = Array.from({ length: 300 }, (_, i) => ({ filename: `src/file${i}.ts` }));
    const compareCommits = mockResponses(comparePage(2, makePage(0, 2), files));

    const client = makeClient({ repos: { compareCommits } });
    const result = await client.compareCommits('BASE', 'HEAD');

    expect(result.filesTruncated).toBe(true);
    expect(result.files).toHaveLength(300);
    expect(result.commits).toHaveLength(2);
  });

  it('pages until a short page when total_commits is missing', async () => {
    const page = (commits: unknown[]) => ({ status: 'ahead', commits });
    const compareCommits = mockResponses(page(makePage(0, 100)), page(makePage(100, 100)), page(makePage(200, 40)));

    const client = makeClient({ repos: { compareCommits } });
    const result = await client.compareCommits('BASE', 'HEAD');

    expect(compareCommits).toHaveBeenCalledTimes(3);
    expect(result.totalCommits).toBeUndefined();
    expect(result.commits).toHaveLength(240);
  });

  it('stops paginating when a page adds no new commits', async () => {
    // Without the no-progress guard, a server repeating the same full page would loop forever.
    const repeated = { status: 'ahead', commits: makePage(0, 100) };
    const compareCommits = vi.fn().mockResolvedValue({ data: repeated });

    const client = makeClient({ repos: { compareCommits } });
    const result = await client.compareCommits('BASE', 'HEAD');

    expect(compareCommits).toHaveBeenCalledTimes(2);
    expect(result.commits).toHaveLength(100);
  });
});

describe('GitHubClient.getCommit', () => {
  it.each([
    ['prefixes the GitHub login with @', { author: { login: 'octocat' } }, '@octocat'],
    ['falls back to the committer login', { committer: { login: 'web-flow' } }, '@web-flow'],
    ['uses the git author name when there is no GitHub account', { commit: { message: 'm', author: { name: 'Jane Dev' } } }, 'Jane Dev'],
    ['reports unknown when nothing identifies the author', { commit: { message: 'm' } }, 'unknown'],
  ])('%s', async (_label, data, expected) => {
    const client = makeClient({ repos: { getCommit: mockResponses({ sha: 'abc', ...data }) } });

    const commit = await client.getCommit('acme', 'widgets', 'abc');

    expect(commit.author).toBe(expected);
  });
});

describe('GitHubClient.getIssueOrPullRequest', () => {
  it('maps an issue with trimmed, de-duplicated labels', async () => {
    const client = makeClient({
      issues: {
        get: mockResponses({
          number: 42,
          title: 'Crash on start',
          body: null,
          html_url: 'https://github.com/acme/widgets/issues/42',
          state: 'open',
          labels: [' bug ', { name: 'bug' }, { name: 'release-note' }, { name: '  ' }, { color: 'fff' }, ''],
        }),
      },
    });

    const details = await client.getIssueOrPullRequest('other', 'repo', 42);

    expect(details).toEqual({
      number: 42,
      title: 'Crash on start',
      body: '',
      url: 'https://github.com/acme/widgets/issues/42',
      state: 'open',
      labels: ['bug', 'release-note'],
      type: 'issue',
      owner: 'other',
      repo: 'repo',
    });
  });

  it('reports a merged pull request as state "merged"', async () => {
    // The issues endpoint reports a merged PR with state 'closed'; merged_at is what marks it as shipped.
    const client = makeClient({
      issues: {
        get: mockResponses({
          number: 57,
          html_url: 'https://github.com/acme/widgets/pull/57',
          state: 'closed',
          pull_request: { merged_at: '2024-01-02T00:00:00Z' },
        }),
      },
    });

    const details = await client.getIssueOrPullRequest('acme', 'widgets', 57);

    expect(details.state).toBe('merged');
    expect(details.type).toBe('pull');
  });

  it('keeps a pull request closed without merging as state "closed"', async () => {
    const client = makeClient({
      issues: {
        get: mockResponses({
          number: 58,
          html_url: 'https://github.com/acme/widgets/pull/58',
          state: 'closed',
          pull_request: { merged_at: null },
        }),
      },
    });

    const details = await client.getIssueOrPullRequest('acme', 'widgets', 58);

    expect(details.state).toBe('closed');
  });
});

describe('GitHubClient releases', () => {
  it("reads a tag's release", async () => {
    const getReleaseByTag = mockResponses(RELEASE_DATA);
    const client = makeClient({ repos: { getReleaseByTag } });

    expect(await client.findReleaseByTag('v1.1.0')).toEqual(RELEASE_DETAILS);
    expect(getReleaseByTag).toHaveBeenCalledWith({ owner: 'acme', repo: 'widgets', tag: 'v1.1.0' });
  });

  it('reads the latest release', async () => {
    const getLatestRelease = mockResponses(RELEASE_DATA);
    const client = makeClient({ repos: { getLatestRelease } });

    expect(await client.findLatestRelease()).toEqual(RELEASE_DETAILS);
    expect(getLatestRelease).toHaveBeenCalledWith({ owner: 'acme', repo: 'widgets' });
  });

  it.each([
    ['findReleaseByTag', 'getReleaseByTag'],
    ['findLatestRelease', 'getLatestRelease'],
  ])('%s finds nothing on a 404, and passes on any other failure', async (method, endpoint) => {
    const notFound = makeClient({ repos: { [endpoint]: vi.fn().mockRejectedValue(httpError(404)) } });
    const failing = makeClient({ repos: { [endpoint]: vi.fn().mockRejectedValue(httpError(500)) } });

    await expect(notFound[method]('v1.1.0')).resolves.toBeUndefined();
    await expect(failing[method]('v1.1.0')).rejects.toThrow('HTTP 500');
  });

  it('asks GraphQL for the tag with the newest commit', async () => {
    const graphql = vi.fn().mockResolvedValue({ repository: { refs: { nodes: [{ name: 'v0.3.0' }] } } });
    const client = makeClient({}, graphql);

    expect(await client.findNewestTag()).toBe('v0.3.0');
    expect(graphql).toHaveBeenCalledWith(expect.stringContaining('orderBy: { field: TAG_COMMIT_DATE, direction: DESC }'), { owner: 'acme', repo: 'widgets' });
  });

  it('finds no newest tag in a repository without tags', async () => {
    const client = makeClient({}, vi.fn().mockResolvedValue({ repository: { refs: { nodes: [] } } }));

    expect(await client.findNewestTag()).toBeUndefined();
  });

  it('returns the body of the release notes GitHub generates for a tag', async () => {
    const generateReleaseNotes = mockResponses({ name: 'v1.1.0', body: RELEASE_DATA.body });
    const client = makeClient({ repos: { generateReleaseNotes } });

    expect(await client.generateReleaseNotes('v1.1.0')).toBe(RELEASE_DATA.body);
    expect(generateReleaseNotes).toHaveBeenCalledWith({ owner: 'acme', repo: 'widgets', tag_name: 'v1.1.0' });
  });
});

describe('GitHubClient rate limiting', () => {
  function throttleOptions() {
    new GitHubClient('token', 'acme', 'widgets');
    const options = vi.mocked(github.getOctokit).mock.lastCall?.[1] as any;
    return options.throttle;
  }

  it.each(['onRateLimit', 'onSecondaryRateLimit'])('%s retries up to three times, then gives up', (callback) => {
    const handler = throttleOptions()[callback];
    const request = { method: 'GET', url: '/repos/{owner}/{repo}/compare/{basehead}' };

    expect([0, 1, 2, 3].map(retryCount => handler(30, request, {}, retryCount))).toEqual([true, true, true, false]);
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('GET /repos/{owner}/{repo}/compare/{basehead}'));
  });
});
