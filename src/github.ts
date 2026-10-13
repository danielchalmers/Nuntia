import * as core from '@actions/core';
import * as github from '@actions/github';
import { throttling } from '@octokit/plugin-throttling';

export type CommitDetails = {
  sha: string;
  message: string;
  url: string;
};

export type IssueOrPullDetails = {
  number: number;
  title: string;
  body: string;
  url: string;
  state: string;
  labels: string[];
  type: 'issue' | 'pull';
};

export type ReleaseDetails = {
  tag: string;
  name: string | null;
  body: string;
  prerelease: boolean;
  // The branch or commit the release's tag was created from.
  targetCommitish: string;
};

// Only GraphQL can order tags by the date of their commit.
const NEWEST_TAG_QUERY = `query($owner: String!, $repo: String!) {
  repository(owner: $owner, name: $repo) {
    refs(refPrefix: "refs/tags/", first: 1, orderBy: { field: TAG_COMMIT_DATE, direction: DESC }) {
      nodes { name }
    }
  }
}`;

// A rate limit that lifts within this many seconds is waited out.
// A longer wait, such as for an hourly quota that has run out, could hold the job for up to an hour, so the request fails instead.
const MAX_RATE_LIMIT_WAIT_SECONDS = 60;
// How many times one request is sent again after a rate limit.
const MAX_RATE_LIMIT_RETRIES = 3;

/** The HTTP status of a failed GitHub request, if it has one. */
export function httpStatus(error: unknown): number | undefined {
  return typeof error === 'object' && error !== null && 'status' in error && typeof error.status === 'number' ? error.status : undefined;
}

/**
 * Whether a GitHub request failed on a rate limit that wasn't waited out.
 * A 403 counts only when GitHub says it's a rate limit, because any other 403 means the token is missing a permission.
 */
export function isRateLimited(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const response: any = 'response' in error ? error.response : undefined;
  // The throttling plugin throws a GraphQL rate limit without a status.
  const errors: unknown = response?.data?.errors;
  if (Array.isArray(errors) && errors.some(item => item?.type === 'RATE_LIMITED')) return true;

  const status = httpStatus(error);
  if (status === 429) return true;
  if (status !== 403) return false;
  return response?.headers?.['x-ratelimit-remaining'] === '0' || (error instanceof Error && /rate limit/i.test(error.message));
}

/**
 * Whether a GitHub request failed in a way that a later run can get past: a rate limit, a timeout, or GitHub or the network being unavailable.
 * Octokit reports a request that never got a response as HTTP 500.
 */
export function isTransientFailure(error: unknown): boolean {
  const status = httpStatus(error);
  return isRateLimited(error) || status === 408 || (status !== undefined && status >= 500);
}

/**
 * The throttling plugin's answer to a rate limit: whether to wait retryAfter seconds and send the request again.
 * It gives up on a long wait at once, and the caller decides whether the failed request ends the run.
 */
function retryRateLimit(what: string, retryAfter: number, options: { method: string; url: string }, retryCount: number): boolean {
  const request = `${options.method} ${options.url}`;
  if (retryAfter > MAX_RATE_LIMIT_WAIT_SECONDS) {
    console.log(`${what} for ${request}, and it resets in ${retryAfter}s, which is too long to wait, so the request fails.`);
    return false;
  }
  if (retryCount >= MAX_RATE_LIMIT_RETRIES) {
    console.log(`${what} for ${request} again after ${MAX_RATE_LIMIT_RETRIES} retries, so the request fails.`);
    return false;
  }
  core.warning(`${what} for ${request}; retrying in ${retryAfter}s (attempt ${retryCount + 1} of ${MAX_RATE_LIMIT_RETRIES}).`);
  return true;
}

/**
 * Narrow a release from the REST API or from a release event's payload.
 * Throws when it has no tag, because nothing else identifies the release.
 */
export function toReleaseDetails(data: any): ReleaseDetails {
  const tag = typeof data?.tag_name === 'string' ? data.tag_name.trim() : '';
  if (!tag) throw new Error('The release has no tag name.');
  const name = typeof data?.name === 'string' ? data.name.trim() : '';
  return {
    tag,
    name: name || null,
    body: typeof data?.body === 'string' ? data.body : '',
    prerelease: data?.prerelease === true,
    targetCommitish: typeof data?.target_commitish === 'string' ? data.target_commitish : '',
  };
}

export class GitHubClient {
  private octokit;
  private apiCallCount = 0;

  constructor(token: string, private owner: string, private repo: string) {
    // Register the throttling plugin so GitHub API calls wait out a short rate limit instead of failing.
    this.octokit = github.getOctokit(
      token,
      {
        throttle: {
          onRateLimit: (retryAfter, options, _octokit, retryCount) => retryRateLimit("GitHub's request quota ran out", retryAfter, options, retryCount),
          onSecondaryRateLimit: (retryAfter, options, _octokit, retryCount) => retryRateLimit("GitHub's secondary rate limit was hit", retryAfter, options, retryCount),
        },
      },
      throttling
    );
  }

  /** The requests this client has sent so far in the run, which the release context spends as its budget. */
  getApiCallCount(): number {
    return this.apiCallCount;
  }

  private incrementApiCalls(): void {
    this.apiCallCount++;
  }

  private mapCommit(data: any): CommitDetails {
    return {
      sha: data?.sha || '',
      message: data?.commit?.message || '',
      url: data?.html_url || '',
    };
  }

  private mapLabels(data: any): string[] {
    if (!Array.isArray(data?.labels)) return [];
    const labels = new Set<string>();
    for (const label of data.labels) {
      const name = typeof label === 'string' ? label : label?.name;
      if (typeof name === 'string' && name.trim()) labels.add(name.trim());
    }
    return Array.from(labels);
  }

  async compareCommits(
    base: string,
    head: string
  ): Promise<{ commits: CommitDetails[]; totalCommits?: number; files: string[]; filesTruncated: boolean }> {
    const perPage = 100;
    let page = 1;
    let totalCommits: number | undefined;
    const commits: CommitDetails[] = [];
    const seenShas = new Set<string>();
    const files: string[] = [];
    const seenFiles = new Set<string>();

    while (true) {
      this.incrementApiCalls();
      const { data } = await this.octokit.rest.repos.compareCommits({
        owner: this.owner,
        repo: this.repo,
        base,
        head,
        per_page: perPage,
        page,
      }).catch((error: unknown) => {
        // GitHub answers a range with a missing end with a bare "Not Found", which doesn't say which end or what to fix.
        if (httpStatus(error) !== 404) throw error;
        throw new Error(`GitHub can't compare ${base}...${head}, because one of them isn't in ${this.owner}/${this.repo}. If ${base} was deleted or renamed, fix the Full Changelog line in the release to name the previous release's tag.`);
      });

      if (totalCommits === undefined && typeof data?.total_commits === 'number') {
        totalCommits = data.total_commits;
      }

      const pageCommits = Array.isArray(data?.commits) ? data.commits : [];
      const pageFiles = Array.isArray(data?.files) ? data.files : [];
      const initialCount = commits.length;

      for (const commit of pageCommits) {
        const sha = typeof commit?.sha === 'string' ? commit.sha : '';
        if (sha && seenShas.has(sha)) continue;
        if (sha) seenShas.add(sha);
        commits.push(this.mapCommit(commit));
      }
      for (const file of pageFiles) {
        const filename = typeof file?.filename === 'string' ? file.filename : '';
        if (!filename || seenFiles.has(filename)) continue;
        seenFiles.add(filename);
        files.push(filename);
      }

      // Page until the collected commits reach total_commits, or until a short page when the total is missing.
      // A page that adds nothing also ends the loop, so a range that comes back short stops here and the caller rejects the count.
      const reachedEnd = typeof totalCommits === 'number' ? commits.length >= totalCommits : pageCommits.length < perPage;
      const madeNoProgress = commits.length === initialCount;
      if (reachedEnd || madeNoProgress) break;

      page++;
    }

    // The compare endpoint caps the changed-file list at 300 entries, all returned on the first page.
    const filesTruncated = files.length >= 300;

    return {
      commits,
      files,
      filesTruncated,
      ...(totalCommits !== undefined && { totalCommits }),
    };
  }

  async getCommit(owner: string, repo: string, ref: string): Promise<CommitDetails> {
    this.incrementApiCalls();
    const { data } = await this.octokit.rest.repos.getCommit({
      owner,
      repo,
      ref,
    });
    return this.mapCommit(data);
  }

  /** The published release for a tag, or undefined when the tag has none. */
  async findReleaseByTag(tag: string): Promise<ReleaseDetails | undefined> {
    this.incrementApiCalls();
    try {
      const { data } = await this.octokit.rest.repos.getReleaseByTag({ owner: this.owner, repo: this.repo, tag });
      return toReleaseDetails(data);
    } catch (error) {
      if (httpStatus(error) === 404) return undefined;
      throw error;
    }
  }

  /** The release GitHub marks as latest, or undefined when the repository has no published release. */
  async findLatestRelease(): Promise<ReleaseDetails | undefined> {
    this.incrementApiCalls();
    try {
      const { data } = await this.octokit.rest.repos.getLatestRelease({ owner: this.owner, repo: this.repo });
      return toReleaseDetails(data);
    } catch (error) {
      if (httpStatus(error) === 404) return undefined;
      throw error;
    }
  }

  /** The tag whose commit is newest, or undefined when the repository has no tags. */
  async findNewestTag(): Promise<string | undefined> {
    this.incrementApiCalls();
    const data: any = await this.octokit.graphql(NEWEST_TAG_QUERY, { owner: this.owner, repo: this.repo });
    const name = data?.repository?.refs?.nodes?.[0]?.name;
    return typeof name === 'string' && name ? name : undefined;
  }

  /** The id and current body of the published release for a tag, or undefined when the tag has none. */
  async readReleaseBody(tag: string): Promise<{ id: number; body: string } | undefined> {
    this.incrementApiCalls();
    let data: any;
    try {
      ({ data } = await this.octokit.rest.repos.getReleaseByTag({ owner: this.owner, repo: this.repo, tag }));
    } catch (error) {
      if (httpStatus(error) === 404) return undefined;
      throw error;
    }
    if (typeof data?.id !== 'number') throw new Error(`GitHub returned release ${tag} without an id.`);
    return { id: data.id, body: typeof data.body === 'string' ? data.body : '' };
  }

  /** Replace a release's body, which needs contents: write. */
  async updateReleaseBody(id: number, body: string): Promise<void> {
    this.incrementApiCalls();
    await this.octokit.rest.repos.updateRelease({ owner: this.owner, repo: this.repo, release_id: id, body });
  }

  /**
   * The body GitHub would generate as release notes for a tag.
   * It changes nothing, but GitHub still requires contents: write for it.
   */
  async generateReleaseNotes(tag: string): Promise<string> {
    this.incrementApiCalls();
    const { data } = await this.octokit.rest.repos.generateReleaseNotes({ owner: this.owner, repo: this.repo, tag_name: tag });
    return typeof data?.body === 'string' ? data.body : '';
  }

  async getIssueOrPullRequest(owner: string, repo: string, issueNumber: number): Promise<IssueOrPullDetails> {
    this.incrementApiCalls();
    const { data } = await this.octokit.rest.issues.get({
      owner,
      repo,
      issue_number: issueNumber,
    });

    return {
      number: data.number,
      title: data.title || '',
      body: data.body || '',
      url: data.html_url || '',
      // The issues endpoint reports a merged PR as 'closed' too; pull_request.merged_at distinguishes it from one closed without merging so unmerged PRs aren't described as shipped.
      state: data.pull_request?.merged_at ? 'merged' : data.state || 'open',
      labels: this.mapLabels(data),
      type: data.pull_request ? 'pull' : 'issue',
    };
  }
}
