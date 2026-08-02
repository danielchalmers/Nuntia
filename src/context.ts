import * as core from '@actions/core';
import type { CommitInfo, Config, LinkedItem, Reference, ReferenceType, ReleaseContext, ReleaseInputs } from './types';
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
  return text.replace(MARKDOWN_COMMENT, '');
}

/**
 * Record `source` as another referrer of an item that has already been resolved.
 * Returns true when the item was already known, so the caller can skip resolving it again.
 */
function mergeReferencedBy(linkedItems: Map<string, LinkedItem>, key: string, source: string): boolean {
  const existing = linkedItems.get(key);
  if (!existing) return false;
  if (!existing.referencedBy.includes(source)) {
    existing.referencedBy.push(source);
  }
  return true;
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

function formatSource(type: ReferenceType, id: string): string {
  if (type === 'commit') return `commit:${id.slice(0, 7)}`;
  if (type === 'pull') return `pull:#${id}`;
  return `issue:#${id}`;
}

// A reference that has been fetched and turned into a linked item, ready for the shared bookkeeping tail of the walk.
type ResolvedReference = {
  key: string;
  linked: LinkedItem;
  // The text scanned to find the next depth of references.
  referenceText: string;
  // How this item is labelled when it appears as the referrer of something else.
  sourceLabel: string;
};

async function resolveCommitReference(
  gh: GitHubClient,
  ref: Reference,
  source: string,
  knownCommits: Set<string>
): Promise<ResolvedReference> {
  const details = await gh.getCommit(ref.owner, ref.repo, ref.id);
  // Registering the sha before references are extracted lets short SHAs in this commit's own message resolve against it.
  knownCommits.add(details.sha.toLowerCase());
  const message = stripMarkdownComments(details.message);
  return {
    key: referenceKey({ ...ref, id: details.sha.toLowerCase() }),
    linked: toLinkedCommit(details, ref.owner, ref.repo, source, message),
    referenceText: message,
    sourceLabel: formatSource('commit', details.sha),
  };
}

async function resolveIssueReference(
  gh: GitHubClient,
  ref: Reference,
  source: string
): Promise<ResolvedReference> {
  const details = await gh.getIssueOrPullRequest(ref.owner, ref.repo, Number(ref.id));
  const title = stripMarkdownComments(details.title || '');
  const body = stripMarkdownComments(details.body || '');
  const linked = toLinkedIssue(details, source, title, body);
  return {
    key: referenceKey({ type: details.type, owner: details.owner, repo: details.repo, id: String(details.number) }),
    linked,
    referenceText: `${title}\n\n${body}`,
    sourceLabel: formatSource(linked.type, linked.id),
  };
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

/**
 * Echo back the non-secret inputs the run was resolved to.
 * Field order is significant: it drives the JSON key order in the release context and the run log.
 */
export function releaseInputs(cfg: Config): ReleaseInputs {
  const { baseCommit, headCommit, branch, promptUrl, model, maxLinkedItems, maxReferenceDepth, maxItemLength } = cfg;
  return { baseCommit, headCommit, branch, promptUrl, model, maxLinkedItems, maxReferenceDepth, maxItemLength };
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
    const cleanedMessage = stripMarkdownComments(commit.message);
    const refs = extractReferences(cleanedMessage, cfg.owner, cfg.repo, knownCommits).map(ref =>
      normalizeCommitReference(ref, knownCommits)
    );
    const commitInfo = toCommitInfo(commit, refs, cleanedMessage);
    commitEntries.push(commitInfo);
    const source = formatSource('commit', commitInfo.sha);
    for (const ref of refs) {
      queue.push({ ref, depth: 1, source, rootCommitSha: commitInfo.sha });
    }
  }

  const linkedItems = new Map<string, LinkedItem>();
  const linkedItemCountsByRoot = new Map<string, number>();
  let index = 0;

  while (index < queue.length) {
    const item = queue[index++];
    if (!item) break;
    if (item.depth > cfg.maxReferenceDepth) continue;

    const normalizedRef = normalizeCommitReference(item.ref, knownCommits);
    const key = referenceKey(normalizedRef);
    if (mergeReferencedBy(linkedItems, key, item.source)) continue;

    const linkedCountForRoot = linkedItemCountsByRoot.get(item.rootCommitSha) ?? 0;
    if (cfg.maxLinkedItems > 0 && linkedCountForRoot >= cfg.maxLinkedItems) {
      continue;
    }

    // A commit already inside the range is context we have, so don't spend a lookup re-fetching it.
    if (normalizedRef.type === 'commit' && knownCommits.has(normalizedRef.id.toLowerCase())) continue;

    try {
      const resolved =
        normalizedRef.type === 'commit'
          ? await resolveCommitReference(gh, normalizedRef, item.source, knownCommits)
          : await resolveIssueReference(gh, normalizedRef, item.source);

      // Resolving can canonicalize the reference (a short sha to a full one, an issue number to a pull), so dedupe again on the resolved key.
      if (mergeReferencedBy(linkedItems, resolved.key, item.source)) continue;

      const refs = extractReferences(resolved.referenceText, normalizedRef.owner, normalizedRef.repo, knownCommits)
        .map(ref => normalizeCommitReference(ref, knownCommits));
      resolved.linked.references = summarizeReferences(refs);
      linkedItems.set(resolved.key, resolved.linked);
      linkedItemCountsByRoot.set(item.rootCommitSha, linkedCountForRoot + 1);

      if (item.depth < cfg.maxReferenceDepth) {
        for (const ref of refs) {
          queue.push({ ref, depth: item.depth + 1, source: resolved.sourceLabel, rootCommitSha: item.rootCommitSha });
        }
      }
    } catch (error) {
      console.warn(`⚠️ Failed to resolve reference ${key}: ${getErrorMessage(error)}`);
    }
  }

  // Authoritative base-inclusive commit count for the range.
  // compareCommits' total_commits is base-exclusive, so add one for the base commit itself.
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
    ...(status !== undefined && { status }),
  };

  const maxItemLength = cfg.maxItemLength;

  for (const commitInfo of commitEntries) {
    commitInfo.message = truncateText(commitInfo.message, maxItemLength);
  }

  const linkedItemsList: LinkedItem[] = Array.from(linkedItems.values()).map(item => {
    const trimmed: LinkedItem = { ...item };
    if (typeof trimmed.message === 'string') trimmed.message = truncateText(trimmed.message, maxItemLength);
    if (typeof trimmed.title === 'string') trimmed.title = truncateText(trimmed.title, maxItemLength);
    if (typeof trimmed.body === 'string') trimmed.body = truncateText(trimmed.body, maxItemLength);
    return trimmed;
  });

  return {
    generatedAt: new Date().toISOString(),
    inputs: releaseInputs(cfg),
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
