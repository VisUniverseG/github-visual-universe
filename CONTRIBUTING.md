# Contributing

Thanks for your interest in GitHub Visual Universe! This project is free and open source (MIT).

## Ground rules

These are non-negotiable project constraints:

- **Read-only.** No write operations to GitHub: no issue/PR creation, repository changes, or write
  permissions.
- **No secrets in the repository.** Never commit real credentials. Use `.env.example` placeholders.
- **No paid services or dependencies.** The project must run on free tiers (GitHub Pages, Render
  Free).
- **No AI features** in the initial version.
- **Do not change the agreed architecture silently.** Propose significant changes through an ADR in
  `docs/adr/`. See [ADR 0001](./docs/adr/0001-auth-broker-and-direct-github-access.md).

## Prerequisites

- macOS or Linux
- Node.js **24** (see `.nvmrc`; with nvm: `nvm use`)
- npm **11** (ships with Node 24)

## Setup

```bash
git clone https://github.com/VisUniverseG/github-visual-universe.git
cd github-visual-universe
nvm use          # optional, picks Node 24 from .nvmrc
npm ci           # installs all workspaces from the lockfile
```

## Everyday commands

| Command                  | What it does                                                                |
| ------------------------ | --------------------------------------------------------------------------- |
| `npm run dev:api`        | API on http://127.0.0.1:8787 (builds `@gvu/shared` first)                   |
| `npm run dev:web`        | Web on http://localhost:5173 (builds `@gvu/shared` first)                   |
| `npm run check`          | Everything CI runs locally (format, lint, typecheck, test, build, licenses) |
| `npm run format`         | Format with Prettier                                                        |
| `npm run lint`           | ESLint (type-aware)                                                         |
| `npm run typecheck`      | `tsc` in every workspace                                                    |
| `npm test`               | Vitest in every workspace, then the offline spike-harness tests             |
| `npm run test:spikes`    | Only the offline spike-harness tests (no credentials, no internet)          |
| `npm run build`          | Build shared, API and web                                                   |
| `npm run licenses:check` | Fail on unreviewed dependency licenses                                      |
| `npm run audit:deps`     | `npm audit` at high severity                                                |

Optional local config: copy `apps/api/.env.example` to `apps/api/.env` and/or
`apps/web/.env.example` to `apps/web/.env`. These `.env` files are git-ignored.

## Dependencies

- Versions are **exact-pinned** and `package-lock.json` is committed. Install with
  `npm install <pkg>@<version> -w <workspace>`.
- Before adding a dependency, check its license (the CI license gate must pass), maintenance status
  and `npm audit` result. Prefer fewer, well-maintained packages.
- If a package has an install script, review it before approving it
  (`npm approve-scripts <pkg>`; this records it in `allowScripts`).
- **TypeScript is pinned to 6.0.3** because `typescript-eslint` does not support 7 yet; see
  [ADR 0002](./docs/adr/0002-typescript-version.md).

## Pull requests

1. Branch from `main` (for example `feat/…`, `fix/…`, `chore/…`, `docs/…`).
2. Keep changes focused and include tests for behaviour changes.
3. Run `npm run check` before opening the PR.
4. Describe what changed and why, and call out any security-relevant impact (permissions, tokens,
   storage, new network calls).

## Reporting security issues

Please do **not** use public issues. See [SECURITY.md](./SECURITY.md).
