# Phase 0 Assessment

- **Date:** 2026-10-27
- **Status:** Approved at the time of Phase 0. This is a **historical record**. The repository has
  moved on; see the [status review of 2026-10-28](#status-review-2026-10-28) before relying on
  anything below as current.
- **Scope:** Planning and repository inspection only. Nothing in this document is implemented
  unless stated in [ARCHITECTURE.md](./ARCHITECTURE.md).
- **Amended 2026-10-27 (after the Phase 2 spike):** this document is kept as a historical record
  of the assessment, with targeted corrections where later decisions superseded it. Corrected
  passages are marked _(amended)_. **Where this document differs from
  [ARCHITECTURE.md](./ARCHITECTURE.md) or
  [ADR 0001](./adr/0001-auth-broker-and-direct-github-access.md), those two take precedence.**
  _(Status 2026-10-28: the original sentence "Nothing described here as sign-in, token handling or
  the broker exists in code yet" is no longer true. Sign-in, token handling and the broker are now
  implemented and mock-tested; see S2 below.)_

Legend: ✅ verified from official documentation or the npm registry · ⚠️ assumption or needs a
spike · 📌 recommendation.

**Decisions made after this assessment**

| Question          | Decision                                                                                                                                        |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Package manager   | npm workspaces                                                                                                                                  |
| TypeScript        | **6.0.3** (stable). TypeScript 7 deferred; see [spike](./spikes/typescript-7-compatibility.md) and [ADR 0002](./adr/0002-typescript-version.md) |
| Foundation commit | Left uncommitted on `chore/foundation` for review _(status 2026-10-28: since merged; see S1)_                                                   |
| D1 (Phase 2)      | Short-lived access token in `sessionStorage` only; refresh token never stored in the browser or returned to the frontend                        |
| D2 (Phase 2)      | GitHub App permissions: Metadata, Contents, Pull requests, Issues, Actions, all read-only; nothing else                                         |
| D3 (Phase 2)      | The GitHub App is owned by the `VisUniverseG` organization                                                                                      |

---

## Status review (2026-10-28)

This review was added on 2026-10-28 and **does not change the original assessment**. Sections 1 to
15 below still describe Phase 0 as written (with the earlier _(amended)_ corrections). Where a
passage is now outdated, the table below says so, and a few passages carry an inline
_(status 2026-10-28)_ marker. Current facts are in [ARCHITECTURE.md](./ARCHITECTURE.md),
[ADR 0001](./adr/0001-auth-broker-and-direct-github-access.md#implementation-status-2026-10-28),
[SECURITY.md](../SECURITY.md) and [PRIVACY.md](../PRIVACY.md).

The ✅ in this document means "stated in official documentation or the npm registry". It does
**not** mean that the behaviour was observed against GitHub by this project.

Terms used in the table:

- **Implemented:** present in the code, checked against the source.
- **Mock or local tests:** covered by automated tests that use fake GitHub responses. This shows the
  code behaves as designed, not how real GitHub behaves.
- **Verified live:** observed against real GitHub and recorded in this repository.
- **Assumption:** depends on GitHub behaviour or settings that the repository cannot show.

| ID  | Phase 0 statement (section)                                                                                                  | Status on 2026-10-28                                                                                                                                                                                                                                                                                                                                     |
| --- | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | Foundation implemented on `chore/foundation` and "left uncommitted" (header, decisions table, §15)                           | **Outdated.** The repository history contains merge commits for pull requests #1 to #4: the foundation, the repository overview, the architecture view and large-repository loading.                                                                                                                                                                     |
| S2  | "Nothing … as sign-in, token handling or the broker exists in code yet"; "No authentication code exists today" (header, §15) | **Outdated.** Implemented: the broker (`POST /auth/token`, `POST /auth/revoke`, `GET /health`), PKCE sign-in, `sessionStorage` token, disconnect with revocation. _Mock or local tests:_ yes. _Verified live:_ not as recorded evidence (see S3).                                                                                                        |
| S3  | The spike harness "has not been run against a real GitHub App" (§6 item 2, §14, §15)                                         | **Partly outdated.** Only the anonymous checks `ANON-01` to `ANON-03` have been run live, per [ADR 0001](./adr/0001-auth-broker-and-direct-github-access.md#implementation-status-2026-10-28). No account-dependent check has been run, and the status of U1 to U11 is unchanged. The offline harness tests now also run in `npm test`.                  |
| S4  | Diagram (§3): IndexedDB cache, "REST + GraphQL", Render and Pages as the hosts                                               | **Not implemented.** There is no IndexedDB or any cache, and no GraphQL; the app uses REST `GET` only. Nothing is deployed, and the repository has no Pages deploy workflow or `render.yaml`.                                                                                                                                                            |
| S5  | One wrapper that allows only `GET` and GraphQL `query`, enforced by "a unit test and lint rule" (§6 item 3, §12, §13)        | **Partly implemented.** `githubGet` is the only code that calls `api.github.com`, and it sends only `GET`. Mock tests at each call site assert `GET` requests to `api.github.com`. There is **no lint rule**, **no global test** that fails on any other method, and no GraphQL.                                                                         |
| S6  | Per-user IndexedDB cache keys, cleared on logout (§6 item 4, §13)                                                            | **Not implemented.** Repository data lives in React state in memory only.                                                                                                                                                                                                                                                                                |
| S7  | "Strict CSP, no third-party scripts" (§6 item 5)                                                                             | **Implemented as a build-time `<meta>` CSP** (`connect-src` limited to the API origin and `api.github.com`). `npm run dev` has none. Unit tests cover the policy builder. Enforcement in real browsers is **not verified**.                                                                                                                              |
| S8  | Token hygiene and revocation through the broker (§6 item 6)                                                                  | **Implemented and mock-tested.** The browser clears its session first, then asks the broker to revoke, and reports revocation only if GitHub confirmed it. Real revocation is **not verified live**; if it fails, the token stays valid until it expires. The 8-hour lifetime is GitHub's documented figure, not measured by us.                         |
| S9  | The GitHub App, its permissions (D2), and "register two apps" (§5)                                                           | **Not verifiable from the repository.** [ARCHITECTURE.md](./ARCHITECTURE.md) reports an app was created and installed with credentials kept locally. Its permissions and settings are an **assumption**. The code uses only Metadata and Contents; Pull requests, Issues and Actions are unused today.                                                   |
| S10 | Feature-to-API mapping (§7)                                                                                                  | **Plan, mostly not implemented.** The only endpoints called are `GET /user`, `/user/installations`, `/user/installations/{id}/repositories`, `/repos/{owner}/{repo}`, `.../branches/{branch}` and `.../git/trees/{sha}`. No GraphQL, ETag or 304 caching, statistics or events. The truncated-tree fallback exists (mock-tested, **not verified live**). |
| S11 | Visualization libraries (§8)                                                                                                 | **Not adopted so far.** None of the listed libraries is a dependency. The treemap in the architecture view is in-house code. The `elkjs` licence warning remains valid.                                                                                                                                                                                  |
| S12 | MVP v0.1 scope (§10) and roadmap phases (§11)                                                                                | **Partly done, and the numbering diverged.** Sign-in/out and a repository list and detail exist. The account universe graph, a rate-limit meter and a cache do not. [ARCHITECTURE.md](./ARCHITECTURE.md) numbers the work differently (Phase 3 auth, Phase 4 overview, Phases 5 and 6 architecture view); read §11 as the original plan only.            |
| S13 | Testing strategy (§12): MSW, Playwright E2E, secret scanning, performance fixtures                                           | **Planned, not present.** Tests use Vitest, Testing Library and jsdom with an injected fake `fetch`. There is no MSW, Playwright, secret scanning or performance fixture. The CSP, licence and `npm audit` checks do exist (`npm test`, CI).                                                                                                             |
| S14 | Risk mitigations (§13)                                                                                                       | **Mixed.** Implemented and mock-tested: exact origin and `redirect_uri` allow-lists, request validation, `state` plus PKCE `S256`, no logging of request contents. **Not implemented:** broker rate limiting (required before any public deployment), secret scanning in CI, a PR template, a cache to wipe.                                             |
| S15 | Gap analysis and deployment (§2, §9)                                                                                         | **Still open in the repository:** Pages and Render deployment, Dependabot, issue and PR templates, a code of conduct, and a `404.html` or router fallback. Settings outside the repository (Pages, Render, branch protection) cannot be verified from it.                                                                                                |
| S16 | §14 "Verified" list and the spike table                                                                                      | **Still accurate as a record of documentation-based facts.** The spike-table statuses are unchanged: nothing there has been resolved since Phase 2. No router exists; the `/auth/callback` path is matched by comparing the page address, which does not settle spike item 10 for production.                                                            |

**Update 2026-10-29 (to S9 above):** the S9 row is kept as written. Its last sentence, "The code
uses only Metadata and Contents; Pull requests, Issues and Actions are unused today", dates from
2026-10-28. Since then the Activity view reads the pull request list
(`GET /repos/{owner}/{repo}/pulls`), which is expected to need Pull requests (read), so that
permission is **no longer unused**; Issues and Actions still are. Whether GitHub requires exactly
that permission has not been checked against a live token. The maintainer reports that the
permission is enabled and that the list loaded in their own browser; the repository cannot show
either. Current facts are in [ARCHITECTURE.md](./ARCHITECTURE.md).

**Still valid and not contradicted by the repository:** the Phase 0 findings on the empty starting
state (§1), the choice of a GitHub App with a thin broker and direct browser access (§3, §5), the
technology versions in §4 (they match `package-lock.json`), the GitHub documentation facts and
limits in §5, §7 and §9, the `elkjs` licence flag (§8), and the security risk list in §13 as a list
of risks. Nothing in the repository contradicts them. They have not been re-checked against
GitHub's live documentation.

---

## 1. Existing repository analysis (at the start of Phase 0)

| Item                 | Finding                                                                                                |
| -------------------- | ------------------------------------------------------------------------------------------------------ |
| Git root             | `.../visuals/github-visual-universe/` (the parent folder opened in Cursor is **not** a Git repository) |
| State                | **Empty.** One commit (`Initial commit`) on `main`, tracking `origin/main`                             |
| Tracked files        | `LICENSE` (MIT, "Copyright (c) 2026 VisUniverseG") and a 2-line `README.md`                            |
| Remote               | `git@github-personal:VisUniverseG/github-visual-universe` (SSH host alias)                             |
| Remote metadata      | Public, MIT, default branch `main`, issues enabled                                                     |
| Frontend and backend | None: no `package.json`, config, CI, `.gitignore`, docs, or source                                     |

## 2. Gap analysis

| Area       | Missing at the start                                                         |
| ---------- | ---------------------------------------------------------------------------- |
| Docs       | README, architecture, security, contributing, privacy, ADRs, roadmap         |
| Config     | `.gitignore`, `.editorconfig`, `.nvmrc`, `.env.example`, lint/format config  |
| Code       | Monorepo scaffold, frontend, backend, shared types, tests                    |
| CI/CD      | CI workflow, Pages deploy workflow, Render blueprint, dependency-update bot  |
| GitHub     | No GitHub App registered (dev or prod), Pages not enabled, no Render service |
| Governance | `CODE_OF_CONDUCT`, issue and PR templates, branch protection                 |

Phase 1, Step 1 closes the Docs, Config, Code (scaffold only) and CI (checks only) gaps. The rest
remains open.

## 3. Proposed architecture

```
┌────────────────────────┐   1. authorize (PKCE+state)   ┌──────────────┐
│ SPA (React, static)    │──────────────────────────────▶│ github.com   │
│ GitHub Pages           │◀───────── code ───────────────│ OAuth        │
│                        │                               └──────────────┘
│ - sessionStorage token │   2. POST code+verifier       ┌──────────────┐
│ - IndexedDB cache      │──────────────────────────────▶│ Auth broker  │
│ - viz + analysis       │◀──── access token (8h) ───────│ Render Free  │
│                        │                               │ (holds secret)│
│                        │   3. data calls (CORS)        └──────────────┘
│                        │──────────────────────────────▶ api.github.com
└────────────────────────┘     Bearer user token         (REST + GraphQL)
```

_(Status 2026-10-28: this is the Phase 0 target. Today there is no IndexedDB cache and no GraphQL,
and nothing is deployed; see S4 and S6.)_

📌 **Core decision: a thin auth broker plus direct-to-GitHub data fetching** (see
[ADR 0001](./adr/0001-auth-broker-and-direct-github-access.md)).

- ✅ `api.github.com` supports CORS from any origin, so the browser can call it directly.
- ✅ GitHub's token endpoint does not support CORS preflight, so the client-secret exchange needs a
  server.
- ✅ Render Free spins down after 15 minutes idle and takes about 1 minute to wake. Only login and
  logout (token revocation) pay that cost, not data views. _(amended: refresh is not used in v1)_
- ✅ Render may suspend free services with high service-initiated traffic and counts outbound
  bandwidth against a quota. Proxying every GitHub call through Render would waste both.
- The broker never reads repository data: the browser fetches it directly from GitHub. _(amended)_
  The broker does handle credentials **in transit** (the code, verifier and token) and holds the
  client secret, but stores no user credentials at rest.

**Browser-only login is not usable yet.** The GitHub roadmap item "Single page app support for
GitHub Apps" (`github/roadmap#1153`) would allow secret-free PKCE with CORS, but it is labelled
**Preview** and **Paused** and is absent from the official token docs. Do not depend on it. ⚠️ It
could replace the broker later.

## 4. Technology decisions

Versions are the pinned versions in the repository (`package-lock.json` is committed to the working
tree).

| Layer           | Choice                                                            | License    |
| --------------- | ----------------------------------------------------------------- | ---------- |
| Monorepo        | npm workspaces                                                    | n/a        |
| Language        | TypeScript **6.0.3** (7.x deferred)                               | Apache-2.0 |
| Frontend        | React 19.3.1 + Vite 8.3.5                                         | MIT        |
| Backend         | Hono 4.13.14 on Node 24 (`@hono/node-server` 2.1.5)               | MIT        |
| Validation      | Zod 4.6.7 (shared contracts)                                      | MIT        |
| Tests           | Vitest 5.0.5, Testing Library, jsdom                              | MIT        |
| Lint and format | ESLint 10.13.0 + typescript-eslint 8.72.1 + Prettier 3.9.10       | MIT        |
| Planned later   | React Router, TanStack Query, Zustand, Tailwind, `idb`, `octokit` | MIT / ISC  |

GitHub Pages notes:

- ✅ A project site is served at `visuniverseg.github.io/github-visual-universe/`, so Vite `base`
  must be `/github-visual-universe/` for that build (`VITE_BASE_PATH`).
- ✅ Pages has no rewrite rules. Use a `404.html` fallback or `HashRouter` (📌 `HashRouter` first).
- ✅ Pages limits: 1 GB site size, soft 100 GB/month bandwidth, 10-minute deploy timeout. Pages must
  not be used for commercial SaaS; this free open-source project is within the terms.

## 5. GitHub authentication and authorization strategy

### Why a GitHub App, not an OAuth App

All ✅ from GitHub's "Deciding when to build a GitHub App":

- Fine-grained, read-only permissions instead of the broad `repo` scope (an OAuth App's `repo`
  scope can write).
- The user chooses which repositories the app may see.
- Tokens are short-lived: 8 hours, plus a 6-month refresh token.

### Verified token behaviour

- ✅ A user access token (`ghu_…`) can access only what **both** the user and the app can access.
- ✅ GitHub Apps get implicit read access to public resources when acting on behalf of a user, even
  where the app is not installed.
- ✅ An app does not need to be installed for a user to authorize it.
- ✅ For private repositories, the app must be installed on the owning account and granted that
  repository.
- ✅ `GET /user/installations` and `GET /user/installations/{id}/repositories` show what a user
  token can reach.
- ✅ User access tokens share the user's 5,000/hour limit with all other tokens and apps for that
  user.

### Product consequence (UX-critical)

A user completes two separate steps: **authorize** (sign in) and **install** (grant private
repositories). Organization private repositories also need an org owner to approve the installation,
and SAML-protected orgs need an active SAML session. The UI must explain this plainly.

### Recommended flow

1. The SPA generates `state` and a PKCE `code_verifier`/`code_challenge` (✅ `S256` is the only
   supported method).
2. The SPA redirects to `github.com/login/oauth/authorize`.
3. GitHub redirects back with `code`.
4. The SPA POSTs `code`, `code_verifier` and `redirect_uri` to the broker.
5. The broker adds `client_secret`, calls `/login/oauth/access_token`, and returns **only the access
   token and its lifetime**. It discards the refresh token, stores no user credentials at rest, and
   logs no sensitive content. It does handle the code and token in transit. _(amended)_
6. The SPA keeps the **access token only** in `sessionStorage` and calls GitHub directly. On
   sign-out the broker revokes the token, because revocation needs the client secret. _(amended;
   originally "in memory only")_

### Token lifetime tradeoff

| Option                                                                                 | Tradeoff                                                                                                                     |
| -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 📌 v1 (adopted, D1): the broker discards the refresh token; re-run authorize on expiry | No long-lived secret in the browser; stateless broker; users bounce through GitHub about every 8 hours                       |
| Not adopted: broker returns a server-sealed (encrypted) refresh token                  | Fewer redirects; an XSS attacker could still ask the broker to use the blob, so only slightly safer ⚠️. Rejected in ADR 0001 |
| Not recommended: httpOnly cookie set by the broker                                     | `github.io` and `onrender.com` are different sites; third-party-cookie blocking is likely ⚠️                                 |

### Permissions to request (all read-only)

Metadata (mandatory), Contents, Pull requests, Issues, Actions, **all read-only (D2)**. No write
permissions, no webhooks, no email, no org-admin permissions, and no account permissions (including
starring). _(amended: the earlier optional Checks, Commit statuses and Dependabot alerts are **not**
requested. Adding any permission later forces re-approval at every installation, so it needs an
explicit decision.)_ 📌 Register two apps, both owned by the `VisUniverseG` organization (D3): `-dev`
(localhost callback) and `-prod`. Each must be visible to "Any account" so non-owners can install it.

## 6. Public/private repository security model

**Intended boundary _(amended)_: the backend never reads repository data and stores no user
credentials at rest. It does handle credentials in transit.** The original wording ("the backend
holds no credential that can read private data") was too strong: the broker holds the client secret
and sees tokens while a request is in flight. This is an intended boundary, not an absolute
guarantee; see [ADR 0001](./adr/0001-auth-broker-and-direct-github-access.md).

1. The broker never uses installation tokens, PATs, or a private key. It only swaps `code` for a
   token, returns the access token to the same user, and discards the refresh token.
2. All GitHub data calls use the user's own token, directly from the authenticated browser. GitHub is
   expected to limit that token to the intersection of what the user and the app can access, and our
   code adds no cross-user path. _(amended: this is a design intent that relies on GitHub
   enforcement and on controls still to be built, not a structural guarantee. The authorization
   spike harness exists to check it with real accounts and has not yet been run.)_ _(Status
   2026-10-28: still true for account checks; only the anonymous `ANON-01` to `ANON-03` have been
   run live. See S3.)_
   Private repository access additionally requires the app to be **installed on the owning account
   with that repository granted**; authorizing alone is not enough.
3. Read-only at three layers: read-only GitHub App permissions; one API wrapper that allows only
   `GET` and GraphQL `query`; a unit test and lint rule enforcing that wrapper. _(Status
   2026-10-28: partly implemented; there is no lint rule and no GraphQL. See S5.)_
4. Per-user cache keys (`userId:host:path`) in IndexedDB, cleared on logout and user change.
   _(Status 2026-10-28: not implemented; see S6.)_
5. No telemetry or analytics with repository content. Strict CSP, no third-party scripts, reviewed
   lockfile. _(amended: a `<meta>` CSP is a **prerequisite** before any authentication code is
   implemented, not something added alongside it.)_
6. Token hygiene: never in URLs, logs, `localStorage` or error reports. Revoke on logout, **through
   the broker**. _(amended)_ The access token is kept in `sessionStorage`, which does **not**
   eliminate XSS risk; neither would memory-only storage.

## 7. Feature-to-API mapping

"UAT" = user access token. Endpoints below are listed as UAT-capable read endpoints in GitHub's
"Permissions required for GitHub Apps" (✅).

| #   | Feature                             | Endpoints                                                                                                                            | Permission              |
| --- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------- |
| 1   | Account universe graph              | GraphQL `viewer.repositories`, `organizations`, `languages`, `topics`; `GET /user/repos`; `GET /user/installations`                  | Metadata                |
| 2   | Repo architecture and explorer      | `git/trees/{sha}?recursive=1`, `contents`, `git/blobs`, `languages`, `readme`                                                        | Contents                |
| 3   | Branches, commits, merges, PR graph | `branches`, `commits`, `compare`, `pulls`, `pulls/{n}/commits`, `commits/{sha}/pulls`; GraphQL `history` with `parents`              | Contents, Pull requests |
| 4   | Issues and collaboration            | `issues`, `issues/{n}/timeline`, `comments`, `events`, sub-issues, dependencies                                                      | Issues, Pull requests   |
| 5   | Code dependencies                   | Package level: `dependency-graph/sbom`. Source level: **no API exists** ⚠️ (parse fetched files client-side)                         | Contents                |
| 6   | GitHub Actions workflows            | `actions/workflows`, `workflows/{id}/runs`, `runs/{id}/jobs`, `runs/{id}/timing`; workflow YAML via contents                         | Actions, Contents       |
| 7   | Personal contributions and activity | GraphQL `contributionsCollection`; `stats/commit_activity`, `stats/punch_card`, `stats/contributors`; `GET /users/{u}/events`        | Metadata                |
| 8   | Stars, releases, forks              | `GET /user/starred` _(needs the Starring account permission, **not requested** under D2)_, `releases`, `forks`, `stargazers/history` | Metadata, Contents      |

Verified caveats:

- ✅ Recursive git trees are capped at **100,000 entries / 7 MB** and return `truncated: true`
  beyond that; fall back to per-folder fetching.
- ✅ Statistics endpoints return **202** on a cache miss (retry), and some fail with 422 for
  repositories with 10,000+ commits.
- ✅ The Events API covers only the last **30 days** (max 300 events), so the contribution calendar
  must come from GraphQL.
- ✅ Private-repo contributions appear only as an anonymous `restrictedContributionsCount`, and only
  if the user enabled private contribution counts.
- ✅ Authenticated conditional requests answered with 304 do not count against the primary rate
  limit, so cache with ETags.
- ✅ Secondary limits: at most 100 concurrent requests and 900 REST points/minute per endpoint. Cap
  client concurrency at roughly 6–10.

## 8. Visualization library mapping

All licenses ✅ from the npm registry.

| Feature                           | 📌 Primary                                                                        | Alternatives                      |
| --------------------------------- | --------------------------------------------------------------------------------- | --------------------------------- |
| Account universe (large graph)    | Sigma 4 + graphology (+ `forceatlas2`, `louvain`) via `@react-sigma/core`         | `react-force-graph-2d`, Cytoscape |
| Repo structure / file explorer    | `d3-hierarchy` (treemap, sunburst) + `react-arborist` + `@tanstack/react-virtual` | ECharts treemap                   |
| Commit DAG / branch graph         | Custom SVG or canvas lane layout on `d3`                                          | `@xyflow/react`                   |
| PR network, architecture diagrams | `@xyflow/react` + `@dagrejs/dagre`                                                | Mermaid                           |
| Timelines, charts                 | Apache ECharts 6                                                                  | Recharts, Observable Plot         |
| Contribution heatmap              | `@uiw/react-heat-map` or custom d3                                                | `cal-heatmap`                     |
| Dependency graphs                 | Sigma (large) or React Flow (small)                                               | Cytoscape                         |
| Source parsing (later)            | `web-tree-sitter` + `tree-sitter-wasms`, or `oxc-parser`/`acorn` for JS/TS        | `es-module-lexer`                 |

**License flag:** `elkjs` is `EPL-2.0 OR GPL-3.0-or-later`; 📌 avoid it and use dagre. The CI
license gate fails on unexpected licenses.

## 9. Free hosting and deployment feasibility

| Component   | Host                                      | Verified limits                                                                                            | Verdict                     |
| ----------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------- | --------------------------- |
| Frontend    | GitHub Pages (deployed by GitHub Actions) | ✅ 1 GB, 100 GB/month soft, project-site base path                                                         | ✅ Feasible                 |
| Auth broker | Render Free web service                   | ✅ Sleeps after 15 min idle (~1 min wake), 750 free hours/month, ephemeral filesystem, may restart anytime | ✅ Feasible for 10–20 users |

- Cold start only affects login and logout (revocation). Show a "waking server" state and pre-warm
  with `/health` before redirecting to GitHub. _(amended)_
- Stateless by design: no database, sessions or disk. Do not use Render's free Postgres (expires
  after 30 days) or Key Value (in-memory only).
- Do not keep it awake with an external pinger.
- CORS: only the Pages origin, plus `localhost` in dev.
- ⚠️ Contingency: Hono makes porting to a serverless runtime straightforward if Render's free tier
  changes. Other providers' limits are unverified.
- Cost: ₹0. No custom domain.

## 10. Feature catalogue

- **v0.1 (MVP):** sign in/out, account universe graph, repository list and detail, read-only
  guarantee, rate-limit meter, cache.
- **v0.2:** repo explorer (tree, treemap), language and size insights.
- **v0.3:** commit and branch graph, PR list and network.
- **v0.4:** issues and collaboration views, contribution and activity dashboard.
- **v0.5:** Actions workflow visualization, package dependency graph from SBOM.
- **v0.6+:** source-level import graphs, starred/followed network, release timeline, org-wide views,
  shareable public-repo cards, accessibility and theme polish.

## 11. Development roadmap

_(Status 2026-10-28: this is the original Phase 0 plan. Phase numbers and scope in the repository's
other documents differ; see S12.)_

| Phase | Goal                                                              | Exit criteria                                                                                                                      |
| ----- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 0     | Assessment (this document)                                        | Approved ✅                                                                                                                        |
| 1     | Repo foundation: docs, tooling, monorepo, CI, `.gitignore`        | CI green, empty apps build 🚧 (Step 1 done)                                                                                        |
| 2     | Spikes: the ⚠️ items below                                        | Written findings, ADRs. Research done; the harness is prepared but **not yet run** against a real app (see section 14)             |
| 3     | Auth: CSP first, then dev GitHub App, broker, PKCE login          | CSP in place **before** auth code; real sign-in locally, access token in `sessionStorage` only, refresh token never in the browser |
| 4     | Read-only API layer: wrapper, cache, throttling, rate-limit meter | Tests prove no write calls                                                                                                         |
| 5     | Account universe MVP                                              | Usable graph for a real account                                                                                                    |
| 6     | Repository explorer                                               | Handles truncated trees                                                                                                            |
| 7     | Git and PR graphs                                                 |                                                                                                                                    |
| 8     | Issues and Actions                                                |                                                                                                                                    |
| 9     | Contributions and insights                                        |                                                                                                                                    |
| 10    | Dependencies                                                      |                                                                                                                                    |
| 11    | Deploy: Pages + Render, prod GitHub App                           | Live with 10–20 users                                                                                                              |
| 12    | Hardening, docs, accessibility                                    |                                                                                                                                    |

## 12. Testing strategy

- **Unit (Vitest):** API wrapper (rejects mutations and non-GET), PKCE/state helpers, per-user cache
  keys, graph builders, rate-limit and backoff logic.
- **Integration (MSW):** mocked GitHub REST/GraphQL including 202 stats, truncated trees, 304,
  403/429, and expired tokens.
- **Broker tests:** code exchange with mocked GitHub, CORS allow-list, no secret logging, malformed
  input.
- **E2E (Playwright):** login redirect with a stubbed GitHub, graph rendering, logout clears
  storage.
- **Security checks:** a test failing on any non-GET request to `api.github.com`, CSP check,
  `npm audit`, license check, secret scanning.
- **Manual spikes** against real GitHub with two test accounts (one with private repos, one
  without) to confirm isolation.
- **Performance:** fixture graphs of 500, 2,000 and 10,000 nodes.

## 13. Security risks and mitigations

| Risk                                                                                 | Mitigation                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| XSS steals the access token _(amended)_                                              | Strict `<meta>` CSP **before** auth code, no third-party scripts, sanitize rendered content; `sessionStorage` and memory-only storage both remain exposed to XSS, so the token is read-only, lasts at most 8 hours and is revoked on sign-out |
| Compromised broker deployment captures tokens in transit _(added)_                   | Tiny code surface, no body logging, exact-origin and `redirect_uri` allow-lists, pinned dependencies, protected deploy credentials. Mitigated, not eliminated                                                                                 |
| "Request user authorization during installation" bypasses `state` and PKCE _(added)_ | Keep that GitHub App setting disabled; never trust the Setup URL's `installation_id` on its own                                                                                                                                               |
| Client secret leak                                                                   | Only in Render env vars, never in repo or frontend, `.gitignore`, secret scanning, rotate on exposure                                                                                                                                         |
| Open redirect or CSRF in OAuth                                                       | `state` check, PKCE `S256`, exact callback URL                                                                                                                                                                                                |
| Broker abuse                                                                         | CORS allow-list, rate limiting, payload validation; a code is useless without the verifier                                                                                                                                                    |
| Cross-user cache leakage on a shared machine                                         | Per-user cache keys, wipe on logout                                                                                                                                                                                                           |
| Accidental write calls                                                               | Read-only app permissions + guarded wrapper + tests                                                                                                                                                                                           |
| Over-requested permissions                                                           | Minimum read-only set, reviewed in the PR template                                                                                                                                                                                            |
| Rate-limit exhaustion or secondary-limit ban                                         | Throttling, ETag caching, concurrency cap, backoff on `retry-after`                                                                                                                                                                           |
| Malicious repo content (huge files, markdown, ReDoS)                                 | Size caps, parse in a Web Worker, timeouts, sanitize before any HTML rendering                                                                                                                                                                |
| Supply-chain compromise                                                              | Lockfile, reviewed install scripts, minimal dependencies, license and audit gates                                                                                                                                                             |
| Privacy expectations                                                                 | Publish a clear [privacy statement](../PRIVACY.md)                                                                                                                                                                                            |
| Render outage or cold start                                                          | Clear UI states; data layer still works while the broker sleeps (unless the token expires)                                                                                                                                                    |

## 14. Verified vs. still to investigate

**Verified (official docs / registry):** user-token access intersection; implicit public read;
8-hour tokens and 6-month refresh tokens; client secret required for the token request; REST CORS
open to all origins; rate limits; stats, tree and events limits; Render Free and Pages limits;
library versions and licenses.

**Needs a spike (Phase 2):** _(amended with the Phase 2 outcome; **U1 to U11** are tracked in
[ADR 0001](./adr/0001-auth-broker-and-direct-github-access.md#unresolved-behaviour-not-yet-verified))_

| #   | Question                                                                      | Status after Phase 2                                                                                                                                                                |
| --- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Private-repo contribution detail through GraphQL for a GitHub App user token? | **Unresolved (U2).** Harness check `ACC-11`, not yet run                                                                                                                            |
| 2   | Actions endpoints for public repos where the app is not installed?            | **Unresolved (U7).** Harness checks `ACC-06`, `ACC-08`, not yet run                                                                                                                 |
| 3   | Does Contents read cover `.github/workflows/*.yml`?                           | **Unresolved (U7).** Harness check `ACC-06`, not yet run                                                                                                                            |
| 4   | Does `ETag` pass through CORS and do 304s work from the browser?              | **Partly resolved.** Headers are exposed (anonymous observation, not contractual). Real 304 and rate-limit cost **unresolved** (harness `ACC-09`); browser-enforced CORS unresolved |
| 5   | Bulk file fetch: GraphQL blob batching vs. tarball CORS                       | Not addressed in Phase 2. Open                                                                                                                                                      |
| 6   | Organization flow: install approval and SAML behaviour in practice            | Documented in official docs; real behaviour **unresolved** (U8, plus manual organization checks)                                                                                    |
| 7   | Does a localhost HTTP callback work for the dev GitHub App?                   | **Resolved from official docs for `localhost`.** A loopback IP with a variable port is **unresolved** (U5)                                                                          |
| 8   | TypeScript 7 compatibility                                                    | Resolved: deferred. See the [spike](./spikes/typescript-7-compatibility.md)                                                                                                         |
| 9   | Practical node limit before Sigma needs worker-based layout                   | Not addressed in Phase 2. Open                                                                                                                                                      |
| 10  | HashRouter vs. a `404.html` fallback with the OAuth callback path             | Open. Callback paths are planned as real static pages; the router decision is pending (U11 also open)                                                                               |

Other Phase 2 items still unresolved: U1 (public repos listed by `GET /user/repos` without an
installation), U3 (token issued before installation), U4 (wildcard callback matching), U6 (token
endpoint response format), U9 (token-minting limits), U10 (authorization code lifetime). The
authorization spike harness (`scripts/spikes/github-auth`, plan in
[`spikes/github-auth-harness.md`](./spikes/github-auth-harness.md)) is prepared and tested offline
but has **not been run against a real GitHub App**. _(Status 2026-10-28: only the anonymous checks
`ANON-01` to `ANON-03` have been run live; no account-dependent check has. See S3.)_

## 15. Recommended next step (as of Phase 0)

Phase 1, Step 1: repository foundation (docs, tooling, scaffolds, CI checks) with no authentication
and no feature code. **Done on `chore/foundation`, uncommitted.** _(Status 2026-10-28: outdated; see
S1.)_

_(amended)_ Phase 2 research is complete and its decisions are recorded in
[ADR 0001](./adr/0001-auth-broker-and-direct-github-access.md). The next gates before any
authentication code are: a `<meta>` Content Security Policy, the router decision, and running the
spike harness against a development GitHub App. No authentication code exists today. _(Status
2026-10-28: outdated. Authentication code now exists (S2), and a `<meta>` CSP is in place (S7). The
router decision is still pending, and the account-dependent harness checks have still not been run
(S3, S16).)_
