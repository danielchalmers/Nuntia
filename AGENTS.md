# AGENTS.md

This document provides comprehensive instructions for AI agents and developers working on the Nuntia project. It outlines setup, development workflow, testing procedures, and build requirements.

## Project Overview

Nuntia is a GitHub Action that generates release notes and migration guides from a commit range. It is built with TypeScript, requires Node.js 22+ for development, and runs on Node.js 24 in GitHub Actions.

## Prerequisites

- **Node.js**: Version 22 or higher (specified in `package.json` engines)
- **npm**: Comes bundled with Node.js
- **Git**: For version control
- **GitHub Token**: Required for GitHub API access (set as `GITHUB_TOKEN` environment variable)
- **Gemini API Key**: Required for AI functionality (set as `GEMINI_API_KEY` environment variable)

## Repository Structure

```
Nuntia/
├── .github/          # GitHub workflows and configuration
├── dist/             # Compiled output (generated, committed to repo)
├── examples/         # Example prompts and workflows
├── src/              # TypeScript source code
├── tests/            # Test files using Vitest
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

### 3. Set Up Environment Variables

Create a `.env` file in the root directory (this file is gitignored):

```bash
GITHUB_TOKEN=your_github_token_here
GEMINI_API_KEY=your_gemini_api_key_here
```

These are required for running tests and local development.

## Development Workflow

### Available npm Scripts

- `npm run typecheck` - Type-check TypeScript without emitting files
- `npm run dev` - Watch mode for TypeScript compilation
- `npm run build` - Full production build (typecheck, clean, bundle, and asset copy)
- `npm run clean` - Remove the dist directory
- `npm run copy-assets` - Copy required assets to dist folder
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
- Setup file: `tests/setupEnv.ts`
- Test files: `tests/**/*.test.ts`

## Building the Project

### Creating the dist Folder

The `dist/` folder contains the compiled, bundled JavaScript that GitHub Actions executes. **This folder must be committed to the repository** as GitHub Actions runs directly from it.

#### Build Process

```bash
npm run build
```

This command performs the following steps:

1. **Type-checking** (`npm run typecheck`) - Validates TypeScript code
2. **Clean** (`rimraf dist`) - Removes existing dist folder
3. **Bundle** (`ncc build`) - Compiles and bundles TypeScript to a single JavaScript file
   - Minifies the output
   - Generates source maps
   - Includes license information in `licenses.txt`
4. **Copy Assets** (`npm run copy-assets`) - Copies `examples/Nuntia.prompt` to dist as the bundled default prompt

#### Important: Commit dist Changes

After building, the `dist/` folder contents must be committed:

```bash
npm run build
git add dist/
git commit -m "Build: Update dist folder"
```

The CI workflow (`ci.yml`) verifies that the dist folder is up to date:

```bash
git status --porcelain
git diff --exit-code --name-only
```

If you forget to rebuild dist after changing source code, the CI will fail.

## Pre-commit Checklist

Before committing changes, ensure:

1. ✅ **Type-check passes**: `npm run typecheck`
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
- **Default prompt path**: `.github/Nuntia.prompt` (where users place their custom prompt)
- **Bundled prompt**: `examples/Nuntia.prompt` (copied to dist during build as fallback)

## File Artifacts

The action generates artifacts during execution:

- `artifacts/nuntia-release-notes.md` - Generated release notes output

These are uploaded as workflow artifacts by the action itself.

## Troubleshooting

### Build Failures

**Issue**: `npm run build` fails
- Check Node.js version: `node --version` (must be 22+)
- Clear node_modules: `rm -rf node_modules && npm ci`
- Check TypeScript errors: `npm run typecheck`

### Test Failures

**Issue**: Tests fail with API errors
- Ensure `GEMINI_API_KEY` is set in `.env`
- Ensure `GITHUB_TOKEN` is set in `.env`
- Check internet connectivity

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
- **examples/** - Sample prompts and workflow configurations
- **.github/workflows/** - CI/CD pipeline definitions

## Questions?

For questions or issues:
1. Check existing issues on GitHub
2. Review the README.md for user documentation
3. Examine the CI workflows for expected behavior
4. Consult TypeScript and GitHub Actions documentation
