# Contributing to Culprit

## Design

| File               | Responsibility                                                            |
| ------------------ | ------------------------------------------------------------------------- |
| `src/git.ts`       | Git subprocess calls: blame, file history, diff existence check.          |
| `src/extension.ts` | Decoration lifecycle, caching, hover rendering, Git watcher invalidation. |
| `esbuild.mjs`      | Bundle script that compiles TypeScript sources to `out/extension.js`.     |

`src/git.ts` owns all process spawning and output parsing; `src/extension.ts` never calls Git directly. Cache
invalidation is driven by filesystem watchers on `.git/HEAD`, `.git/index`, and related refs -- not by Visual Studio
Code document events alone.

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

Lint:

```bash
docker pull ghcr.io/goeselt/pedant:latest
docker run --rm -v "$(pwd):/work" ghcr.io/goeselt/pedant:latest
```

Update dependencies:

```bash
npm run update
```

Typecheck and build:

```bash
npm run verify
```

## Submitting Changes

Commit messages and PR titles must follow [Conventional Commits](https://www.conventionalcommits.org/). The release
pipeline uses the PR title to determine the next version.
