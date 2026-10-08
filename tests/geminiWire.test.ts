import * as fs from 'fs';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'os';
import * as path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config, ReleaseContext } from '../src/types';

// The whole action runs against a local stand-in for the Gemini API, with only GEMINI_API_KEY set and every input at its action.yml default.
// The fixture holds the request @google/genai sent and what the action wrote for the canned response, so a change to either shows up here.
const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'gemini-text-request.json');

type Fixture = {
  inputs: Record<string, string>;
  response: unknown;
  request: { method: string; url: string; headers: Record<string, string>; body: string };
  outputs: Record<string, string>;
  files: Record<string, string>;
};

// The headers that decide what Gemini does with the request; SDK telemetry such as user-agent is left out.
const RECORDED_HEADERS = ['content-type', 'x-goog-api-key', 'x-server-timeout'];
const ARTIFACTS = ['nuntia-release-notes.md', 'nuntia-payload.json', 'nuntia-context.json'];

const mocks = vi.hoisted(() => {
  const summary = { addRaw: vi.fn(), write: vi.fn() };
  return {
    getInput: vi.fn(),
    setOutput: vi.fn(),
    setFailed: vi.fn(),
    setSecret: vi.fn(),
    summary,
    buildReleaseContext: vi.fn(),
    fetchPrompt: vi.fn(),
  };
});

vi.mock('@actions/core', async (importActual) => ({
  ...(await importActual<typeof import('@actions/core')>()),
  getInput: mocks.getInput,
  setOutput: mocks.setOutput,
  setFailed: mocks.setFailed,
  setSecret: mocks.setSecret,
  summary: mocks.summary,
}));
vi.mock('../src/github', () => ({ GitHubClient: class {} }));
vi.mock('../src/context', async (importActual) => ({
  ...(await importActual<typeof import('../src/context')>()),
  buildReleaseContext: mocks.buildReleaseContext,
}));
vi.mock('../src/prompt', async (importActual) => ({
  ...(await importActual<typeof import('../src/prompt')>()),
  fetchPrompt: mocks.fetchPrompt,
}));

const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8')) as Fixture;

// What core.getInput returns when a workflow sets only these inputs: the value given, or the default in action.yml.
function actionDefaults(): Record<string, string> {
  const yml = fs.readFileSync(path.join(__dirname, '..', 'action.yml'), 'utf8').replace(/\r\n/g, '\n');
  const defaults: Record<string, string> = {};
  for (const match of yml.matchAll(/^ {2}([\w-]+):\n(?: {4}.*\n)*? {4}default: "(.*)"$/gm)) {
    defaults[match[1]!] = match[2]!;
  }
  return defaults;
}

const PROMPT = 'Write release notes for "Widgets".\nGroup them under Fixes and Features — keep it short. 🚀\n';

async function context(cfg: Config): Promise<ReleaseContext> {
  const { releaseInputs } = await vi.importActual<typeof import('../src/context')>('../src/context');
  return {
    generatedAt: '2026-01-02T03:04:05.000Z',
    inputs: releaseInputs(cfg),
    repository: { owner: cfg.owner, repo: cfg.repo, branch: cfg.branch },
    range: { base: cfg.baseCommit, head: cfg.headCommit, status: 'ahead', totalCommits: 2, changedFiles: ['src/save.ts', 'docs/café.md'] },
    commits: [
      {
        sha: 'a1b2c3d',
        message: 'Fix crash on save (#7)\n\nThe "Save" button no longer throws — café 🚀',
        url: 'https://github.com/acme/widgets/commit/a1b2c3d',
        author: 'Ada',
        date: '2026-01-01T00:00:00Z',
        references: { issues: [7], pulls: [], commits: [] },
      },
      {
        sha: 'e4f5a6b',
        message: 'Add dark mode',
        url: 'https://github.com/acme/widgets/commit/e4f5a6b',
        author: 'Grace',
        date: '2026-01-01T12:00:00Z',
        references: { issues: [], pulls: ['other/repo#3'], commits: [] },
      },
    ],
    linkedItems: [
      {
        type: 'issue',
        owner: 'acme',
        repo: 'widgets',
        id: '7',
        title: 'Crash on save',
        body: 'Steps:\n1. Click <Save>\n2. See \\ error',
        state: 'closed',
        labels: ['bug'],
        referencedBy: ['a1b2c3d'],
      },
    ],
  };
}

type Recorded = Fixture['request'];

let tempDir: string;
let baseUrl = '';
let requests: Recorded[] = [];

const server = createServer((req: IncomingMessage, res) => {
  const chunks: Buffer[] = [];
  req.on('data', chunk => chunks.push(chunk as Buffer));
  req.on('end', () => {
    const headers: Record<string, string> = {};
    for (const name of RECORDED_HEADERS) {
      const value = req.headers[name];
      if (typeof value === 'string') headers[name] = value;
    }
    requests.push({ method: req.method ?? '', url: req.url ?? '', headers, body: Buffer.concat(chunks).toString('utf8') });
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(fixture.response));
  });
});

beforeAll(async () => {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
});

beforeEach(() => {
  vi.clearAllMocks();
  requests = [];
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nuntia-wire-'));
  vi.spyOn(process, 'cwd').mockReturnValue(tempDir);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.stubEnv('GITHUB_TOKEN', 'test-token');
  vi.stubEnv('GITHUB_REPOSITORY', 'acme/widgets');
  vi.stubEnv('GEMINI_API_KEY', 'test-gemini-key');
  vi.stubEnv('ANTHROPIC_API_KEY', '');
  vi.stubEnv('OPENAI_API_KEY', '');
  vi.stubEnv('OPENAI_BASE_URL', '');
  vi.stubEnv('GOOGLE_GEMINI_BASE_URL', baseUrl);
  vi.stubEnv('GITHUB_STEP_SUMMARY', '');
  vi.stubEnv('NODE_USE_ENV_PROXY', '');
  const inputs = { ...actionDefaults(), ...fixture.inputs };
  mocks.getInput.mockImplementation((name: string) => inputs[name] ?? '');
  mocks.summary.addRaw.mockReturnValue(mocks.summary);
  mocks.summary.write.mockResolvedValue(mocks.summary);
  mocks.buildReleaseContext.mockImplementation(context);
  mocks.fetchPrompt.mockResolvedValue(PROMPT);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

async function runAction() {
  vi.resetModules();
  await import('../src/index');
  await vi.waitFor(() => {
    if (mocks.setOutput.mock.calls.length === 0 && mocks.setFailed.mock.calls.length === 0) {
      throw new Error('action has not finished');
    }
  }, { timeout: 5000 });
}

describe('Gemini request with only GEMINI_API_KEY set', () => {
  it('sends the recorded request', async () => {
    await runAction();

    expect(mocks.setFailed).not.toHaveBeenCalled();
    expect(requests).toEqual([fixture.request]);
  });

  it('writes the recorded outputs and artifacts for the canned response', async () => {
    await runAction();

    const outputs = Object.fromEntries(mocks.setOutput.mock.calls.filter(([name]) => name !== 'release-notes-path'));
    expect(outputs).toEqual(fixture.outputs);
    expect(mocks.setOutput).toHaveBeenCalledWith('release-notes-path', path.join(tempDir, 'artifacts', 'nuntia-release-notes.md'));
    const files = Object.fromEntries(ARTIFACTS.map(name => [name, fs.readFileSync(path.join(tempDir, 'artifacts', name), 'utf8')]));
    expect(files).toEqual(fixture.files);
  });
});
