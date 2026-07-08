import * as core from '@actions/core';
import * as github from '@actions/github';
import { throttling } from '@octokit/plugin-throttling';

export type CommitDetails = {
  sha: string;
  message: string;
  url: string;
  author: string;
  date: string;
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

export type ReleaseSummary = {
  id: number;
  tagName: string;
  targetCommitish: string;
};

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

  getApiCallCount(): number {
    return this.apiCallCount;
  }

  private incrementApiCalls(): void {
    this.apiCallCount++;
  }

  private mapCommit(data: any): CommitDetails {
    const message = data?.commit?.message || '';
    const login = data?.author?.login || data?.committer?.login || '';
    const author = login ? (login.startsWith('@') ? login : `@${login}`) : (data?.commit?.author?.name || data?.commit?.committer?.name || 'unknown');
    const date = data?.commit?.author?.date || data?.commit?.committer?.date || '';
    return {
      sha: data?.sha || '',
      message,
      url: data?.html_url || '',
      author,
      date,
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
  ): Promise<{ commits: CommitDetails[]; status?: string; totalCommits?: number; files: string[]; filesTruncated: boolean; commitsTruncated: boolean }> {
    const perPage = 100;
    let page = 1;
    let status: string | undefined;
    let totalCommits: number | undefined;
    let mergeBaseSha: string | undefined;
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
      // total_commits counts commits from the merge-base to head, so the merge-base sha is the correct stop point when recovering the range past the 250 cap.
      if (mergeBaseSha === undefined) {
        const mb = (data as any)?.merge_base_commit?.sha ?? (data as any)?.base_commit?.sha;
        if (typeof mb === 'string') mergeBaseSha = mb;
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

      const reachedEndOfPage = pageCommits.length < perPage;
      const reachedExpectedTotal = typeof totalCommits === 'number' && commits.length >= totalCommits;
      const madeNoProgress = commits.length === initialCount;
      if (reachedEndOfPage || reachedExpectedTotal || madeNoProgress) break;

      page++;
    }

    // GitHub's compare endpoint hard-caps at 250 commits regardless of pagination.
    // When the range is larger, recover the full merge-base..head set via the (uncapped) list-commits endpoint so large releases aren't silently truncated.
    let rangeCommits = commits;
    let commitsTruncated = false;
    if (typeof totalCommits === 'number') {
      if (commits.length < totalCommits) {
        let stopSha = mergeBaseSha;
        if (!stopSha) {
          // merge_base_commit is virtually always present; resolve as a last resort.
          try {
            stopSha = (await this.getCommit(this.owner, this.repo, base)).sha;
          } catch {
            stopSha = undefined;
          }
        }
        if (stopSha) {
          const { commits: recovered, reachedBase } = await this.listCommitRange(head, stopSha, totalCommits);
          // Only trust the recovery when the walk actually reached the merge-base AND collected exactly total_commits; otherwise the history is non-linear and the set is an unverified approximation that must be flagged, never silently trusted.
          // Compute this from the raw walk before any trimming.
          commitsTruncated = !(reachedBase && recovered.length === totalCommits);
          // Keep at most the newest total_commits commits (recovered is oldest-first) so an overshoot doesn't report more commits than the range contains.
          rangeCommits =
            recovered.length > totalCommits ? recovered.slice(recovered.length - totalCommits) : recovered;
        } else {
          commitsTruncated = true;
        }
      }
    } else if (commits.length >= 250) {
      // total_commits is missing but we collected a full cap's worth, so the set may be capped without a way to confirm completeness.
      commitsTruncated = true;
    }

    // The compare endpoint also caps the changed-file list at 300 entries.
    const filesTruncated = files.length >= 300;

    const result: {
      commits: CommitDetails[];
      status?: string;
      totalCommits?: number;
      files: string[];
      filesTruncated: boolean;
      commitsTruncated: boolean;
    } = {
      commits: rangeCommits,
      files,
      filesTruncated,
      commitsTruncated,
    };
    if (typeof status === 'string') {
      result.status = status;
    }
    if (typeof totalCommits === 'number') {
      result.totalCommits = totalCommits;
    }
    return result;
  }

  /**
   * List the commits in mergeBase..head (base-exclusive), oldest-first, using the list-commits endpoint which — unlike compare — is not capped at 250.
   * Walks history newest-first from head until it reaches the merge-base commit.
   * `reachedBase` reports whether the walk actually terminated at the merge-base; when false, the returned set stopped on the scan bound and may be incomplete, so callers must treat it as unconfirmed rather than authoritative.
   */
  async listCommitRange(
    head: string,
    baseSha: string,
    expectedTotal?: number
  ): Promise<{ commits: CommitDetails[]; reachedBase: boolean }> {
    const perPage = 100;
    let page = 1;
    const collected: CommitDetails[] = [];
    const seen = new Set<string>();
    const baseLower = baseSha.toLowerCase();
    // Scan a little past the expected count so the merge-base can be observed for a linear range (where it sits at index expectedTotal); bound the walk so a base that is not an ancestor of head can't run away through all of history.
    const scanLimit =
      typeof expectedTotal === 'number' && expectedTotal > 0
        ? expectedTotal + perPage
        : Number.POSITIVE_INFINITY;
    let reachedBase = false;

    while (collected.length < scanLimit) {
      this.incrementApiCalls();
      const { data } = await this.octokit.rest.repos.listCommits({
        owner: this.owner,
        repo: this.repo,
        sha: head,
        per_page: perPage,
        page,
      });
      const pageCommits = Array.isArray(data) ? data : [];
      if (pageCommits.length === 0) break;

      for (const commit of pageCommits) {
        const sha = typeof commit?.sha === 'string' ? commit.sha : '';
        if (sha && sha.toLowerCase() === baseLower) {
          reachedBase = true;
          break;
        }
        if (sha && seen.has(sha)) continue;
        if (sha) seen.add(sha);
        collected.push(this.mapCommit(commit));
        if (collected.length >= scanLimit) break;
      }

      if (reachedBase) break;
      if (pageCommits.length < perPage) break;
      page++;
    }

    // list-commits returns newest-first; compare returns oldest-first, so reverse to keep the rest of the pipeline order-consistent.
    // Trimming an oversized (superset) walk is left to the caller so it can decide completeness from the raw walk before any trim masks a mismatch.
    collected.reverse();
    return { commits: collected, reachedBase };
  }

  /**
   * List every ancestor of `head` (oldest-first), for the first-release case where there is no
   * previous tag to diff against and the intended range is "repo start .. head".
   * `reachedRoot` is false only when the walk hit its safety bound without exhausting history;
   * callers must treat that as an incomplete range and refuse to publish partial notes.
   */
  async listHistory(head: string): Promise<{ commits: CommitDetails[]; reachedRoot: boolean }> {
    const perPage = 100;
    // Safety bound so an enormous first-release history can't run away on API calls/tokens.
    // A larger first release should scope the range with an explicit base-commit instead.
    const maxCommits = 1000;
    let page = 1;
    const collected: CommitDetails[] = [];
    const seen = new Set<string>();
    let reachedRoot = false;

    while (true) {
      this.incrementApiCalls();
      const { data } = await this.octokit.rest.repos.listCommits({
        owner: this.owner,
        repo: this.repo,
        sha: head,
        per_page: perPage,
        page,
      });
      const pageCommits = Array.isArray(data) ? data : [];
      if (pageCommits.length === 0) {
        reachedRoot = true;
        break;
      }

      for (const commit of pageCommits) {
        const sha = typeof commit?.sha === 'string' ? commit.sha : '';
        if (sha && seen.has(sha)) continue;
        if (sha) seen.add(sha);
        collected.push(this.mapCommit(commit));
      }

      if (pageCommits.length < perPage) {
        reachedRoot = true;
        break;
      }
      if (collected.length >= maxCommits) break;
      page++;
    }

    // listCommits returns newest-first; reverse to keep the rest of the pipeline oldest-first.
    collected.reverse();
    return { commits: collected, reachedRoot };
  }

  async getReleaseByTag(tag: string): Promise<ReleaseSummary> {
    this.incrementApiCalls();
    try {
      const { data } = await this.octokit.rest.repos.getReleaseByTag({
        owner: this.owner,
        repo: this.repo,
        tag,
      });
      return { id: data.id, tagName: data.tag_name, targetCommitish: data.target_commitish || '' };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `No published GitHub Release found for tag "${tag}" in ${this.owner}/${this.repo}. Publish the release first, or pass base-commit/head-commit for an arbitrary range. (${message})`
      );
    }
  }

  async getLatestRelease(): Promise<ReleaseSummary> {
    this.incrementApiCalls();
    try {
      const { data } = await this.octokit.rest.repos.getLatestRelease({
        owner: this.owner,
        repo: this.repo,
      });
      return { id: data.id, tagName: data.tag_name, targetCommitish: data.target_commitish || '' };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Could not find a latest published release in ${this.owner}/${this.repo}. Publish a non-draft, non-prerelease release, or pass release-tag / base-commit explicitly. (${message})`
      );
    }
  }

  /**
   * Ask GitHub to generate release notes for `tag`, using its own "previous tag" logic.
   * We do not use the prose; we only read the "**Full Changelog**: .../compare/BASE...HEAD" link
   * it appends to recover the base tag (or ".../commits/TAG" when there is no previous release).
   */
  async generateReleaseNotes(tag: string): Promise<string> {
    this.incrementApiCalls();
    const { data } = await this.octokit.rest.repos.generateReleaseNotes({
      owner: this.owner,
      repo: this.repo,
      tag_name: tag,
    });
    return typeof (data as any)?.body === 'string' ? (data as any).body : '';
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
      state: data.state || 'open',
      labels: this.mapLabels(data),
      type: data.pull_request ? 'pull' : 'issue',
      owner,
      repo,
    };
  }
}
