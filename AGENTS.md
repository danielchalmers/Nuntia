# AGENTS.md

This file is the agent harness for Nuntia: the map, the constraints and the feedback loops an agent needs to make reliable changes.
It follows OpenAI's harness engineering guidance, which holds that agents work best from repository-local knowledge, legible systems, enforced invariants and tight validation loops rather than a long manual.
Keep this file the table of contents and the operating contract, and move a rule into a test, a script or CI once it is stable.

Source: https://openai.com/index/harness-engineering/

## Project Contract

Nuntia is a GitHub Action that writes release notes and migration guides into a published GitHub release, or previews the next release's notes in the job summary.
It reads the commits a release covers through the GitHub API, follows the issues, pull requests and commits they reference, and sends that context to one model with a prompt.
`README.md` documents what users see.

Preserve these invariants:

- Runtime: Node.js 24 or newer, and `action.yml` runs `dist/index.js` on `node24`.
- Source of truth: TypeScript under `src/`.
- Generated bundle: `dist/index.js` is committed and never edited by hand.
- Inputs: only `model` and `prompt-url`. The commit range comes from the release and the limits are constants, so prefer a built-in default to a new input.
- Default prompt: `examples/Nuntia.prompt` is bundled into `dist/index.js` and used when `prompt-url` is blank.
- Everything is read through the GitHub API, so consumers need no checkout step.
- The only GitHub write is Nuntia's own section of a published release, between `<!-- nuntia:start -->` and `<!-- nuntia:end -->`, made after the job summary and `artifacts/` are written. A preview writes only the job summary and `artifacts/`.
- Every run cleans the model's notes with `sanitizeNotes` before they reach the notes file, the job summary or the release.
- Notes are never written from a partial commit range: a compare that returns fewer commits than its total fails the run.
- A configuration error, such as a missing or rejected key, an unknown model, a missing permission or a `prompt-url` that can't be fetched, fails the run, and so does a bug in Nuntia. A model outage, timeout, truncated reply or refusal, and a GitHub rate limit or outage, only warn in the log and the job summary.
- Unit tests need no GitHub or model credentials, and no network beyond localhost.
- `action.yml`, `README.md`, the tests and `dist/` describe the same behavior.

## Context Map

Start with the smallest useful context:

- `src/index.ts` - entry point. It loads the config and the prompt, resolves the range, builds the context, calls the model, cleans the notes, and writes `artifacts/`, the job summary and the release. It also decides which failures fail the run: a `ModelError` of kind `fatal` (a rejected key, an unknown model or a billing problem) or any other exception fails it, while other model failures and transient GitHub failures stop with a warning.
- `src/env.ts` - `getConfig`: the inputs, the default model for each API key, and the release event payload.
- `src/types.ts` - shared types, including the `ReleaseContext` the model receives.
- `src/release.ts` - which commits a run covers. A release event or a dispatch on a tag reads the base from the release's `**Full Changelog**` link, with `POST generate-notes` as the fallback, and any other run previews from the latest release, or the newest tag, to `GITHUB_SHA`.
- `src/references.ts` - finds issue, pull request and commit references in commit messages and linked item text.
- `src/context.ts` - follows references, up to 5 for each commit and 2 levels deep, and keeps the context within its budgets: 300 GitHub API calls, then 360,000 characters of compact JSON, trimmed in order by dropping the items found through other linked items, then the changed-file list, then cutting linked item bodies shorter.
- `src/github.ts` - the GitHub API boundary: `GitHubClient`, which counts its calls, the throttling policy (wait out a rate limit only when it lifts within 60 seconds, up to 3 retries for each request), and `isRateLimited` and `isTransientFailure`.
- `src/prompt.ts` - loads the bundled prompt or the one at `prompt-url` (a 30-second timeout and two retries), and puts the compact context JSON in the user prompt.
- `src/sanitize.ts` - cleans the notes: removes raw HTML, images and Nuntia's markers, wraps @mentions and outside bare URLs in backticks, and keeps only the text of links outside the repository.
- `src/publish.ts` - reads the release again and splices the notes between Nuntia's markers, warning instead of writing when the markers are broken, the body would pass 125,000 characters, the release is gone, or GitHub fails transiently. HTTP 401 and any other 403 fail the run, because the workflow lacks `contents: write`.
- `src/llm/` - the model API boundary, copied from AutoTriage (see Change Rules). `endpoint.ts` picks the Chat Completions endpoint and key for the `model` input, and `chat.ts` is the one client every provider goes through, with its retries, call deadline and failure kinds.
- `examples/Nuntia.prompt` - the bundled prompt: a short brief plus a major and a minor worked example.
- `examples/workflows/nuntia.yml` - the example workflow that the README quick start shows.
- `tests/` - Vitest files named after the modules they cover, with `tests/promptBuilder.test.ts` for `src/prompt.ts`, `tests/index.test.ts` for the entry point, `tests/llm/` for the shared layer, and `tests/setup.ts` for the test environment.
- `action.yml` - public action metadata.
- `.github/workflows/ci.yml` - the only CI workflow (see Required Verification).
- `.github/workflows/autotriage.yml` - triages this repository's own issues and pull requests with AutoTriage.
- `dist/` - the generated bundle.

Read the relevant source and nearby tests before editing. Prefer repository-local evidence over assumptions from memory.

## Operating Loop

For any change:

1. Inspect the current implementation, tests and public contract.
2. Make the smallest coherent change.
3. Add or update focused tests when behavior changes.
4. Run the narrowest useful verification first, such as `npx vitest run tests/release.test.ts`.
5. Run the required verification before finishing.
6. Rebuild `dist/` and commit it with the change when source, the bundled prompt, dependencies or build settings change runtime output.
7. Summarize what changed, what was verified, and any remaining risk.

If something fails, do not guess. Treat the failure as a missing capability, a broken invariant, a stale test or a real regression, and fix that cause.

## Required Verification

```bash
npm run verify
```

It runs `typecheck`, `typecheck:test`, `test`, `build` and `check:dist` in order, as CI does.
`check:dist` fails while `git status` shows any change under `dist/`, so commit the rebuilt bundle with the change that caused it and run `npm run verify` again.
esbuild's output is byte-identical on Windows and Linux, and `.gitattributes` pins LF line endings, so a bundle built locally matches CI's.

CI is the single workflow `.github/workflows/ci.yml`, which runs on pushes to `main` and on every pull request, stacked ones included. A newer push to a pull request cancels its older run, and pushes to `main` never cancel each other.

- The `build` job runs `npm ci` and `npm run verify` on Node 24.
- The `mock` job then runs `dist/index.js` with a synthetic `release` event for a fixed past range, PRs #45 to #53 (`86c7d7a...2fb4038`), with `claude-haiku-5-5` through `ANTHROPIC_API_KEY`, and uploads `artifacts/`. The range never grows, so each run costs about 16 GitHub API calls and 26K input tokens.
- The mock's permissions are read-only, so it can't write into a release, and it ends with one expected warning that the release no longer exists. Fork pull requests skip it, because they get no secrets.
- The mock bypasses `action.yml` and the preview path, so `tests/env.test.ts` checks that `action.yml` declares exactly the inputs `getConfig` reads and runs `dist/index.js` on Node 24, and `tests/release.test.ts` covers the preview.
- CI calls no other model. There is no Gemini or OpenAI step, because every provider goes through the same Chat Completions client, which `tests/llm/` covers.

## Development Commands

- `npm ci` - install dependencies from `package-lock.json`.
- `npm run typecheck` - type-check the source.
- `npm run typecheck:test` - type-check the source and the tests with `tsconfig.test.json`.
- `npm test` - run Vitest once.
- `npm run test:watch` - run Vitest in watch mode.
- `npm run dev` - type-check the source in watch mode.
- `npm run build` - type-check, clean `dist/`, and bundle with esbuild into one minified `dist/index.js`, with `.prompt` files inlined as text and third-party license notices at the end (no source map or code-split chunks).
- `npm run check:dist` - fail if `dist/` has uncommitted changes.
- `npm run verify` - all of the checks above in CI's order.
- `npm run clean` - remove `dist/`.

## Change Rules

### Source Changes

- Keep TypeScript strictness intact, including `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`.
- Validate or narrow untrusted shapes at the boundary: the release event payload and REST responses in `src/github.ts`, the prompt fetched from `prompt-url`, and the model's reply, which `sanitizeNotes` cleans. Commit messages and issue text are untrusted public input.
- Keep external access behind `GitHubClient`, `ChatClient` and `loadPrompt`, so tests can replace it.
- Send GitHub and model requests one at a time. The reference walk is sequential, so the API call budget and the stop on the first rate limit stay exact.
- Write code comments as complete sentences that break only at sentence boundaries, never hard-wrapped at a column width.
- Avoid broad refactors unless they directly reduce risk for the change.

### Shared Model Layer

- `src/llm/` and `tests/llm/` are copied verbatim from [AutoTriage](https://github.com/danielchalmers/AutoTriage), which owns them. Never edit them here.
- Make the change in AutoTriage, then copy both folders over in a paired PR that names the AutoTriage commit, and check that `diff -r` against that commit is empty.
- Nuntia's own wiring, the default models and the text call, lives in `src/env.ts` and `src/index.ts`.

### Public Action Changes

When changing an input, a default, a permission or behavior users see:

- Update `action.yml`, `README.md`, and `examples/workflows/nuntia.yml` when it uses what changed.
- Update `getConfig` and its tests. `tests/env.test.ts` fails when `action.yml` and `getConfig` disagree on the inputs.
- Rebuild `dist/` and inspect the change.

### Prompt and Context Changes

- `examples/Nuntia.prompt` is bundled, so editing it changes runtime output and needs a rebuild.
- Keep its two worked examples, each between `=== EXAMPLE NOTES ===` and `=== END OF EXAMPLE NOTES ===`. `tests/promptBuilder.test.ts` checks that they come through `sanitizeNotes` unchanged and keep the shape of a major and a minor release.
- Test prompt changes with small targeted assertions, not snapshots of the whole prompt.
- The context budget counts characters of the compact JSON the model receives, not tokens. Claude was measured at 2.4 characters a token for this JSON, so 360,000 characters is about 150k tokens. Log sizes in characters and label any token count as an estimate.

### Dependency Changes

Before adding a dependency, check whether the existing stack already solves the problem. A new dependency must work on Node.js 24 in GitHub Actions, be committed in `package-lock.json`, be covered by tests, and bundle to byte-identical output on Windows and Linux, or `check:dist` breaks. That is why the action writes `artifacts/` and leaves uploading them to the workflow, instead of bundling `@actions/artifact`, whose Azure SDK isn't reproducible.

## Testing Expectations

For release notes behavior, cover:

- A release event, a dispatch on a tag, and a preview.
- Missing, malformed or partial input, such as a release body without a usable Full Changelog link, broken markers, or text that only looks like a reference.
- Model failures by kind, and GitHub failures: rate limits, outages, HTTP 401 and other 403s.
- What reaches `artifacts/`, the job summary and the release.

Mock `GitHubClient` with a stub, as the `makeClient` helpers in `tests/` do, and stub `fetch` with `vi.stubGlobal` for `prompt-url`. When the transport itself matters, point the real Octokit or the model client at a localhost server, as `tests/github.test.ts` and `tests/llm/chat.test.ts` do.
`src/index.ts` runs the action on import, so `tests/index.test.ts` mocks every collaborator with I/O and imports a fresh copy for each test.
`tests/setup.ts` removes every `GITHUB_*`, `INPUT_*` and `RUNNER_*` variable before the test files load and again before each test, so a test sets what it needs with `vi.stubEnv`.
Only failing tests print their logs (`silent: 'passed-only'`), so spy on `console` only to assert a log line, and mock `@actions/core` in tests that reach commands such as `warning`, which write straight to stdout.
Running the action itself needs `GITHUB_TOKEN` and a model API key, but unit tests must never depend on them.

## Failure Recovery

- `npm ci` fails: check the Node and npm versions and the lockfile.
- Typecheck fails: fix the types rather than weakening strictness.
- Tests fail: decide whether it is a regression, a stale expectation, a missing mock or the environment.
- A test reaches GitHub, a model API or the network: mock the client, stub `fetch`, or use a localhost server.
- Build fails: read the first compiler or bundler error before retrying.
- `check:dist` fails: rebuild, inspect the generated diff, and commit `dist/` with the change.
- `src/llm/` or `tests/llm/` need a fix: make it in AutoTriage first.
- Credentials are missing: don't invent them, and report the blocked verification.

## Pull Request Readiness

Before opening or updating a PR:

- `npm run verify` has passed, or each blocked check is named with its reason.
- Runtime-impacting changes include the rebuilt `dist/`.
- Public behavior changes are reflected in `action.yml`, `README.md` and the tests.
- A copy of `src/llm/` names the AutoTriage commit it came from.
- Unrelated files are not modified.
- The PR body explains the why, the what, the verification and the residual risk.
