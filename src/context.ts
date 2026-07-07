import * as core from '@actions/core';
import type { CommitInfo, Config, LinkedItem, Reference, ReleaseContext } from './types';
import { extractReferences, referenceKey, summarizeReferences } from './references';
import type { CommitDetails, IssueOrPullDetails } from './github';
import { GitHubClient } from './github';

type QueueEntry = {
  ref: Reference;
  depth: number;
  source: string;
  rootCommitSha: string;
};

const MARKDOWN_COMMENT = /<!--[\s\S]*?-->/g;

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stripMarkdownComments(text: string): string {
  if (!text) return text;
  return text.replace(MARKDOWN_COMMENT, '');
}

function sanitizeCommitMessage(message: string): string {
  return stripMarkdownComments(message);
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
    labels: details.labels,
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

function applyItemTextLimit(
  title: string | undefined,
  body: string | undefined,
  maxLength: number
): { title?: string; body?: string } {
  const trimmedTitle = typeof title === 'string' ? truncateText(title, maxLength) : undefined;
  const trimmedBody = typeof body === 'string' ? truncateText(body, maxLength) : undefined;
  return buildTitleBody(trimmedTitle, trimmedBody);
}

const REFERENCE_FETCH_CONCURRENCY = 8;

type PendingFetch = { ref: Reference; key: string };
type FetchOutcome = { key: string; commitDetails?: CommitDetails; details?: IssueOrPullDetails; error?: unknown };

function addSource(item: LinkedItem, source: string): void {
  if (!item.referencedBy.includes(source)) item.referencedBy.push(source);
}

// Run fn over items with at most `limit` in flight at once, preserving input order in the returned results.
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!);
    }
  };
  const workers = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return results;
}

export async function buildReleaseContext(cfg: Config, gh: GitHubClient): Promise<ReleaseContext> {
  const { commits: compareCommits, status, totalCommits, files, filesTruncated, commitsTruncated } = await gh.compareCommits(
    cfg.baseCommit,
    cfg.headCommit
  );
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
      queue.push({ ref, depth: 1, source, rootCommitSha: commitInfo.sha });
    }
  }

  const linkedItems = new Map<string, LinkedItem>();
  const linkedItemCountsByRoot = new Map<string, number>();

  // Resolve references breadth-first, one depth level per wave.
  // Each wave fetches its unique references concurrently, then replays the resolution in frontier order so dedup, the per-root max-linked-items cap, depth handling, and referencedBy are identical to a sequential walk — only the network round-trips are parallelized.
  let frontier: QueueEntry[] = queue;
  let depth = 1;
  while (frontier.length > 0 && depth <= cfg.maxReferenceDepth) {
    // Phase 1: fetch each unique unresolved reference in this level once, concurrently. Roots already at the cap from a prior level are skipped here (that count is final) to avoid pointless fetches; the within-level cap is still enforced in Phase 2.
    const toFetch: PendingFetch[] = [];
    const seenFetchKeys = new Set<string>();
    for (const item of frontier) {
      if (cfg.maxLinkedItems > 0 && (linkedItemCountsByRoot.get(item.rootCommitSha) ?? 0) >= cfg.maxLinkedItems) continue;
      const ref = normalizeCommitReference(item.ref, knownCommits);
      const key = referenceKey(ref);
      if (linkedItems.has(key)) continue;
      if (ref.type === 'commit' && knownCommits.has(ref.id.toLowerCase())) continue;
      if (seenFetchKeys.has(key)) continue;
      seenFetchKeys.add(key);
      toFetch.push({ ref, key });
    }

    const outcomeByKey = new Map<string, FetchOutcome>();
    const outcomes = await mapWithConcurrency<PendingFetch, FetchOutcome>(toFetch, REFERENCE_FETCH_CONCURRENCY, async ({ ref, key }) => {
      try {
        if (ref.type === 'commit') {
          return { key, commitDetails: await gh.getCommit(ref.owner, ref.repo, ref.id) };
        }
        return { key, details: await gh.getIssueOrPullRequest(ref.owner, ref.repo, Number(ref.id)) };
      } catch (error) {
        return { key, error };
      }
    });
    for (const outcome of outcomes) outcomeByKey.set(outcome.key, outcome);

    // Phase 2: replay resolution in frontier order using the pre-fetched outcomes. This mirrors the sequential walk exactly; the per-root cap is counted only on a genuine new addition.
    const nextFrontier: QueueEntry[] = [];
    for (const item of frontier) {
      const ref = normalizeCommitReference(item.ref, knownCommits);
      const key = referenceKey(ref);
      const existing = linkedItems.get(key);
      if (existing) {
        addSource(existing, item.source);
        continue;
      }
      if (ref.type === 'commit' && knownCommits.has(ref.id.toLowerCase())) continue;
      const rootCount = linkedItemCountsByRoot.get(item.rootCommitSha) ?? 0;
      if (cfg.maxLinkedItems > 0 && rootCount >= cfg.maxLinkedItems) continue;
      const outcome = outcomeByKey.get(key);
      if (!outcome || outcome.error) {
        if (outcome?.error) core.warning(`Failed to resolve reference ${key}: ${getErrorMessage(outcome.error)}`);
        continue;
      }

      if (outcome.commitDetails) {
        const commitDetails = outcome.commitDetails;
        const fullSha = commitDetails.sha.toLowerCase();
        const fullKey = referenceKey({ ...ref, id: fullSha });
        const existingFull = linkedItems.get(fullKey);
        if (existingFull) {
          addSource(existingFull, item.source);
          continue;
        }
        if (knownCommits.has(fullSha)) continue;
        knownCommits.add(fullSha);
        const cleanedMessage = sanitizeCommitMessage(commitDetails.message);
        const linkedCommit = toLinkedCommit(commitDetails, ref.owner, ref.repo, item.source, cleanedMessage);
        const refs = extractReferences(cleanedMessage, ref.owner, ref.repo).map(r => normalizeCommitReference(r, knownCommits));
        linkedCommit.references = summarizeReferences(refs);
        linkedItems.set(fullKey, linkedCommit);
        linkedItemCountsByRoot.set(item.rootCommitSha, rootCount + 1);
        if (depth < cfg.maxReferenceDepth) {
          const source = formatSource({ ...ref, id: commitDetails.sha });
          for (const r of refs) nextFrontier.push({ ref: r, depth: depth + 1, source, rootCommitSha: item.rootCommitSha });
        }
        continue;
      }

      if (outcome.details) {
        const details = outcome.details;
        const resolvedRef: Reference = { type: details.type, owner: details.owner, repo: details.repo, id: String(details.number) };
        const resolvedKey = referenceKey(resolvedRef);
        const existingResolved = linkedItems.get(resolvedKey);
        if (existingResolved) {
          addSource(existingResolved, item.source);
          continue;
        }
        const cleanedTitle = sanitizeLinkedText(details.title || '');
        const cleanedBody = sanitizeLinkedText(details.body || '');
        const linkedIssue = toLinkedIssue(details, item.source, cleanedTitle, cleanedBody);
        const refs = extractReferences(`${cleanedTitle}\n\n${cleanedBody}`, ref.owner, ref.repo).map(r => normalizeCommitReference(r, knownCommits));
        linkedIssue.references = summarizeReferences(refs);
        linkedItems.set(resolvedKey, linkedIssue);
        linkedItemCountsByRoot.set(item.rootCommitSha, rootCount + 1);
        if (depth < cfg.maxReferenceDepth) {
          const source = formatSource({ type: linkedIssue.type, owner: ref.owner, repo: ref.repo, id: linkedIssue.id });
          for (const r of refs) nextFrontier.push({ ref: r, depth: depth + 1, source, rootCommitSha: item.rootCommitSha });
        }
        continue;
      }
    }

    frontier = nextFrontier;
    depth++;
  }

  // Authoritative base-inclusive commit count for the range. compareCommits' total_commits is base-exclusive, so add one for the base commit itself.
  const authoritativeTotal =
    cfg.baseCommit === cfg.headCommit
      ? 1
      : (typeof totalCommits === 'number' ? totalCommits : compareCommits.length) + 1;
  const processedCommits = commitEntries.length;

  // A release-notes tool must never publish an incomplete changelog.
  // GitHub's compare API caps at 250 commits; when the full range can't be verifiably recovered (commitsTruncated reflects whether the >250 recovery actually reached the merge-base), fail instead of generating notes over a partial set.
  if (commitsTruncated || processedCommits < authoritativeTotal) {
    throw new Error(
      `Commit range ${cfg.baseCommit}..${cfg.headCommit} is incomplete: recovered ${processedCommits} of ${authoritativeTotal} commit(s). GitHub's compare API caps at 250 commits and the full range could not be verifiably recovered (this can happen with non-linear history). Aborting so incomplete release notes are not published.`
    );
  }

  // The changed-file list is secondary context (notes are driven by commits/PRs), so a capped list is a non-fatal warning rather than a hard failure.
  if (filesTruncated) {
    core.warning(
      `Changed-file list hit GitHub's 300-file compare cap; the release context includes only a partial file list. Commit and pull-request content is complete.`
    );
  }

  const range: ReleaseContext['range'] = {
    base: cfg.baseCommit,
    head: cfg.headCommit,
    totalCommits: authoritativeTotal,
    changedFiles: files,
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
      const limited = applyItemTextLimit(trimmed.title, trimmed.body, maxItemLength);
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
