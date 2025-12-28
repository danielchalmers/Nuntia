import type { CommitInfo, Config, LinkedItem, Reference, ReleaseContext } from './types';
import { extractReferences, referenceKey, summarizeReferences } from './references';
import type { CommitDetails, IssueOrPullDetails } from './github';
import { GitHubClient } from './github';

type QueueEntry = {
  ref: Reference;
  depth: number;
  source: string;
};

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toCommitInfo(commit: CommitDetails, references: Reference[]): CommitInfo {
  return {
    sha: commit.sha,
    shortSha: commit.sha.slice(0, 7),
    message: commit.message,
    url: commit.url,
    author: commit.author,
    date: commit.date,
    references: summarizeReferences(references),
  };
}

function toLinkedCommit(commit: CommitDetails, owner: string, repo: string, source: string): LinkedItem {
  return {
    type: 'commit',
    owner,
    repo,
    id: commit.sha,
    message: commit.message,
    url: commit.url,
    referencedBy: [source],
  };
}

function toLinkedIssue(details: IssueOrPullDetails, source: string): LinkedItem {
  return {
    type: details.type === 'pull' ? 'pull' : 'issue',
    owner: details.owner,
    repo: details.repo,
    id: String(details.number),
    title: details.title,
    body: details.body,
    url: details.url,
    state: details.state,
    referencedBy: [source],
  };
}

function formatSource(ref: Reference): string {
  if (ref.type === 'commit') return `commit:${ref.id.slice(0, 7)}`;
  if (ref.type === 'pull') return `pull:#${ref.id}`;
  return `issue:#${ref.id}`;
}

function normalizeCommitReference(ref: Reference, knownCommits: Set<string>): Reference {
  if (ref.type !== 'commit') return ref;
  const normalized = ref.id.toLowerCase();
  for (const sha of knownCommits) {
    if (sha.startsWith(normalized)) {
      return { ...ref, id: sha };
    }
  }
  return { ...ref, id: normalized };
}

const MAX_COMMIT_MESSAGE_LENGTH = 300;
const MAX_LINKED_ITEM_TITLE_LENGTH = 200;
const MAX_LINKED_ITEM_BODY_LENGTH = 2000;

function truncateText(text: string, maxLength: number): string {
  if (maxLength <= 0 || text.length <= maxLength) return text;
  if (maxLength <= 3) return text.slice(0, maxLength);
  return `${text.slice(0, maxLength - 3).trimEnd()}...`;
}

export async function buildReleaseContext(cfg: Config, gh: GitHubClient): Promise<ReleaseContext> {
  const { commits: compareCommits, status, totalCommits } = await gh.compareCommits(cfg.baseCommit, cfg.headCommit);
  let commits: CommitDetails[] = [];

  if (cfg.baseCommit === cfg.headCommit) {
    commits = [await gh.getCommit(cfg.owner, cfg.repo, cfg.baseCommit)];
  } else {
    const baseCommit = await gh.getCommit(cfg.owner, cfg.repo, cfg.baseCommit);
    commits = [baseCommit, ...compareCommits];
  }

  const knownCommits = new Set(commits.map(commit => commit.sha.toLowerCase()));
  const commitEntries: CommitInfo[] = [];
  const queue: QueueEntry[] = [];

  for (const commit of commits) {
    const refs = extractReferences(commit.message, cfg.owner, cfg.repo).map(ref => normalizeCommitReference(ref, knownCommits));
    const commitInfo = toCommitInfo(commit, refs);
    commitEntries.push(commitInfo);
    const source = `commit:${commitInfo.shortSha}`;
    for (const ref of refs) {
      queue.push({ ref, depth: 1, source });
    }
  }

  if (typeof totalCommits === 'number' && totalCommits + 1 > commits.length) {
    console.warn(`⚠️ Compare API returned ${commits.length} commit(s), but total_commits is ${totalCommits}.`);
  }

  const linkedItems = new Map<string, LinkedItem>();
  let index = 0;

  while (index < queue.length) {
    if (cfg.maxLinkedItems > 0 && linkedItems.size >= cfg.maxLinkedItems) break;
    const item = queue[index++];
    if (!item) break;
    if (item.depth > cfg.maxReferenceDepth) continue;

    const normalizedRef = normalizeCommitReference(item.ref, knownCommits);
    const key = referenceKey(normalizedRef);
    if (linkedItems.has(key)) {
      const existing = linkedItems.get(key);
      if (existing && !existing.referencedBy.includes(item.source)) {
        existing.referencedBy.push(item.source);
      }
      continue;
    }

    try {
      if (normalizedRef.type === 'commit') {
        if (knownCommits.has(normalizedRef.id.toLowerCase())) continue;
        const commitDetails = await gh.getCommit(normalizedRef.owner, normalizedRef.repo, normalizedRef.id);
        const fullRef: Reference = {
          ...normalizedRef,
          id: commitDetails.sha.toLowerCase(),
        };
        const fullKey = referenceKey(fullRef);
        if (linkedItems.has(fullKey)) {
          const existing = linkedItems.get(fullKey);
          if (existing && !existing.referencedBy.includes(item.source)) {
            existing.referencedBy.push(item.source);
          }
          continue;
        }
        knownCommits.add(commitDetails.sha.toLowerCase());
        const linkedCommit = toLinkedCommit(commitDetails, normalizedRef.owner, normalizedRef.repo, item.source);
        const refs = extractReferences(commitDetails.message, normalizedRef.owner, normalizedRef.repo)
          .map(ref => normalizeCommitReference(ref, knownCommits));
        linkedCommit.references = summarizeReferences(refs);
        linkedItems.set(fullKey, linkedCommit);
        if (item.depth < cfg.maxReferenceDepth) {
          const source = formatSource({ ...fullRef, id: commitDetails.sha });
          for (const ref of refs) {
            queue.push({ ref, depth: item.depth + 1, source });
          }
        }
      } else {
        const details = await gh.getIssueOrPullRequest(normalizedRef.owner, normalizedRef.repo, Number(normalizedRef.id));
        const linkedIssue = toLinkedIssue(details, item.source);
        const refs = extractReferences(`${details.title}\n\n${details.body}`, normalizedRef.owner, normalizedRef.repo)
          .map(ref => normalizeCommitReference(ref, knownCommits));
        linkedIssue.references = summarizeReferences(refs);
        linkedItems.set(key, linkedIssue);
        if (item.depth < cfg.maxReferenceDepth) {
          const source = formatSource({
            type: linkedIssue.type,
            owner: normalizedRef.owner,
            repo: normalizedRef.repo,
            id: linkedIssue.id,
          });
          for (const ref of refs) {
            queue.push({ ref, depth: item.depth + 1, source });
          }
        }
      }
    } catch (error) {
      console.warn(`⚠️ Failed to resolve reference ${key}: ${getErrorMessage(error)}`);
    }
  }

  const range: ReleaseContext['range'] = {
    base: cfg.baseCommit,
    head: cfg.headCommit,
    totalCommits: commitEntries.length,
  };
  if (status !== undefined) {
    range.status = status;
  }

  for (const commitInfo of commitEntries) {
    commitInfo.message = truncateText(commitInfo.message, MAX_COMMIT_MESSAGE_LENGTH);
  }

  const linkedItemsList: LinkedItem[] = Array.from(linkedItems.values()).map(item => {
    const trimmed: LinkedItem = { ...item };
    if (trimmed.message) {
      trimmed.message = truncateText(trimmed.message, MAX_COMMIT_MESSAGE_LENGTH);
    }
    if (trimmed.title) {
      trimmed.title = truncateText(trimmed.title, MAX_LINKED_ITEM_TITLE_LENGTH);
    }
    if (trimmed.body) {
      trimmed.body = truncateText(trimmed.body, MAX_LINKED_ITEM_BODY_LENGTH);
    }
    return trimmed;
  });

  return {
    generatedAt: new Date().toISOString(),
    inputs: {
      baseCommit: cfg.baseCommit,
      headCommit: cfg.headCommit,
      branch: cfg.branch,
      promptPath: cfg.promptPath,
      model: cfg.model,
      temperature: cfg.temperature,
      maxLinkedItems: cfg.maxLinkedItems,
      maxReferenceDepth: cfg.maxReferenceDepth,
    },
    stats: {
      commitCount: commitEntries.length,
      linkedItemCount: linkedItemsList.length,
    },
    repository: {
      owner: cfg.owner,
      repo: cfg.repo,
      branch: cfg.branch,
    },
    range,
    commits: commitEntries,
    linkedItems: linkedItemsList,
  };
}
