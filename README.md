# Culprit

Visual Studio Code extension that shows low-noise inline Git blame for the current line while you read or edit code.
Hover the annotation to inspect the line commit, copy the SHA, open the remote commit, compare with the previous
revision, and scan recent file commits without leaving the editor.

## Quick Start

1. Install **Culprit** (`goeselt.culprit`) from the Visual Studio Code Extensions view.
2. Open any tracked file inside a Git repository.
3. Move the cursor to a committed line.

You will see an inline annotation such as:

```text
tighten hover command handling, Ada Lovelace (2 weeks ago)
```

Hover the annotation to view the commit hash, author, date, ownership range, and recent commits for the file. Click the
hash to compare with the previous revision, the copy icon to copy the SHA, or the remote icon to open the commit in your
Git host.

## Features

- Shows inline blame for the active line with configurable summary, author, date, and range tokens.
- Displays the line commit, same-commit line range, and recent file commits in the hover.
- Opens commit diffs directly from clickable commit links.
- Copies commit SHAs and opens supported remote commit URLs from hover actions.
- Respects `.git-blame-ignore-revs` by default for formatter or bulk rewrite commits.
- Watches worktree and submodule Git directories when `.git` points outside the workspace folder.
- Stays low-noise by annotating only the current line.

## Usage

Use the command palette to control behavior:

| Command                        | Description                    |
| ------------------------------ | ------------------------------ |
| `Culprit: Toggle Inline Blame` | Enable or disable annotations. |
| `Culprit: Show Commit Diff`    | Open the diff for a commit.    |

Extension settings:

| Setting                       | Default                            | Description                                           |
| ----------------------------- | ---------------------------------- | ----------------------------------------------------- |
| `culprit.enabled`             | `true`                             | Enable inline blame annotations.                      |
| `culprit.ignoreRevs.enabled`  | `true`                             | Respect an ignore-revs file when blaming.             |
| `culprit.ignoreRevs.file`     | `.git-blame-ignore-revs`           | Repository-relative ignore-revs file.                 |
| `culprit.inlineFormat`        | `${summary}, ${author} (${date})`  | Inline format using supported tokens.                 |
| `culprit.authorFormat`        | `full`                             | Author style: `full`, `first`, `email`, or `hidden`.  |
| `culprit.dateFormat`          | `relative`                         | Date style: `relative` or `absolute`.                 |
| `culprit.locale`              | ``                                 | Locale for absolute dates; empty uses VS Code default. |
| `culprit.summaryMaxLength`    | `50`                               | Maximum commit summary length.                        |

Supported format tokens: `${sha}`, `${fullSha}`, `${author}`, `${date}`, `${summary}`, `${range}`.

## Requirements

- Visual Studio Code `1.120.0` or newer.
- Git available on your `PATH`.
- A workspace that contains a Git repository.

Culprit runs local Git commands only and does not send repository data to external services.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and [LICENSE](LICENSE).
