import { describe, it, expect, vi } from 'vitest';
import { buildReleaseContext } from '../src/context';
import type { GitHubClient } from '../src/github';
import type { Config } from '../src/types';

const baseConfig: Config = {
  owner: 'acme',
  repo: 'widgets',
  branch: 'main',
  baseCommit: 'a1b2c3d4',
  headCommit: 'a1b2c3d4',
  token: 'token',
  geminiApiKey: 'gemini-key',
  promptUrl: 'https://example.com/prompt.txt',
  model: 'gemini-3-flash-preview',
  temperature: 1,
  maxLinkedItems: 3,
  maxReferenceDepth: 2,
  maxItemLength: 5000,
};

describe('buildReleaseContext', () => {
  it('includes issue labels in linked item metadata', async () => {
    const gh = {
      compareCommits: vi.fn().mockResolvedValue({
        commits: [],
        status: 'identical',
        totalCommits: 0,
        files: ['src/index.ts'],
      }),
      getCommit: vi.fn().mockResolvedValue({
        sha: 'a1b2c3d4e5f6',
        message: 'Fixes #42',
        url: 'https://github.com/acme/widgets/commit/a1b2c3d4e5f6',
        author: '@dev',
        date: '2024-01-01T00:00:00Z',
      }),
      getIssueOrPullRequest: vi.fn().mockResolvedValue({
        number: 42,
        title: 'Patch release race condition',
        body: 'Resolves edge case when sync happens concurrently.',
        url: 'https://github.com/acme/widgets/issues/42',
        state: 'closed',
        labels: ['bug', 'release-note'],
        type: 'issue',
        owner: 'acme',
        repo: 'widgets',
      }),
    } as unknown as GitHubClient;

    const context = await buildReleaseContext(baseConfig, gh);

    expect(context.linkedItems).toHaveLength(1);
    expect(context.range.changedFiles).toEqual(['src/index.ts']);
    expect(context.linkedItems[0]).toMatchObject({
      type: 'issue',
      id: '42',
      labels: ['bug', 'release-note'],
    });
    // Verify that a genuine issue stays classified as an issue (not reclassified as a pull)
    expect(context.commits[0]!.references.issues).toContain(42);
    expect(context.commits[0]!.references.pulls).not.toContain(42);
  });

  it('classifies short-form PR references (#N) under pulls not issues after resolving type', async () => {
    const gh = {
      compareCommits: vi.fn().mockResolvedValue({
        commits: [],
        status: 'identical',
        totalCommits: 0,
        files: [],
      }),
      getCommit: vi.fn().mockResolvedValue({
        sha: 'b2c3d4e5f6a1',
        message: 'Consolidate inputs (#57)',
        url: 'https://github.com/acme/widgets/commit/b2c3d4e5f6a1',
        author: '@dev',
        date: '2026-02-20T04:44:23Z',
      }),
      getIssueOrPullRequest: vi.fn().mockResolvedValue({
        number: 57,
        title: 'Rename action inputs',
        body: 'This PR consolidates and renames the action inputs.',
        url: 'https://github.com/acme/widgets/pull/57',
        state: 'closed',
        labels: [],
        type: 'pull',
        owner: 'acme',
        repo: 'widgets',
      }),
    } as unknown as GitHubClient;

    const context = await buildReleaseContext(baseConfig, gh);

    // The commit's references should classify #57 as a pull, not an issue
    expect(context.commits[0]!.references.pulls).toContain(57);
    expect(context.commits[0]!.references.issues).not.toContain(57);

    // The linked item should be present with correct type and body
    expect(context.linkedItems).toHaveLength(1);
    expect(context.linkedItems[0]).toMatchObject({
      type: 'pull',
      id: '57',
      title: 'Rename action inputs',
      body: 'This PR consolidates and renames the action inputs.',
    });
  });
});
