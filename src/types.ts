import type { ReleaseDetails } from './github';
import type { Endpoint } from './llm/endpoint';

// The event that started the run.
export type Trigger = {
  eventName: string;
  // The full ref the run is on, such as refs/heads/main or refs/tags/v1.2.0.
  ref: string;
  sha: string;
  // The pull request's branch, set only on pull request events.
  headRef: string;
  // The release from a release event's payload.
  release?: ReleaseDetails;
};

export type Config = {
  owner: string;
  repo: string;
  token: string;
  promptUrl: string;
  model: string;
  endpoint: Endpoint;
  trigger: Trigger;
};

// The release the notes are for, as the model sees it.
export type ReleaseInfo = {
  tag: string;
  previousTag: string;
  name: string | null;
  prerelease: boolean;
  // Whether the release body already has GitHub's generated list of changes, so the notes don't need to list them again.
  hasChangeList: boolean;
};

// The commits a run covers: those after base, up to and including head.
export type ReleaseRange = {
  base: string;
  head: string;
  // The branch the release was cut from, or the branch a preview runs on.
  branch: string;
  // Null for a preview of the next release.
  release: ReleaseInfo | null;
};

export type ReferenceType = 'issue' | 'pull' | 'commit';

export type Reference = {
  type: ReferenceType;
  owner: string;
  repo: string;
  id: string;
};

// Bare numbers and SHAs refer to the release repository; other repositories are qualified as `owner/repo#123` or `owner/repo@sha`.
export type ReferenceSummary = {
  issues: Array<number | string>;
  pulls: Array<number | string>;
  commits: string[];
};

export type CommitInfo = {
  sha: string;
  message: string;
  url: string;
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
  repository: {
    owner: string;
    repo: string;
    branch: string;
  };
  release: ReleaseInfo | null;
  range: {
    base: string;
    head: string;
    status?: string;
    totalCommits: number;
    // Left out when the context is trimmed to fit.
    changedFiles?: string[];
  };
  commits: CommitInfo[];
  linkedItems: LinkedItem[];
};
