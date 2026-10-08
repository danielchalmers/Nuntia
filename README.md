# Nuntia — AI release notes & migration guides for GitHub

[![CI](https://github.com/danielchalmers/Nuntia/actions/workflows/ci.yml/badge.svg)](https://github.com/danielchalmers/Nuntia/actions/workflows/ci.yml)
[![Latest tag](https://img.shields.io/github/v/tag/danielchalmers/Nuntia?label=latest)](https://github.com/danielchalmers/Nuntia/tags)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)

Nuntia is a GitHub Action that writes release notes and migration guides from a commit range: it gathers commit messages, follows the issues, pull requests, and commits they reference, and feeds the full context to the model you pick (Gemini, Claude, OpenAI, or any OpenAI-compatible service) with a prompt you control. It runs on demand in your workflow with your own API key — no service to host.

The default prompt produces a themed changelog rather than a per-commit log: a highlights section, an upgrading section with breaking changes and before/after diffs, and net changes grouped by feature area with trailing reference links. The prompt is fetched from a URL, so you can swap in your own format without forking the action.

## Quick start

1. Add a model API key as a secret in your repository or organization: `GEMINI_API_KEY` ([get a key](https://aistudio.google.com/apikey)), `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`. Map it in the step's `env` (see [Models](#models)).
2. Add a manually-triggered workflow, like the ready-to-use [`examples/workflows/nuntia.yml`](./examples/workflows/nuntia.yml):

```yaml
name: Nuntia (Release Notes)

on:
  workflow_dispatch:
    inputs:
      base-commit:
        description: "Start commit SHA"
        required: true
      head-commit:
        description: "End commit SHA"
        required: true

jobs:
  release-notes:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      issues: read
      pull-requests: read
    steps:
      - uses: actions/checkout@v7

      - uses: danielchalmers/Nuntia@main
        with:
          base-commit: ${{ inputs.base-commit }}
          head-commit: ${{ inputs.head-commit }}
          branch: main
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}

      - uses: actions/upload-artifact@v7
        with:
          name: nuntia-release-notes-${{ github.run_number }}
          path: artifacts
          if-no-files-found: error
```

3. Run it from the Actions tab with the first and last commit of the release, then download the release notes from the run's artifacts.
4. Optionally write your own prompt — start from the [example prompt](./examples/Nuntia.prompt), host it anywhere with a raw URL (a Gist works well), and point `prompt-url` at it.

## How it works

- Resolves the inclusive commit range from the base commit, head commit, and branch.
- Scrapes commit messages and follows linked issues, PRs, and commits, with configurable depth and caps.
- Sends the aggregated context to the model using the prompt fetched from `prompt-url`.
- Writes the release notes markdown (plus payload/context debug files) to the `artifacts/` directory for your workflow to upload.

## Models

Set one model API key as a secret and map it in the step's `env`. Nuntia talks to every provider through its OpenAI-compatible Chat Completions API, with the same rules as [AutoTriage](https://github.com/danielchalmers/AutoTriage#models), so one set of secrets works for both actions.

| API key | Default model |
| --- | --- |
| `GEMINI_API_KEY` | `gemini-flash-latest` |
| `ANTHROPIC_API_KEY` | `claude-sonnet-5-5` |
| `OPENAI_API_KEY` | `gpt-6.1-sol` |
| `OPENAI_BASE_URL` (`OPENAI_API_KEY` optional) | none, so set `model` |

These defaults favor quality over cost, because the notes come from one call per release and a person reviews them.

- **With one key set**, `model` goes to it. With several, a `gemini-*` or `claude-*` model goes to Gemini or Claude when that key is set, and any other model goes to OpenAI or `OPENAI_BASE_URL`.
- **Any OpenAI-compatible service** (OpenRouter, Azure OpenAI, Groq, Mistral, xAI, DeepSeek, Together, Fireworks, Cerebras, LiteLLM, vLLM, Ollama, ...) works by setting `OPENAI_BASE_URL` to its API base and `model` to a model it serves, such as `anthropic/claude-sonnet-5.5` on OpenRouter.
- **A `model` input passed through from `workflow_dispatch`** keeps sending its default after you switch keys. Change that input's default to `""` and set `required: false`, as in [the example workflow](./examples/workflows/nuntia.yml), so the default for the key you set is used.
- **The log names the model and host**, such as `Model: claude-sonnet-5-5 at api.anthropic.com (default for ANTHROPIC_API_KEY)`.
- **Each provider runs at its default reasoning level.** Reasoning that a provider returns separately, or in a `<think>` block at the start of the reply, is left out of the notes.
- **Failures.** A bad key, an unknown model, or a billing problem fails at once and says what to check. An overloaded or rate-limited provider is retried for a few minutes. Notes cut off at the output limit, or a refusal, fail the run without writing a notes file.
- **Your data.** Commit messages and linked issue and pull request text go to the provider you pick. Gateways such as OpenRouter forward the text to further providers.

## Inputs

| Input | Purpose | Default |
| --- | --- | --- |
| `base-commit` | Start commit SHA (inclusive). | Required |
| `head-commit` | End commit SHA (inclusive). | Required |
| `branch` | Branch name (`branch` or `owner/repo@branch`). | Required |
| `prompt-url` | URL to raw prompt template content. | [example prompt](./examples/Nuntia.prompt) |
| `model` | Model that writes the notes. | The default for the API key you set (see [Models](#models)) |
| `max-linked-items` | Maximum linked issues/PRs/commits to fetch. | `5` |
| `max-reference-depth` | Depth to follow references inside linked descriptions. | `2` |
| `max-item-length` | Maximum length for each commit message and linked item title/body field. | `5000` |

## Outputs

| Output | Purpose |
| --- | --- |
| `release-notes-path` | Filesystem path to the release notes markdown. |
| `input-tokens` | Prompt tokens, cached tokens included. |
| `output-tokens` | Generated tokens, reasoning excluded. |

Token counts follow each provider's own counting, so they aren't comparable across providers.
