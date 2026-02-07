import * as github from '@actions/github';

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

export class GitHubClient {
  private octokit;
  private apiCallCount = 0;

  constructor(token: string, private owner: string, private repo: string) {
    this.octokit = github.getOctokit(token);
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

  async compareCommits(base: string, head: string): Promise<{ commits: CommitDetails[]; status?: string; totalCommits?: number }> {
    const perPage = 100;
    let page = 1;
    let status: string | undefined;
    let totalCommits: number | undefined;
    const commits: CommitDetails[] = [];
    const seenShas = new Set<string>();

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
      const initialCount = commits.length;

      for (const commit of pageCommits) {
        const sha = typeof commit?.sha === 'string' ? commit.sha : '';
        if (sha && seenShas.has(sha)) continue;
        if (sha) seenShas.add(sha);
        commits.push(this.mapCommit(commit));
      }

      const reachedEndOfPage = pageCommits.length < perPage;
      const reachedExpectedTotal = typeof totalCommits === 'number' && commits.length >= totalCommits;
      const madeNoProgress = commits.length === initialCount;
      if (reachedEndOfPage || reachedExpectedTotal || madeNoProgress) break;

      page++;
    }

    const result: { commits: CommitDetails[]; status?: string; totalCommits?: number } = { commits };
    if (typeof status === 'string') {
      result.status = status;
    }
    if (typeof totalCommits === 'number') {
      result.totalCommits = totalCommits;
    }
    return result;
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
