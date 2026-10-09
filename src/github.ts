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
  owner: string;
  repo: string;
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

/** The HTTP status of a failed GitHub request, if it has one. */
export function httpStatus(error: unknown): number | undefined {
  return typeof error === 'object' && error !== null && 'status' in error && typeof error.status === 'number' ? error.status : undefined;
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
    // Register the throttling plugin so GitHub API calls back off on the primary and secondary rate limits instead of failing the run.
    this.octokit = github.getOctokit(
      token,
      {
        throttle: {
          onRateLimit: (retryAfter, options, _octokit, retryCount) => {
            core.warning(`GitHub request quota exhausted for ${options.method} ${options.url}; retrying in ${retryAfter}s (attempt ${retryCount + 1}).`);
            return retryCount < 3;
          },
          onSecondaryRateLimit: (retryAfter, options, _octokit, retryCount) => {
            core.warning(`GitHub secondary rate limit hit for ${options.method} ${options.url}; retrying in ${retryAfter}s (attempt ${retryCount + 1}).`);
            return retryCount < 3;
          },
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
    const labels: string[] = [];

    for (const label of data.labels) {
      if (typeof label === 'string') {
        const trimmed = label.trim();
        if (trimmed) labels.push(trimmed);
        continue;
      }

      const rawName = label?.name;
      if (typeof rawName === 'string') {
        const trimmed = rawName.trim();
        if (trimmed) labels.push(trimmed);
      }
    }

    return Array.from(new Set(labels));
  }

  async compareCommits(
    base: string,
    head: string
  ): Promise<{ commits: CommitDetails[]; status?: string; totalCommits?: number; files: string[]; filesTruncated: boolean }> {
    const perPage = 100;
    let page = 1;
    let status: string | undefined;
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
      });

      if (status === undefined && typeof data?.status === 'string') {
        status = data.status;
      }
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
      ...(status !== undefined && { status }),
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
      owner,
      repo,
    };
  }
}
