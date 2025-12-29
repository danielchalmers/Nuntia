export type Config = {
  owner: string;
  repo: string;
  branch: string;
  baseCommit: string;
  headCommit: string;
  token: string;
  geminiApiKey: string;
  promptUrl: string;
  model: string;
  temperature: number;
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
  referencedBy: string[];
  references?: ReferenceSummary;
};

export type ReleaseContext = {
  generatedAt: string;
  inputs: {
    baseCommit: string;
    headCommit: string;
    branch: string;
    promptUrl: string;
    model: string;
    temperature: number;
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
  };
  commits: CommitInfo[];
  linkedItems: LinkedItem[];
};
