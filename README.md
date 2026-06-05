# Culprit

Visual Studio Code extension that shows inline Git blame for the current line while you read or edit code. Hover the
annotation to see author, date, and recent file commits. Click a commit hash to open the diff -- without leaving the
editor.

## Quick Start

1. Install **Culprit** (`goeselt.culprit`) from the Visual Studio Code Extensions view.
2. Open any tracked file inside a Git repository.
3. Move the cursor to a committed line.

You will see an inline annotation such as:

```text
abc1234: tighten hover command handling
```

Hover the annotation to view author, date, and recent commits for the file. Click a commit hash to open the diff.

## Features

- Shows inline blame for the active line with commit hash and summary.
- Displays author and relative date in hover details.
- Lists recent commits for the current file in the same hover.
- Opens commit diffs directly from clickable commit links.
- Stays low-noise by annotating only the current line.

## Usage

Use the command palette to control behavior:

| Command                        | Description                    |
| ------------------------------ | ------------------------------ |
| `Culprit: Toggle Inline Blame` | Enable or disable annotations. |
| `Culprit: Show Commit Diff`    | Open the diff for a commit.    |

Extension setting:

| Setting           | Default | Description                      |
| ----------------- | ------- | -------------------------------- |
| `culprit.enabled` | `true`  | Enable inline blame annotations. |

## Requirements

- Visual Studio Code `1.120.0` or newer.
- Git available on your `PATH`.
- A workspace that contains a Git repository.

Culprit runs local Git commands only and does not send repository data to external services.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and [LICENSE](LICENSE).
