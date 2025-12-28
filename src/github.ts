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
    const author = data?.commit?.author?.name || data?.author?.login || 'unknown';
    const date = data?.commit?.author?.date || data?.commit?.committer?.date || '';
    return {
      sha: data?.sha || '',
      message,
      url: data?.html_url || '',
      author,
      date,
    };
  }

  async compareCommits(base: string, head: string): Promise<{ commits: CommitDetails[]; status?: string; totalCommits?: number }> {
    this.incrementApiCalls();
    const { data } = await this.octokit.rest.repos.compareCommits({
      owner: this.owner,
      repo: this.repo,
      base,
      head,
      per_page: 100,
    });

    return {
      commits: (data?.commits || []).map((commit: any) => this.mapCommit(commit)),
      status: data?.status,
      totalCommits: data?.total_commits,
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
      type: data.pull_request ? 'pull' : 'issue',
      owner,
      repo,
    };
  }
}
