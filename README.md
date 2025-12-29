# Nuntia

Generate AI-authored release notes and migration guides from a commit range, on demand. Nuntia gathers commit descriptions plus any linked issues, pull requests, and commits referenced in those descriptions, then feeds the full context to Gemini using a prompt fetched from a URL.

## How it works

- Accepts a base commit, head commit, and branch, then resolves the inclusive commit range.
- Scrapes commit messages and follows linked issues/PRs/commits (with configurable depth).
- Sends the aggregated context to Gemini using your prompt URL.
- Writes release notes to a markdown file and uploads it as a workflow artifact.

## Quick setup

1. Create a Gist for the prompt from [the example](./examples/Nuntia.prompt) and use the raw URL for `prompt-url` later.
2. Add a `GEMINI_API_KEY` secret to your repository (or organization).
3. Add an workflow such as the ready-to-use one at [`examples/workflows/nuntia-release-notes.yml`](./examples/workflows/nuntia-release-notes.yml):

## Inputs

| Input | Purpose | Default |
| --- | --- | --- |
| `base-commit` | Start commit SHA (inclusive). | - |
| `head-commit` | End commit SHA (inclusive). | - |
| `branch` | Branch name (`branch` or `owner/repo@branch`). | - |
| `prompt-url` | URL to raw prompt template content. | Required |
| `model` | Gemini model identifier. | `gemini-3-flash-preview` |
| `temperature` | Model temperature (`0` deterministic → `2` exploratory). | `1.0` |
| `max-linked-items` | Maximum linked issues/PRs/commits to fetch. | `3` |
| `max-reference-depth` | Depth to follow references inside linked descriptions. | `2` |
| `max-item-length` | Maximum combined length for commit messages and linked item titles/bodies. | `3000` |
| `max-item-body-length` | Deprecated; use `max-item-length`. | `3000` |

## Outputs

| Output | Purpose |
| --- | --- |
| `release-notes-path` | Filesystem path to the release notes markdown. |
| `input-tokens` | Gemini prompt token count. |
| `output-tokens` | Gemini output token count. |

## License

MIT
