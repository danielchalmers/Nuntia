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
  maxLinkedItems: number;
  maxReferenceDepth: number;
  maxItemLength: number;
  // Release mode: when set, base/head/branch are resolved from a published GitHub Release
  // instead of being passed as explicit inputs. releaseTag is empty when resolving the latest release.
  releaseMode?: boolean;
  releaseTag?: string;
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
    baseCommit: string;
    headCommit: string;
    branch: string;
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
