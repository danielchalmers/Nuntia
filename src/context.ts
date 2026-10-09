import * as core from '@actions/core';
import type { CommitInfo, Config, LinkedItem, Reference, ReferenceSummary, ReferenceType, ReleaseContext, ReleaseRange } from './types';
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

// How many linked issues, pull requests and commits each commit in the range may pull in.
const MAX_LINKED_ITEMS = 5;
// How far references inside linked items are followed, where 1 is an item a commit links directly.
const MAX_REFERENCE_DEPTH = 2;
// The longest a commit message or a linked item's title or body may be.
const MAX_ITEM_LENGTH = 5000;
// How many GitHub API calls a run may make, the release and compare reads included, before it stops following references.
// GITHUB_TOKEN allows 1,000 requests an hour per repository, and the release's other workflows share them.
const MAX_API_CALLS = 300;
// A context estimated at more tokens than this, at 4 characters a token, is trimmed until it fits.
const MAX_CONTEXT_TOKENS = 150_000;
const CHARS_PER_TOKEN = 4;
// The shorter lengths linked item bodies are cut at in turn, once nothing else is left to trim.
const SHORTER_BODY_LENGTHS = [2500, 1000, 500];

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

function toCommitInfo(commit: CommitDetails, references: ReferenceSummary, message: string): CommitInfo {
  return {
    sha: commit.sha,
    message,
    url: commit.url,
    references,
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

function truncateText(text: string, maxLength = MAX_ITEM_LENGTH): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 3).trimEnd()}...`;
}

// The model receives the context as compact JSON, so that is what gets measured.
function estimateTokens(context: ReleaseContext): number {
  return Math.ceil(JSON.stringify(context).length / CHARS_PER_TOKEN);
}

function formatTokens(tokens: number): string {
  return `about ${Math.round(tokens / 1000)}k tokens`;
}

/**
 * Trim a context that is over MAX_CONTEXT_TOKENS, stopping as soon as it fits.
 * It drops the linked items found through other linked items, then the changed-file list, and then cuts linked item bodies shorter.
 */
function trimContext(context: ReleaseContext, deepItems: ReadonlySet<LinkedItem>): void {
  let tokens = estimateTokens(context);
  if (tokens <= MAX_CONTEXT_TOKENS) return;
  console.log(`The release context is ${formatTokens(tokens)}, over the limit of ${formatTokens(MAX_CONTEXT_TOKENS)}, so it will be trimmed.`);

  const directItems = context.linkedItems.filter(item => !deepItems.has(item));
  if (directItems.length < context.linkedItems.length) {
    const dropped = context.linkedItems.length - directItems.length;
    context.linkedItems = directItems;
    tokens = estimateTokens(context);
    console.log(`Dropped ${dropped} linked item(s) found through other linked items, leaving ${formatTokens(tokens)}.`);
    if (tokens <= MAX_CONTEXT_TOKENS) return;
  }

  if (context.range.changedFiles?.length) {
    delete context.range.changedFiles;
    tokens = estimateTokens(context);
    console.log(`Dropped the changed-file list, leaving ${formatTokens(tokens)}.`);
    if (tokens <= MAX_CONTEXT_TOKENS) return;
  }

  for (const maxLength of SHORTER_BODY_LENGTHS) {
    let cut = 0;
    for (const item of context.linkedItems) {
      if (typeof item.body === 'string' && item.body.length > maxLength) {
        item.body = truncateText(item.body, maxLength);
        cut++;
      }
    }
    if (cut === 0) continue;
    tokens = estimateTokens(context);
    console.log(`Cut the bodies of ${cut} linked item(s) at ${maxLength.toLocaleString('en-US')} characters, leaving ${formatTokens(tokens)}.`);
    if (tokens <= MAX_CONTEXT_TOKENS) return;
  }

  core.warning(`The release context is still ${formatTokens(tokens)} after trimming, so the model may not accept it.`);
}

/** Gather the commits after range.base up to range.head, and the issues, pull requests and commits they reference. */
export async function buildReleaseContext(cfg: Config, releaseRange: ReleaseRange, gh: GitHubClient): Promise<ReleaseContext> {
  const { base, head } = releaseRange;
  const { commits, status, totalCommits, files, filesTruncated } = await gh.compareCommits(base, head);

  const knownCommits = new Set(commits.map(commit => commit.sha.toLowerCase()));
  const commitEntries: CommitInfo[] = [];
  const queue: QueueEntry[] = [];

  for (const commit of commits) {
    const cleanedMessage = stripMarkdownComments(commit.message);
    const refs = extractReferences(cleanedMessage, cfg.owner, cfg.repo, knownCommits).map(ref =>
      normalizeCommitReference(ref, knownCommits)
    );
    const commitInfo = toCommitInfo(commit, summarizeReferences(refs, cfg.owner, cfg.repo), cleanedMessage);
    commitEntries.push(commitInfo);
    const source = formatSource('commit', commitInfo.sha);
    for (const ref of refs) {
      queue.push({ ref, depth: 1, source, rootCommitSha: commitInfo.sha });
    }
  }

  const linkedItems = new Map<string, LinkedItem>();
  const linkedItemCountsByRoot = new Map<string, number>();
  // The linked items found through another linked item, which trimming drops first.
  const deepItems = new Set<LinkedItem>();
  // The references left unfetched once the API call budget ran out.
  const overBudget = new Set<string>();
  let index = 0;

  while (index < queue.length) {
    const item = queue[index++];
    if (!item) break;
    if (item.depth > MAX_REFERENCE_DEPTH) continue;

    const normalizedRef = normalizeCommitReference(item.ref, knownCommits);
    const key = referenceKey(normalizedRef);
    if (mergeReferencedBy(linkedItems, key, item.source)) continue;

    const linkedCountForRoot = linkedItemCountsByRoot.get(item.rootCommitSha) ?? 0;
    if (linkedCountForRoot >= MAX_LINKED_ITEMS) continue;

    // A commit already inside the range is context we have, so don't spend a lookup re-fetching it.
    if (normalizedRef.type === 'commit' && knownCommits.has(normalizedRef.id.toLowerCase())) continue;

    // The queue holds every direct reference before any found inside a linked item, so those deeper references are the first left out when the budget runs out.
    if (gh.getApiCallCount() >= MAX_API_CALLS) {
      overBudget.add(key);
      continue;
    }

    try {
      const resolved =
        normalizedRef.type === 'commit'
          ? await resolveCommitReference(gh, normalizedRef, item.source, knownCommits)
          : await resolveIssueReference(gh, normalizedRef, item.source);

      // Resolving can canonicalize the reference (a short sha to a full one, an issue number to a pull), so dedupe again on the resolved key.
      if (mergeReferencedBy(linkedItems, resolved.key, item.source)) continue;

      const refs = extractReferences(resolved.referenceText, normalizedRef.owner, normalizedRef.repo, knownCommits)
        .map(ref => normalizeCommitReference(ref, knownCommits));
      resolved.linked.references = summarizeReferences(refs, cfg.owner, cfg.repo);
      linkedItems.set(resolved.key, resolved.linked);
      linkedItemCountsByRoot.set(item.rootCommitSha, linkedCountForRoot + 1);
      if (item.depth > 1) deepItems.add(resolved.linked);

      if (item.depth < MAX_REFERENCE_DEPTH) {
        for (const ref of refs) {
          queue.push({ ref, depth: item.depth + 1, source: resolved.sourceLabel, rootCommitSha: item.rootCommitSha });
        }
      }
    } catch (error) {
      console.warn(`⚠️ Failed to resolve reference ${key}: ${getErrorMessage(error)}`);
    }
  }

  if (overBudget.size > 0) {
    console.log(`Stopped following references at ${MAX_API_CALLS} GitHub API calls, leaving out ${overBudget.size} more.`);
  }

  // compareCommits pages until it has total_commits, so fewer commits means GitHub returned only part of the range.
  // A release-notes tool must never publish an incomplete changelog, so fail instead of generating notes over a partial set.
  const authoritativeTotal = typeof totalCommits === 'number' ? totalCommits : commits.length;
  if (commitEntries.length < authoritativeTotal) {
    throw new Error(
      `Commit range ${base}...${head} is incomplete: got ${commitEntries.length} of ${authoritativeTotal} commit(s). Aborting so incomplete release notes are not published.`
    );
  }

  // The changed-file list is secondary context (notes are driven by commits/PRs), so a capped list is a non-fatal warning rather than a hard failure.
  if (filesTruncated) {
    core.warning(
      `Changed-file list hit GitHub's 300-file compare cap; the release context includes only a partial file list. Commit and pull-request content is complete.`
    );
  }

  const range: ReleaseContext['range'] = {
    base,
    head,
    totalCommits: authoritativeTotal,
    changedFiles: files,
    ...(status !== undefined && { status }),
  };

  for (const commitInfo of commitEntries) {
    commitInfo.message = truncateText(commitInfo.message);
  }

  for (const item of linkedItems.values()) {
    if (typeof item.message === 'string') item.message = truncateText(item.message);
    if (typeof item.title === 'string') item.title = truncateText(item.title);
    if (typeof item.body === 'string') item.body = truncateText(item.body);
  }

  const context: ReleaseContext = {
    repository: {
      owner: cfg.owner,
      repo: cfg.repo,
      branch: releaseRange.branch,
    },
    release: releaseRange.release,
    range,
    commits: commitEntries,
    linkedItems: Array.from(linkedItems.values()),
  };
  trimContext(context, deepItems);
  return context;
}
