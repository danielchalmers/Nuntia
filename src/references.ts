import type { Reference, ReferenceSummary } from './types';

const ISSUE_URL = /https?:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/(issues|pull)\/(\d+)/gi;
const COMMIT_URL = /https?:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/commit\/([a-f0-9]{7,40})/gi;
const CROSS_REPO_ISSUE = /\b([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#(\d+)\b/g;
const MERGE_PULL = /\bmerge pull request #(\d+)\b/gi;
const EXPLICIT_PULL = /\b(?:pr|pull request)\s*#(\d+)\b/gi;
const SUBJECT_PULL_SUFFIX = /\(#(\d+)\)\s*$/i;
const SHORT_ISSUE = /(?<![A-Za-z0-9_\/])#(\d+)\b/g;
const COMMIT_SHA = /\b[a-f0-9]{7,40}\b/gi;

function normalizeSha(sha: string): string {
  return sha.trim().toLowerCase();
}

function resolveKnownSha(prefix: string, knownCommits: ReadonlySet<string>): string | undefined {
  for (const sha of knownCommits) {
    if (sha.startsWith(prefix)) return sha;
  }
  return undefined;
}

export function referenceKey(ref: Reference): string {
  return `${ref.type}:${ref.owner}/${ref.repo}#${ref.id}`;
}

export function extractReferences(
  text: string,
  defaultOwner: string,
  defaultRepo: string,
  knownCommits: ReadonlySet<string> = new Set()
): Reference[] {
  const refs: Reference[] = [];
  const seenCommits = new Set<string>();
  const issueOrPullIndex = new Map<string, number>();

  const addRef = (ref: Reference) => {
    if (ref.type === 'commit') {
      const key = referenceKey(ref);
      if (seenCommits.has(key)) return;
      seenCommits.add(key);
      refs.push(ref);
      return;
    }

    const identity = `${ref.owner}/${ref.repo}#${ref.id}`;
    const existingIndex = issueOrPullIndex.get(identity);
    if (typeof existingIndex === 'number') {
      const existing = refs[existingIndex];
      if (!existing || existing.type === 'commit') return;
      if (existing.type === 'pull') return;
      if (ref.type === 'issue') return;
      refs[existingIndex] = ref;
      return;
    }

    issueOrPullIndex.set(identity, refs.length);
    refs.push(ref);
  };

  if (!text) return refs;

  const firstLine = text.split(/\r?\n/, 1)[0]?.trim() || '';
  const subjectPullMatch = firstLine.match(SUBJECT_PULL_SUFFIX);
  if (subjectPullMatch?.[1]) {
    addRef({
      type: 'pull',
      owner: defaultOwner,
      repo: defaultRepo,
      id: subjectPullMatch[1],
    });
  }

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

  MERGE_PULL.lastIndex = 0;
  while ((match = MERGE_PULL.exec(text)) !== null) {
    const number = match[1];
    if (!number) continue;
    addRef({
      type: 'pull',
      owner: defaultOwner,
      repo: defaultRepo,
      id: number,
    });
  }

  EXPLICIT_PULL.lastIndex = 0;
  while ((match = EXPLICIT_PULL.exec(text)) !== null) {
    const number = match[1];
    if (!number) continue;
    addRef({
      type: 'pull',
      owner: defaultOwner,
      repo: defaultRepo,
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
    let sha = normalizeSha(match[0]);
    if (!/[a-f]/i.test(sha)) continue;
    // A bare short hex run is only trusted when it resolves to a commit already in the
    // release range; anything else (lockfile hashes, "deadbeef", etc.) is noise that
    // would otherwise trigger a 404 lookup. Full 40-char SHAs are unambiguous and kept.
    if (sha.length < 40) {
      const resolved = resolveKnownSha(sha, knownCommits);
      if (!resolved) continue;
      sha = resolved;
    }
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
