import type { CommitInfo, Config, LinkedItem, Reference, ReleaseContext } from './types';
import { extractReferences, referenceKey, summarizeReferences } from './references';
import type { CommitDetails, IssueOrPullDetails } from './github';
import { GitHubClient } from './github';

type QueueEntry = {
  ref: Reference;
  depth: number;
  source: string;
};

const MARKDOWN_COMMENT = /<!--[\s\S]*?-->/g;
const CO_AUTHORED_BY = /^\s*Co-authored-by:.*(?:\r?\n)?/gim;

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stripMarkdownComments(text: string): string {
  if (!text) return text;
  return text.replace(MARKDOWN_COMMENT, '');
}

function stripCoAuthoredBy(text: string): string {
  if (!text) return text;
  return text.replace(CO_AUTHORED_BY, '');
}

function sanitizeCommitMessage(message: string): string {
  return stripCoAuthoredBy(stripMarkdownComments(message));
}

function sanitizeLinkedText(text: string): string {
  return stripMarkdownComments(text);
}

function toCommitInfo(commit: CommitDetails, references: Reference[], message: string): CommitInfo {
  return {
    sha: commit.sha,
    message,
    url: commit.url,
    author: commit.author,
    date: commit.date,
    references: summarizeReferences(references),
  };
}

function toLinkedCommit(
  commit: CommitDetails,
  owner: string,
  repo: string,
  source: string,
  message: string
): LinkedItem {
  return {
    type: 'commit',
    owner,
    repo,
    id: commit.sha,
    message,
    url: commit.url,
    referencedBy: [source],
  };
}

function toLinkedIssue(details: IssueOrPullDetails, source: string, title: string, body: string): LinkedItem {
  return {
    type: details.type === 'pull' ? 'pull' : 'issue',
    owner: details.owner,
    repo: details.repo,
    id: String(details.number),
    title,
    body,
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

function truncateText(text: string, maxLength: number): string {
  if (maxLength <= 0 || text.length <= maxLength) return text;
  if (maxLength <= 3) return text.slice(0, maxLength);
  return `${text.slice(0, maxLength - 3).trimEnd()}...`;
}

function buildTitleBody(title?: string, body?: string): { title?: string; body?: string } {
  const result: { title?: string; body?: string } = {};
  if (typeof title === 'string') result.title = title;
  if (typeof body === 'string') result.body = body;
  return result;
}

function applyTitleBodyLimit(
  title: string | undefined,
  body: string | undefined,
  maxLength: number
): { title?: string; body?: string } {
  if (maxLength <= 0) {
    return buildTitleBody(title, body);
  }
  const hasTitle = typeof title === 'string' && title.length > 0;
  const hasBody = typeof body === 'string' && body.length > 0;
  const safeTitle = title || '';
  const safeBody = body || '';
  const joiner = hasTitle && hasBody ? '\n\n' : '';
  const combined = `${safeTitle}${joiner}${safeBody}`;
  if (combined.length <= maxLength) {
    return buildTitleBody(hasTitle ? safeTitle : undefined, hasBody ? safeBody : undefined);
  }

  if (!hasTitle) {
    const trimmedBody = hasBody ? truncateText(safeBody, maxLength) : undefined;
    return buildTitleBody(undefined, trimmedBody && trimmedBody.length ? trimmedBody : undefined);
  }

  if (safeTitle.length >= maxLength) {
    return buildTitleBody(truncateText(safeTitle, maxLength), undefined);
  }

  const remaining = Math.max(0, maxLength - safeTitle.length - (hasBody ? joiner.length : 0));
  const trimmedBody = hasBody && remaining > 0 ? truncateText(safeBody, remaining) : undefined;
  return buildTitleBody(safeTitle, trimmedBody && trimmedBody.length ? trimmedBody : undefined);
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
    const cleanedMessage = sanitizeCommitMessage(commit.message);
    const refs = extractReferences(cleanedMessage, cfg.owner, cfg.repo).map(ref =>
      normalizeCommitReference(ref, knownCommits)
    );
    const commitInfo = toCommitInfo(commit, refs, cleanedMessage);
    commitEntries.push(commitInfo);
    const source = `commit:${commitInfo.sha.slice(0, 7)}`;
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
        const cleanedMessage = sanitizeCommitMessage(commitDetails.message);
        const linkedCommit = toLinkedCommit(commitDetails, normalizedRef.owner, normalizedRef.repo, item.source, cleanedMessage);
        const refs = extractReferences(cleanedMessage, normalizedRef.owner, normalizedRef.repo)
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
        const cleanedTitle = sanitizeLinkedText(details.title || '');
        const cleanedBody = sanitizeLinkedText(details.body || '');
        const linkedIssue = toLinkedIssue(details, item.source, cleanedTitle, cleanedBody);
        const refs = extractReferences(`${cleanedTitle}\n\n${cleanedBody}`, normalizedRef.owner, normalizedRef.repo)
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

  const maxItemLength = cfg.maxItemLength;

  for (const commitInfo of commitEntries) {
    commitInfo.message = truncateText(commitInfo.message, maxItemLength);
  }

  const linkedItemsList: LinkedItem[] = Array.from(linkedItems.values()).map(item => {
    const trimmed: LinkedItem = { ...item };
    if (trimmed.message) {
      trimmed.message = truncateText(trimmed.message, maxItemLength);
    }
    if (trimmed.title || trimmed.body) {
      const limited = applyTitleBodyLimit(trimmed.title, trimmed.body, maxItemLength);
      if (typeof limited.title === 'string') {
        trimmed.title = limited.title;
      } else {
        delete trimmed.title;
      }
      if (typeof limited.body === 'string') {
        trimmed.body = limited.body;
      } else {
        delete trimmed.body;
      }
    }
    return trimmed;
  });

  return {
    generatedAt: new Date().toISOString(),
    inputs: {
      baseCommit: cfg.baseCommit,
      headCommit: cfg.headCommit,
      branch: cfg.branch,
      promptUrl: cfg.promptUrl,
      model: cfg.model,
      temperature: cfg.temperature,
      maxLinkedItems: cfg.maxLinkedItems,
      maxReferenceDepth: cfg.maxReferenceDepth,
      maxItemLength: cfg.maxItemLength,
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
