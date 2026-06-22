# Contributing to Culprit

Thanks for taking care of Culprit. The project is intentionally small: the main
maintenance goal is to keep inline blame useful without growing into a full Git
suite.

## Design

| File               | Responsibility                                                            |
| ------------------ | ------------------------------------------------------------------------- |
| `src/git.ts`       | Git subprocess calls: blame, file history, diff existence check.          |
| `src/extension.ts` | Decoration lifecycle, caching, hover rendering, Git watcher invalidation. |
| `esbuild.mjs`      | Bundle script that compiles TypeScript sources to `out/extension.js`.     |

`src/git.ts` owns all process spawning and output parsing; `src/extension.ts` never calls Git directly. Cache
invalidation is driven by filesystem watchers on `.git/HEAD`, `.git/index`, and related refs -- not by Visual Studio
Code document events alone.

## Maintainer Map

Start here when you come back after a break:

1. `src/extension.ts` wires VS Code events to one active-line decoration.
2. `src/git.ts` runs Git commands and parses their output.
3. `package.json` declares commands and settings visible to users.
4. `README.md` describes user-facing behavior; keep it in sync with settings.
5. `test/git.test.ts` covers Git parsing and command-safety boundaries.

The extension should stay local-first and API-sparse. It may open a remote
commit URL when the user clicks the hover action, but it should not call hosted
Git APIs to render blame.

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
- Keep VS Code UI lifecycle work in `src/extension.ts`.
- Prefer one active-line decoration over background analysis or broad scans.
- Validate command inputs that can come from Markdown command links.
- Prefer small settings with clear defaults; remove settings when the feature is
  removed.
- Add tests for Git parsing, path handling, shell/command safety, and URL
  generation. Manual Extension Development Host testing is acceptable for
  VS Code rendering behavior.

## Submitting Changes

Commit messages and PR titles must follow [Conventional Commits](https://www.conventionalcommits.org/). The release
pipeline uses the PR title to determine the next version.

Before opening a PR, run:

```bash
npm run verify
npm run package
rm -f culprit-*.vsix
```
