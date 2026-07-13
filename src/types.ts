export type Config = {
  owner: string;
  repo: string;
  /** Branch the release targets (the release's target_commitish). */
  branch: string;
  /** Tag of the release that triggered the run; the head of the commit range. */
  releaseTag: string;
  /** Previous release tag, resolved at runtime (exclusive start of the range). Empty until resolved. */
  baseCommit: string;
  headCommit: string;
  token: string;
  geminiApiKey: string;
  promptUrl: string;
  model: string;
  maxLinkedItems: number;
  maxReferenceDepth: number;
  maxItemLength: number;
};

export type ReferenceType = 'issue' | 'pull' | 'commit';

export type Reference = {
  type: ReferenceType;
  owner: string;
  repo: string;
  id: string;
};

export type ReferenceSummary = {
  issues: number[];
  pulls: number[];
  commits: string[];
};

export type CommitInfo = {
  sha: string;
  message: string;
  url: string;
  author: string;
  date: string;
  references: ReferenceSummary;
};

export type LinkedItem = {
  type: ReferenceType;
  owner: string;
  repo: string;
  id: string;
  title?: string;
  body?: string;
  message?: string;
  url?: string;
  state?: string;
  labels?: string[];
  referencedBy: string[];
  references?: ReferenceSummary;
};

export type ReleaseContext = {
  generatedAt: string;
  inputs: {
    releaseTag: string;
    promptUrl: string;
    model: string;
    maxLinkedItems: number;
    maxReferenceDepth: number;
    maxItemLength: number;
  };
  repository: {
    owner: string;
    repo: string;
    branch: string;
  };
  range: {
    base: string;
    head: string;
    status?: string;
    totalCommits: number;
    changedFiles: string[];
  };
  commits: CommitInfo[];
  linkedItems: LinkedItem[];
};
