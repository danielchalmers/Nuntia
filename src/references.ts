import type { Reference, ReferenceSummary, ReferenceType } from './types';

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

// These patterns differ only in what they match and the reference type they imply; they always resolve against the default repo.
const DEFAULT_REPO_PATTERNS: ReadonlyArray<readonly [RegExp, ReferenceType]> = [
  [MERGE_PULL, 'pull'],
  [EXPLICIT_PULL, 'pull'],
  [SHORT_ISSUE, 'issue'],
];

/**
 * Run `onMatch` for every match of a global pattern.
 * lastIndex is reset first so a module-level pattern reused across calls always scans from the start.
 */
function eachMatch(pattern: RegExp, subject: string, onMatch: (match: RegExpExecArray) => void): void {
  pattern.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(subject)) !== null) onMatch(match);
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

  eachMatch(ISSUE_URL, text, ([, owner, repo, kind, number]) => {
    if (!owner || !repo || !number || !kind) return;
    addRef({ type: kind === 'pull' ? 'pull' : 'issue', owner, repo, id: number });
  });

  eachMatch(COMMIT_URL, text, ([, owner, repo, sha]) => {
    if (!owner || !repo || !sha) return;
    addRef({ type: 'commit', owner, repo, id: normalizeSha(sha) });
  });

  eachMatch(CROSS_REPO_ISSUE, text, ([, owner, repo, number]) => {
    if (!owner || !repo || !number) return;
    addRef({ type: 'issue', owner, repo, id: number });
  });

  for (const [pattern, type] of DEFAULT_REPO_PATTERNS) {
    eachMatch(pattern, text, ([, number]) => {
      if (!number) return;
      addRef({ type, owner: defaultOwner, repo: defaultRepo, id: number });
    });
  }

  // Commit URLs are blanked out first so the SHAs inside them aren't matched again here as bare hex runs.
  eachMatch(COMMIT_SHA, text.replace(COMMIT_URL, ' '), match => {
    let sha = normalizeSha(match[0]);
    if (!/[a-f]/i.test(sha)) return;
    // A bare short hex run is only trusted when it resolves to a commit already in the release range.
    // Anything else (lockfile hashes, "deadbeef", etc.) is noise that would otherwise trigger a 404 lookup.
    // Full 40-char SHAs are unambiguous and kept.
    if (sha.length < 40) {
      const resolved = resolveKnownSha(sha, knownCommits);
      if (!resolved) return;
      sha = resolved;
    }
    addRef({ type: 'commit', owner: defaultOwner, repo: defaultRepo, id: sha });
  });

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
