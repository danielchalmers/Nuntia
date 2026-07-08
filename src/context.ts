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

export async function buildReleaseContext(cfg: Config, gh: GitHubClient): Promise<ReleaseContext> {
  // An empty base means "first release": there is no previous tag to diff against, so the range is
  // the whole history up to head. Every other path resolves the range via the compare API.
  const isFirstRelease = cfg.baseCommit.trim() === '';

  let commits: CommitDetails[] = [];
  let authoritativeTotal: number;
  let commitsTruncated = false;
  let filesTruncated = false;
  let files: string[] = [];
  let status: string | undefined;

  if (isFirstRelease) {
    const history = await gh.listHistory(cfg.headCommit);
    if (!history.reachedRoot) {
      throw new Error(
        `First-release history for ${cfg.headCommit} exceeded the walk bound before reaching the repository root, so the full range could not be verifiably recovered. Pass base-commit explicitly to scope the range.`
      );
    }
    commits = history.commits;
    authoritativeTotal = commits.length;
    status = 'first-release';
  } else {
    const compared = await gh.compareCommits(cfg.baseCommit, cfg.headCommit);
    status = compared.status;
    files = compared.files;
    filesTruncated = compared.filesTruncated;
    commitsTruncated = compared.commitsTruncated;

    // Guard against a reversed or empty range before generating anything. Once base/head are
    // auto-inferred from a release, a bad inference would otherwise silently yield base-only notes.
    if (cfg.baseCommit !== cfg.headCommit) {
      if (status === 'behind') {
        throw new Error(
          `Commit range ${cfg.baseCommit}..${cfg.headCommit} is 'behind': the head is an ancestor of the base, so the two look reversed. Refusing to generate notes over a backward range.`
        );
      }
      if (status !== 'identical' && compared.totalCommits === 0) {
        throw new Error(
          `Commit range ${cfg.baseCommit}..${cfg.headCommit} contains no commits (compare status '${status ?? 'unknown'}'). Check that base and head are in the right order.`
        );
      }
      if (status === 'diverged') {
        core.warning(
          `Commit range ${cfg.baseCommit}..${cfg.headCommit} is 'diverged': the base is not an ancestor of the head, so the base commit may sit off the range. Verify the generated notes.`
        );
      }
    }

    if (cfg.baseCommit === cfg.headCommit) {
      commits = [await gh.getCommit(cfg.owner, cfg.repo, cfg.baseCommit)];
      authoritativeTotal = 1;
    } else {
      const baseCommit = await gh.getCommit(cfg.owner, cfg.repo, cfg.baseCommit);
      commits = [baseCommit, ...compared.commits];
      // compare's total_commits is base-exclusive, so add one for the base commit itself.
      authoritativeTotal =
        (typeof compared.totalCommits === 'number' ? compared.totalCommits : compared.commits.length) + 1;
    }
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
  let index = 0;

  while (index < queue.length) {
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

    const linkedCountForRoot = linkedItemCountsByRoot.get(item.rootCommitSha) ?? 0;
    if (cfg.maxLinkedItems > 0 && linkedCountForRoot >= cfg.maxLinkedItems) {
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
        linkedItemCountsByRoot.set(item.rootCommitSha, linkedCountForRoot + 1);
        if (item.depth < cfg.maxReferenceDepth) {
          const source = formatSource({ ...fullRef, id: commitDetails.sha });
          for (const ref of refs) {
            queue.push({ ref, depth: item.depth + 1, source, rootCommitSha: item.rootCommitSha });
          }
        }
      } else {
        const details = await gh.getIssueOrPullRequest(normalizedRef.owner, normalizedRef.repo, Number(normalizedRef.id));
        const resolvedRef: Reference = {
          type: details.type,
          owner: details.owner,
          repo: details.repo,
          id: String(details.number),
        };
        const resolvedKey = referenceKey(resolvedRef);
        if (linkedItems.has(resolvedKey)) {
          const existing = linkedItems.get(resolvedKey);
          if (existing && !existing.referencedBy.includes(item.source)) {
            existing.referencedBy.push(item.source);
          }
          continue;
        }
        const cleanedTitle = sanitizeLinkedText(details.title || '');
        const cleanedBody = sanitizeLinkedText(details.body || '');
        const linkedIssue = toLinkedIssue(details, item.source, cleanedTitle, cleanedBody);
        const refs = extractReferences(`${cleanedTitle}\n\n${cleanedBody}`, normalizedRef.owner, normalizedRef.repo)
          .map(ref => normalizeCommitReference(ref, knownCommits));
        linkedIssue.references = summarizeReferences(refs);
        linkedItems.set(resolvedKey, linkedIssue);
        linkedItemCountsByRoot.set(item.rootCommitSha, linkedCountForRoot + 1);
        if (item.depth < cfg.maxReferenceDepth) {
          const source = formatSource({
            type: linkedIssue.type,
            owner: normalizedRef.owner,
            repo: normalizedRef.repo,
            id: linkedIssue.id,
          });
          for (const ref of refs) {
            queue.push({ ref, depth: item.depth + 1, source, rootCommitSha: item.rootCommitSha });
          }
        }
      }
    } catch (error) {
      console.warn(`⚠️ Failed to resolve reference ${key}: ${getErrorMessage(error)}`);
    }
  }

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
