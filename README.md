# github-visual-universe

An open-source, personal GitHub intelligence platform for visually exploring repositories, code architecture, Git history, dependencies, and developer insights.

> **Status: early development.** The repository contains the monorepo, CI checks, design documents,
> a local, read-only GitHub sign-in, and a Repository Overview dashboard (statistics, a language
> chart, search, filters and a detail panel) built from your real accessible repositories. Deeper
> visualizations (architecture, commits, pull requests, issues, workflows) are **not implemented
> yet**, and nothing is deployed.

## Vision

One free web application where any GitHub user can understand their whole GitHub environment, with
the right visualization for each feature:

1. Account-level universe graph
2. Repository architecture and file explorer
3. Branches, commits, merges and PR networks
4. Issues and collaboration
5. Code dependencies and relationships
6. GitHub Actions workflows
7. Personal contribution and activity insights
8. More GitHub features over time

## Principles

- **Read-only.** The app never writes to GitHub.
- **Your data stays between you and GitHub.** Private repository data flows from GitHub to your
  browser using your own token; our backend never reads it. See [PRIVACY.md](./PRIVACY.md) and
  [SECURITY.md](./SECURITY.md).
- **Free.** GitHub Pages for the frontend, Render Free for a tiny stateless auth backend.
- **No AI integration** in the initial version.

## Repository layout

| Path              | Purpose                                                                                                  |
| ----------------- | -------------------------------------------------------------------------------------------------------- |
| `apps/web`        | React + Vite single-page app (target: GitHub Pages)                                                      |
| `apps/api`        | Hono API, future stateless auth broker (target: Render Free)                                             |
| `packages/shared` | Zod schemas and types shared by web and API                                                              |
| `docs/`           | [Architecture](./docs/ARCHITECTURE.md), [Phase 0 assessment](./docs/phase-0-assessment.md), ADRs, spikes |

## Quick start

Requirements: **Node 24** (see `.nvmrc`) and npm 11.

```bash
npm ci
```

Run the API (terminal 1):

```bash
npm run dev:api        # http://127.0.0.1:8787/health
```

Run the web app (terminal 2):

```bash
npm run dev:web        # http://localhost:5173
```

The web page shows "API online" when it can reach the API's `/health` endpoint.

Run everything CI runs:

```bash
npm run check
```

Production-style run:

```bash
npm run build
npm run start -w @gvu/api         # node apps/api/dist/index.js
npm run preview -w @gvu/web       # http://localhost:4173
```

## Documentation

- [Architecture](./docs/ARCHITECTURE.md): what exists today vs. what is planned
- [Phase 0 assessment](./docs/phase-0-assessment.md): requirements, API mapping, security, roadmap
- [ADR 0001](./docs/adr/0001-auth-broker-and-direct-github-access.md): auth broker decision
- [ADR 0002](./docs/adr/0002-typescript-version.md) and the
  [TypeScript 7 spike](./docs/spikes/typescript-7-compatibility.md)
- [Contributing](./CONTRIBUTING.md) · [Security](./SECURITY.md) · [Privacy](./PRIVACY.md)

## License

[MIT](./LICENSE)
