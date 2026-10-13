import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, it, expect, vi } from 'vitest';
import * as core from '@actions/core';
import * as github from '@actions/github';
import { GitHubClient, isRateLimited, isTransientFailure } from '../src/github';

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

  it('names the range and what to fix when GitHub has no such comparison, instead of a bare "Not Found"', async () => {
    const client = makeClient({ repos: { compareCommits: vi.fn().mockRejectedValue(httpError(404)) } });

    await expect(client.compareCommits('v1.0.0', 'v1.1.0')).rejects.toThrow(
      "GitHub can't compare v1.0.0...v1.1.0, because one of them isn't in acme/widgets. If v1.0.0 was deleted or renamed, fix the Full Changelog line in the release to name the previous release's tag."
    );

    const failing = makeClient({ repos: { compareCommits: vi.fn().mockRejectedValue(httpError(500)) } });
    await expect(failing.compareCommits('v1.0.0', 'v1.1.0')).rejects.toMatchObject({ status: 500 });
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
  it('keeps the sha, message and url, and leaves out the author and date', async () => {
    const getCommit = mockResponses(makeCompareCommit(7));
    const client = makeClient({ repos: { getCommit } });

    const commit = await client.getCommit('other', 'repo', 'abc');

    expect(commit).toEqual({ sha: makeCompareCommit(7).sha, message: 'Commit 7', url: makeCompareCommit(7).html_url });
    expect(getCommit).toHaveBeenCalledWith({ owner: 'other', repo: 'repo', ref: 'abc' });
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

  it("reads a tag's release id and current body, and finds nothing on a 404", async () => {
    const getReleaseByTag = mockResponses({ ...RELEASE_DATA, id: 42 }, { ...RELEASE_DATA, id: 43, body: null });
    getReleaseByTag.mockRejectedValueOnce(httpError(404));
    const client = makeClient({ repos: { getReleaseByTag } });

    expect(await client.readReleaseBody('v1.1.0')).toEqual({ id: 42, body: RELEASE_DATA.body });
    expect(await client.readReleaseBody('v1.1.0')).toEqual({ id: 43, body: '' });
    expect(await client.readReleaseBody('v1.1.0')).toBeUndefined();
    expect(getReleaseByTag).toHaveBeenCalledWith({ owner: 'acme', repo: 'widgets', tag: 'v1.1.0' });
    expect(client.getApiCallCount()).toBe(3);
  });

  it('fails when a release comes back without an id, and passes on other failures', async () => {
    const noId = makeClient({ repos: { getReleaseByTag: mockResponses(RELEASE_DATA) } });
    const failing = makeClient({ repos: { getReleaseByTag: vi.fn().mockRejectedValue(httpError(500)) } });

    await expect(noId.readReleaseBody('v1.1.0')).rejects.toThrow('GitHub returned release v1.1.0 without an id.');
    await expect(failing.readReleaseBody('v1.1.0')).rejects.toThrow('HTTP 500');
  });

  it("replaces a release's body by its id", async () => {
    const updateRelease = mockResponses({});
    const client = makeClient({ repos: { updateRelease } });

    await client.updateReleaseBody(42, 'New body');

    expect(updateRelease).toHaveBeenCalledWith({ owner: 'acme', repo: 'widgets', release_id: 42, body: 'New body' });
    expect(client.getApiCallCount()).toBe(1);
  });

  it('returns the body of the release notes GitHub generates for a tag', async () => {
    const generateReleaseNotes = mockResponses({ name: 'v1.1.0', body: RELEASE_DATA.body });
    const client = makeClient({ repos: { generateReleaseNotes } });

    expect(await client.generateReleaseNotes('v1.1.0')).toBe(RELEASE_DATA.body);
    expect(generateReleaseNotes).toHaveBeenCalledWith({ owner: 'acme', repo: 'widgets', tag_name: 'v1.1.0' });
  });
});

describe('GitHubClient rate limiting', () => {
  const request = { method: 'GET', url: '/repos/{owner}/{repo}/compare/{basehead}' };

  function throttleOptions() {
    new GitHubClient('token', 'acme', 'widgets');
    const options = vi.mocked(github.getOctokit).mock.lastCall?.[1] as any;
    return options.throttle;
  }

  beforeEach(() => {
    vi.mocked(core.warning).mockClear();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.mocked(console.log).mockRestore();
  });

  it.each(['onRateLimit', 'onSecondaryRateLimit'])('%s waits out a limit that lifts within 60 seconds, up to three times', (callback) => {
    const handler = throttleOptions()[callback];

    expect([0, 1, 2, 3].map(retryCount => handler(60, request, {}, retryCount))).toEqual([true, true, true, false]);
    expect(core.warning).toHaveBeenCalledTimes(3);
    expect(core.warning).toHaveBeenLastCalledWith(expect.stringContaining('GET /repos/{owner}/{repo}/compare/{basehead}; retrying in 60s (attempt 3 of 3).'));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('GET /repos/{owner}/{repo}/compare/{basehead} again after 3 retries, so the request fails.'));
  });

  it.each(['onRateLimit', 'onSecondaryRateLimit'])('%s gives up at once on a longer wait, such as for the hourly quota to reset', (callback) => {
    const handler = throttleOptions()[callback];

    expect(handler(61, request, {}, 0)).toBe(false);
    expect(handler(1170, request, {}, 0)).toBe(false);
    expect(core.warning).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenLastCalledWith(
      expect.stringContaining('GET /repos/{owner}/{repo}/compare/{basehead}, and it resets in 1170s, which is too long to wait, so the request fails.')
    );
  });
});

describe('isRateLimited and isTransientFailure', () => {
  // Shaped like Octokit's RequestError, which keeps the response's headers and body.
  function requestError(status: number, message: string, headers: Record<string, string> = {}) {
    return Object.assign(new Error(message), { status, response: { status, headers, data: { message } } });
  }

  it.each([
    ['the hourly quota running out', requestError(403, 'API rate limit exceeded for installation ID 1.', { 'x-ratelimit-remaining': '0' })],
    ['a secondary rate limit', requestError(403, 'You have exceeded a secondary rate limit. Please wait a few minutes before you try again.')],
    ['HTTP 429', requestError(429, 'Too Many Requests')],
    ['a GraphQL rate limit', Object.assign(new Error('GraphQL Rate Limit Exceeded'), { response: { data: { errors: [{ type: 'RATE_LIMITED' }] } } })],
  ])('reads %s as a rate limit, which is transient', (_name, error) => {
    expect(isRateLimited(error)).toBe(true);
    expect(isTransientFailure(error)).toBe(true);
  });

  it.each([408, 500, 502, 503])('reads HTTP %i as transient but not as a rate limit', (status) => {
    const error = requestError(status, `HTTP ${status}`);

    expect(isRateLimited(error)).toBe(false);
    expect(isTransientFailure(error)).toBe(true);
  });

  it.each([
    ['a 403 for a missing permission', requestError(403, 'Resource not accessible by integration', { 'x-ratelimit-remaining': '4990' })],
    ['a rejected token', requestError(401, 'Bad credentials')],
    ['a 404 that used up the last of the quota', requestError(404, 'Not Found', { 'x-ratelimit-remaining': '0' })],
    ['a 422', requestError(422, 'No common ancestor between v1.0.0 and v1.1.0.')],
    ['an error without a status', new TypeError('boom')],
    ['something that is not an error', 'boom'],
  ])('reads %s as neither', (_name, error) => {
    expect(isRateLimited(error)).toBe(false);
    expect(isTransientFailure(error)).toBe(false);
  });
});

// The real Octokit and throttling plugin against a local stand-in for the GitHub API, which shows how long a rate-limited request really waits.
describe('GitHubClient against a rate-limited API', () => {
  type Reply = { status: number; headers?: Record<string, string>; body: unknown };
  const COMMIT = { sha: 'abc1234', commit: { message: 'Fix the cache' }, html_url: 'https://github.com/acme/widgets/commit/abc1234' };

  let server: Server;
  let replies: Reply[] = [];
  let requests = 0;

  beforeAll(async () => {
    server = createServer((_req, res) => {
      requests++;
      const reply = replies.shift() ?? { status: 500, body: { message: 'No reply was queued.' } };
      res.writeHead(reply.status, { 'content-type': 'application/json', ...reply.headers });
      res.end(JSON.stringify(reply.body));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  });

  afterAll(() => {
    server.closeAllConnections();
    server.close();
  });

  beforeEach(() => {
    requests = 0;
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.mocked(console.log).mockRestore();
  });

  // The client gets the real getOctokit, pointed at the local server.
  async function makeRealClient(...queued: Reply[]) {
    replies = queued;
    const actual = await vi.importActual<typeof import('@actions/github')>('@actions/github');
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    vi.mocked(github.getOctokit).mockImplementationOnce((token, options, ...plugins) => actual.getOctokit(token, { ...options, baseUrl }, ...plugins));
    return new GitHubClient('token', 'acme', 'widgets');
  }

  it('fails at once when the quota resets in an hour, instead of waiting for it', async () => {
    const reset = String(Math.floor(Date.now() / 1000) + 3600);
    const client = await makeRealClient({
      status: 403,
      headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset },
      body: { message: 'API rate limit exceeded for installation ID 1.' },
    });

    const error = await client.getCommit('acme', 'widgets', 'abc1234').catch((caught: unknown) => caught);

    expect(isRateLimited(error)).toBe(true);
    expect(requests).toBe(1);
    expect(console.log).toHaveBeenCalledWith(expect.stringMatching(/^GitHub's request quota ran out for GET .+, and it resets in 360\ds, which is too long to wait, so the request fails\.$/));
  });

  it('waits out a one-second secondary rate limit, then reads the commit', async () => {
    const client = await makeRealClient(
      { status: 403, headers: { 'retry-after': '1' }, body: { message: 'You have exceeded a secondary rate limit.' } },
      { status: 200, body: COMMIT }
    );

    expect(await client.getCommit('acme', 'widgets', 'abc1234')).toEqual({ sha: 'abc1234', message: 'Fix the cache', url: COMMIT.html_url });
    expect(requests).toBe(2);
  });
});
