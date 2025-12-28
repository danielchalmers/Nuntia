# Nuntia

Generate AI-authored release notes and migration guides from a commit range, on demand. Nuntia gathers commit descriptions plus any linked issues, pull requests, and commits referenced in those descriptions, then feeds the full context to Gemini using your custom prompt.

## How it works

- Accepts a base commit, head commit, and branch, then resolves the inclusive commit range.
- Scrapes commit messages and follows linked issues/PRs/commits (with configurable depth).
- Sends the aggregated context to Gemini using your prompt file.
- Writes release notes to a markdown file and uploads it as a workflow artifact.

## Quick setup

1. Copy the [default prompt](./examples/Nuntia.prompt) into your repo as `.github/Nuntia.prompt` and tailor the output format.
2. Add a `GEMINI_API_KEY` secret to your repository (or organization).
3. Add an on-demand workflow such as:

```yaml
name: generate-release-notes
on:
  workflow_dispatch:
    inputs:
      base-commit:
        description: "Start commit SHA (inclusive)"
        required: true
      head-commit:
        description: "End commit SHA (inclusive)"
        required: true
      branch:
        description: "Branch name"
        required: true
        default: "main"

jobs:
  release-notes:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      issues: read
      pull-requests: read
    steps:
      - uses: actions/checkout@v5
      - name: Nuntia
        uses: danielchalmers/Nuntia@main
        with:
          base-commit: ${{ inputs.base-commit }}
          head-commit: ${{ inputs.head-commit }}
          branch: ${{ inputs.branch }}
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}
```

## Inputs

| Input | Purpose | Default |
| --- | --- | --- |
| `base-commit` | Start commit SHA (inclusive). | - |
| `head-commit` | End commit SHA (inclusive). | - |
| `branch` | Branch name associated with the range. | - |
| `prompt-path` | Path to your release notes prompt. | `.github/Nuntia.prompt` |
| `model` | Gemini model identifier. | `gemini-3-flash-preview` |
| `temperature` | Model sampling temperature (`0` deterministic → `2` exploratory). | `1.0` |
| `output-path` | Output markdown path for release notes. | `artifacts/nuntia-release-notes.md` |
| `artifact-name` | Artifact name for the release notes file. | `nuntia-release-notes` |
| `max-linked-items` | Maximum linked issues/PRs/commits to fetch. | `100` |
| `max-reference-depth` | Depth to follow references inside linked descriptions. | `2` |

## Outputs

| Output | Purpose |
| --- | --- |
| `release-notes-path` | Filesystem path to the release notes markdown. |
| `release-notes-artifact` | Artifact name containing the release notes. |
| `input-tokens` | Gemini prompt token count. |
| `output-tokens` | Gemini output token count. |

## Example output format

```
### 🔠 Text Transformation Options

Users can now apply uppercase or lowercase transformations to the clock display via a new settings option.

[Commit 48ed52f](https://github.com/danielchalmers/DesktopClock/commit/48ed52f8e6482e25d50b1317ee17656850b85e89) [Issue #81](https://github.com/danielchalmers/DesktopClock/issues/81)

### 🔤 Font Weight Customization

A new setting has been added to adjust the font weight of the clock text directly from the user interface.

You can now easily set the clock to bold or other weights without needing to manually edit the configuration file.

[Commit 1f931bf](https://github.com/danielchalmers/DesktopClock/commit/1f931bf17e9480d919c02dd45cb4dd7b5784b973) [Issue #80](https://github.com/danielchalmers/DesktopClock/issues/80)
```

## Example workflows

See the ready-to-use workflow in [`examples/workflows`](./examples/workflows/):

- [`nuntia-release-notes.yml`](./examples/workflows/nuntia-release-notes.yml) – run on demand via `workflow_dispatch`.

## License

MIT
