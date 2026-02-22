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
      listPullRequestsForCommit: vi.fn().mockResolvedValue([]),
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
      listPullRequestsForCommit: vi.fn().mockResolvedValue([]),
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

  it('includes PR body and transitive issue when PR is discovered via listPullRequestsForCommit', async () => {
    const gh = {
      compareCommits: vi.fn().mockResolvedValue({
        commits: [],
        status: 'identical',
        totalCommits: 0,
        files: [],
      }),
      getCommit: vi.fn().mockResolvedValue({
        sha: 'c3d4e5f6a1b2',
        message: 'Merge abc into def',
        url: 'https://github.com/acme/widgets/commit/c3d4e5f6a1b2',
        author: '@copilot',
        date: '2026-02-22T20:00:00Z',
      }),
      getIssueOrPullRequest: vi.fn()
        .mockImplementation((owner: string, repo: string, number: number) => {
          if (number === 3) {
            return Promise.resolve({
              number: 3,
              title: 'Fix type classification',
              body: 'Fixes the type issue.\n\nCloses #4',
              url: 'https://github.com/acme/widgets/pull/3',
              state: 'open',
              labels: [],
              type: 'pull',
              owner,
              repo,
            });
          }
          if (number === 4) {
            return Promise.resolve({
              number: 4,
              title: 'Type misclassification bug',
              body: 'PRs referenced as issues when using short-form syntax.',
              url: 'https://github.com/acme/widgets/issues/4',
              state: 'open',
              labels: ['bug'],
              type: 'issue',
              owner,
              repo,
            });
          }
          return Promise.reject(new Error(`Unexpected issue/PR number: ${number}`));
        }),
      listPullRequestsForCommit: vi.fn().mockResolvedValue([3]),
    } as unknown as GitHubClient;

    const context = await buildReleaseContext({ ...baseConfig, maxLinkedItems: 5 }, gh);

    // PR #3 should be discovered and included via listPullRequestsForCommit
    const pr3 = context.linkedItems.find(item => item.type === 'pull' && item.id === '3');
    expect(pr3).toBeDefined();
    expect(pr3?.title).toBe('Fix type classification');
    expect(pr3?.body).toContain('Closes #4');

    // Issue #4 should be discovered transitively from PR #3's body
    const issue4 = context.linkedItems.find(item => item.type === 'issue' && item.id === '4');
    expect(issue4).toBeDefined();
    expect(issue4?.title).toBe('Type misclassification bug');
    expect(issue4?.body).toContain('PRs referenced as issues');
  });
});
