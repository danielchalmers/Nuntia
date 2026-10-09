# AGENTS.md

This document provides comprehensive instructions for AI agents and developers working on the Nuntia project. It outlines setup, development workflow, testing procedures, and build requirements.

## Project Overview

Nuntia is a GitHub Action that generates release notes and migration guides from a commit range. It is built with TypeScript, requires Node.js 24+ for development, and runs on Node.js 24 in GitHub Actions.

## Prerequisites

- **Node.js**: Version 24 or higher (specified in `package.json` engines)
- **npm**: Comes bundled with Node.js
- **Git**: For version control
- **GitHub Token**: Required for GitHub API access (set as `GITHUB_TOKEN` environment variable)
- **Model API Key**: Required for AI functionality (set `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, or `OPENAI_API_KEY`, optionally with `OPENAI_BASE_URL`)

## Repository Structure

```
Nuntia/
├── .github/          # GitHub workflows and configuration
├── dist/             # Compiled output (generated, committed to repo)
├── examples/         # Default prompt (bundled into dist) and example workflow
├── src/              # TypeScript source code
│   └── llm/          # Shared model layer, copied verbatim from AutoTriage
├── tests/            # Test files using Vitest
│   └── llm/          # Shared model layer tests, copied verbatim from AutoTriage
├── action.yml        # GitHub Action metadata
├── package.json      # Dependencies and scripts
├── tsconfig.json     # TypeScript configuration
└── vitest.config.ts  # Test configuration
```

## Initial Setup

### 1. Clone the Repository

```bash
git clone https://github.com/danielchalmers/Nuntia.git
cd Nuntia
```

### 2. Install Dependencies

```bash
npm ci
```

Use `npm ci` (clean install) for reproducible builds based on `package-lock.json`.

### 3. Credentials

Unit tests mock GitHub and `fetch`, and model calls go to local stand-in servers, so `npm test` needs no credentials or network access beyond localhost.
`GITHUB_TOKEN` and a model API key are only needed to run the action itself against real services.

## Development Workflow

### Available npm Scripts

- `npm run typecheck` - Type-check TypeScript without emitting files
- `npm run typecheck:test` - Type-check the tests (and source) with `tsconfig.test.json`
- `npm run dev` - Watch mode for TypeScript compilation
- `npm run build` - Full production build (typecheck, clean, and bundle)
- `npm run clean` - Remove the dist directory
- `npm test` - Run all tests once
- `npm run test:watch` - Run tests in watch mode

### TypeScript Development

1. Make changes to source files in `src/`
2. Run type checking: `npm run typecheck`
3. For continuous development, use watch mode: `npm run dev`

### Testing

Tests are located in the `tests/` directory and use Vitest.

#### Running Tests

```bash
npm test
```

#### Test Environment

- Tests use Vitest with Node.js environment
- Test files: `tests/**/*.test.ts`
- `vitest.config.ts` loads `.prompt` imports as text, matching the build, so tests see the bundled prompt

## Shared Model Layer

`src/llm/` (`endpoint.ts` picks the Chat Completions endpoint and key for the model input, and `chat.ts` is the one client every provider goes through) and `tests/llm/` are copied verbatim from [AutoTriage](https://github.com/danielchalmers/AutoTriage), which owns them.

- Never edit them here. Make the change in AutoTriage, then copy both folders over in a paired PR that names the AutoTriage commit, and check that `diff -r` against that commit is empty.
- Nuntia's own wiring (the default models and the text call) lives in `src/env.ts` and `src/index.ts`.

## Building the Project

### Creating the dist Folder

The `dist/` folder contains the compiled, bundled JavaScript that GitHub Actions executes. **This folder must be committed to the repository** as GitHub Actions runs directly from it.

#### Build Process

```bash
npm run build
```

This command performs the following steps:

1. **Type-checking** (`npm run typecheck`) - Validates TypeScript code
2. **Clean** (`npm run clean`) - Removes the existing dist folder
3. **Bundle** (`esbuild`) - Bundles TypeScript into a single `dist/index.js`
   - Inlines `examples/Nuntia.prompt` as text (`--loader:.prompt=text`)
   - Minifies the output
   - Appends third-party license notices to the end of the file
   - Emits one file only (no code-split chunks or source map)

#### Important: Commit dist Changes

After building, the `dist/` folder contents must be committed:

```bash
npm run build
git add dist/
git commit -m "Build: Update dist folder"
```

The CI workflow (`ci.yml`) rebuilds `dist/` on Node.js 24 (matching the action runtime) and fails if the committed output drifts from a fresh build:

```bash
npm run build
npm run check:dist   # exits non-zero if git sees any change under dist/
```

If you forget to rebuild dist after changing source code, the CI will fail. esbuild produces byte-identical output across Windows and Linux (and `.gitattributes` pins line endings), so the committed bundle a developer builds locally matches the Linux CI rebuild.

## Pre-commit Checklist

Before committing changes, ensure:

1. ✅ **Type-check passes**: `npm run typecheck` and `npm run typecheck:test`
2. ✅ **Tests pass**: `npm test`
3. ✅ **Build succeeds**: `npm run build`
4. ✅ **dist is up to date**: Commit any changes in `dist/` folder
5. ✅ **No uncommitted changes in dist**: `git status` shows clean dist

## Continuous Integration

The project uses GitHub Actions for CI (`.github/workflows/ci.yml`):

1. Installs dependencies with `npm ci`
2. Runs type-checking
3. Builds the project
4. Verifies dist folder is up to date
5. Runs a mock release-notes generation
6. Runs unit tests (separate workflow: `tests.yml`)

## Common Tasks

### Adding New Dependencies

```bash
npm install <package-name>
npm run build
```

### Updating TypeScript Code

1. Edit source files in `src/`
2. Run `npm run typecheck` to verify types
3. Run `npm test` to ensure tests pass
4. Run `npm run build` to update dist
5. Commit both source and dist changes

## Working with the GitHub Action

The action is defined in `action.yml` and runs from `dist/index.js`. Key points:

- **Entry point**: `dist/index.js`
- **Runtime**: Node.js 24 (specified in `action.yml`)
- **Inputs**: Defined in `action.yml`
- **Default prompt**: `examples/Nuntia.prompt`, bundled into `dist/index.js` and used when `prompt-url` is blank. Editing it changes runtime output, so rebuild `dist/`.
- **Prompt URL input**: `prompt-url` (optional) fetches a prompt to try without committing it, with a 30-second timeout and two retries. A prompt that still can't be fetched fails the run.
- **Workspace**: the action reads everything through the GitHub API, so consumers need no checkout step.

## File Artifacts

The action writes these files to the `artifacts/` directory during execution:

- `artifacts/nuntia-release-notes.md` - Generated release notes output
- `artifacts/nuntia-payload.json` - The model and both prompts sent (debug)
- `artifacts/nuntia-context.json` - Resolved release context (debug)

The action does not upload them itself (that would require bundling `@actions/artifact`, whose transitive Azure SDK is not byte-reproducible across OSes and breaks the dist check). Upload them from your workflow with `actions/upload-artifact` and `path: artifacts`.

## Troubleshooting

### Build Failures

**Issue**: `npm run build` fails
- Check Node.js version: `node --version` (must be 24+)
- Clear node_modules: `rm -rf node_modules && npm ci`
- Check TypeScript errors: `npm run typecheck`

### Test Failures

**Issue**: A test tries to reach GitHub, a model API, or the network
- Tests must not depend on real services; mock the client (see the `makeClient` helpers in `tests/`), stub `fetch` with `vi.stubGlobal`, or point the model client at a local server (see `tests/llm/chat.test.ts`)

## Best Practices

1. **Always rebuild dist** after changing source code
2. **Run type-check** before committing
3. **Run tests** to catch regressions
4. **Use `npm ci`** in CI/CD and for clean installs
5. **Keep dist committed** - GitHub Actions needs it
6. **Don't edit dist manually** - always regenerate with `npm run build`
7. **Follow TypeScript strict mode** - project uses strict compiler options

## Additional Resources

- **README.md** - User-facing documentation and setup guide
- **action.yml** - GitHub Action configuration and input definitions
- **examples/** - The default prompt (bundled into `dist/`) and the sample workflow
- **.github/workflows/** - CI/CD pipeline definitions

## Questions?

For questions or issues:
1. Check existing issues on GitHub
2. Review the README.md for user documentation
3. Examine the CI workflows for expected behavior
4. Consult TypeScript and GitHub Actions documentation
