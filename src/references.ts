import type { Reference, ReferenceSummary } from './types';

const ISSUE_URL = /https?:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/(issues|pull)\/(\d+)/gi;
const COMMIT_URL = /https?:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/commit\/([a-f0-9]{7,40})/gi;
const CROSS_REPO_ISSUE = /\b([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#(\d+)\b/g;
const SHORT_ISSUE = /(?<![A-Za-z0-9_\/])#(\d+)\b/g;
const COMMIT_SHA = /\b[a-f0-9]{7,40}\b/gi;

function normalizeSha(sha: string): string {
  return sha.trim().toLowerCase();
}

export function referenceKey(ref: Reference): string {
  return `${ref.type}:${ref.owner}/${ref.repo}#${ref.id}`;
}

export function extractReferences(text: string, defaultOwner: string, defaultRepo: string): Reference[] {
  const refs: Reference[] = [];
  const seen = new Set<string>();

  const addRef = (ref: Reference) => {
    const key = referenceKey(ref);
    if (seen.has(key)) return;
    seen.add(key);
    refs.push(ref);
  };

  if (!text) return refs;

  let match: RegExpExecArray | null = null;
  ISSUE_URL.lastIndex = 0;
  while ((match = ISSUE_URL.exec(text)) !== null) {
    const [, owner, repo, kind, number] = match;
    if (!owner || !repo || !number || !kind) continue;
    addRef({
      type: kind === 'pull' ? 'pull' : 'issue',
      owner,
      repo,
      id: number,
    });
  }

  COMMIT_URL.lastIndex = 0;
  while ((match = COMMIT_URL.exec(text)) !== null) {
    const [, owner, repo, sha] = match;
    if (!owner || !repo || !sha) continue;
    addRef({
      type: 'commit',
      owner,
      repo,
      id: normalizeSha(sha),
    });
  }

  CROSS_REPO_ISSUE.lastIndex = 0;
  while ((match = CROSS_REPO_ISSUE.exec(text)) !== null) {
    const [, owner, repo, number] = match;
    if (!owner || !repo || !number) continue;
    addRef({
      type: 'issue',
      owner,
      repo,
      id: number,
    });
  }

  SHORT_ISSUE.lastIndex = 0;
  while ((match = SHORT_ISSUE.exec(text)) !== null) {
    const [, number] = match;
    if (!number) continue;
    addRef({
      type: 'issue',
      owner: defaultOwner,
      repo: defaultRepo,
      id: number,
    });
  }

  COMMIT_URL.lastIndex = 0;
  const scrubbedText = text.replace(COMMIT_URL, ' ');
  COMMIT_SHA.lastIndex = 0;
  while ((match = COMMIT_SHA.exec(scrubbedText)) !== null) {
    const sha = normalizeSha(match[0]);
    if (!/[a-f]/i.test(sha)) continue;
    addRef({
      type: 'commit',
      owner: defaultOwner,
      repo: defaultRepo,
      id: sha,
    });
  }

  return refs;
}

export function summarizeReferences(references: Reference[]): ReferenceSummary {
  const issues = new Set<number>();
  const pulls = new Set<number>();
  const commits = new Set<string>();

  for (const ref of references) {
    if (ref.type === 'commit') {
      commits.add(ref.id);
    } else if (ref.type === 'pull') {
      pulls.add(Number(ref.id));
    } else {
      issues.add(Number(ref.id));
    }
  }

  return {
    issues: Array.from(issues),
    pulls: Array.from(pulls),
    commits: Array.from(commits),
  };
}
