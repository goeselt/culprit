# Contributing to Culprit

Thanks for taking care of Culprit. The project is intentionally small: the main maintenance goal is to keep inline blame
useful without growing into a full Git suite.

## Design

| File               | Responsibility                                                                          |
| ------------------ | --------------------------------------------------------------------------------------- |
| `src/extension.ts` | Visual Studio Code lifecycle, one active-line decoration, commands, cache invalidation. |
| `src/git.ts`       | Git subprocess calls, output parsing, repo/path safety boundaries.                      |
| `src/display.ts`   | Pure formatting for inline text, hover text, dates, and string hygiene.                 |
| `package.json`     | User-visible commands, settings, Visual Studio Code engine, extension capabilities.     |
| `esbuild.mjs`      | Bundle script that compiles TypeScript sources to `out/extension.js`.                   |

`src/git.ts` owns all process spawning and output parsing; `src/extension.ts` never calls Git directly. `src/display.ts`
does not import `vscode`, so formatting stays easy to test with plain Node tests.

## Maintainer Map

Start here when you come back after a break:

1. Read `activate()` in `src/extension.ts` to see every Visual Studio Code event and command.
2. Follow `updateDecoration()` for the normal cursor-move path.
3. Check `getFileBlame()` and `getFileHistory()` for cache behavior.
4. Open `src/git.ts` only when changing Git invocations or parsing.
5. Open `src/display.ts` only when changing user-facing text or formatting.
6. Keep `README.md`, `package.json`, and `CONTRIBUTING.md` in sync when adding settings or commands.

The extension should stay local-first and API-sparse. It may open a remote commit URL when the user clicks the hover
action, but it should not call hosted Git APIs to render blame.

## Core Rules

- One active editor line gets one decoration. Avoid background blame scans.
- Git calls go through `src/git.ts` and use `execFile`, never shell command strings.
- Values from Git output are untrusted display data; sanitize them in `src/display.ts`.
- Markdown command links must validate their command arguments before doing work.
- Public command handlers must reject file paths outside the opened workspace.
- Automatic blame should stay bounded; large-file limits protect the extension host from expensive Git calls.
- Cache invalidation is driven by `.git/HEAD`, `.git/index`, packed refs, branch refs, saves, and configuration changes.
- Settings need a default in `package.json`, a matching runtime fallback, readme documentation, and usually a small
  test.

## Development Setup

- Node.js 24
- npm

```bash
npm ci
npm run build
```

Use the **Run Extension** launch configuration (`F5`) to open an Extension Development Host with Culprit loaded and all
other extensions disabled.

## Local Verification

Fast local check:

```bash
npm run verify
```

Package smoke test:

```bash
npm run package
rm -f culprit-*.vsix
```

Pedant lint:

```bash
docker pull ghcr.io/goeselt/pedant:latest
docker run --rm -v "$(pwd):/work" ghcr.io/goeselt/pedant:latest
```

Update dependencies:

```bash
npm run update
```

## Change Guidelines

- Keep Git subprocess work in `src/git.ts`.
- Keep Visual Studio Code UI lifecycle work in `src/extension.ts`.
- Keep formatting and string cleanup in `src/display.ts`.
- Prefer one active-line decoration over background analysis or broad scans.
- Validate command inputs that can come from Markdown command links.
- Prefer small settings with clear defaults; remove settings when the feature is removed.
- Add tests for Git parsing, path handling, shell/command safety, URL generation, and display formatting. Manual
  Extension Development Host testing is acceptable for Visual Studio Code rendering behavior.

## Submitting Changes

Commit messages and PR titles must follow [Conventional Commits](https://www.conventionalcommits.org/). The release
pipeline uses the PR title to determine the next version.

Before opening a PR, run:

```bash
npm run verify
npm run package
rm -f culprit-*.vsix
```
