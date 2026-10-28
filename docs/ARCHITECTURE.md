# Architecture

This document separates what **exists today** from what is **planned**. Rationale and verified
facts are in the [Phase 0 assessment](./phase-0-assessment.md); the authentication and data-access
decision (amended after the Phase 2 spike) is recorded in
[ADR 0001](./adr/0001-auth-broker-and-direct-github-access.md), which takes precedence where the two
differ. `PRIVACY.md`, `SECURITY.md` and the Phase 0 assessment have been aligned with both.

## Status

| Component                          | Status                                                                               |
| ---------------------------------- | ------------------------------------------------------------------------------------ |
| npm workspaces monorepo            | ✅ Implemented                                                                       |
| `packages/shared` (contracts)      | ✅ `/health`, auth-broker and GitHub response schemas (Zod, lenient optional fields) |
| `apps/api` (Hono)                  | ✅ `GET /health`, `POST /auth/token`, `POST /auth/revoke`                            |
| `apps/web` (React + Vite)          | ✅ Sign-in (PKCE), Overview dashboard, Architecture view, Disconnect; build-time CSP |
| CI checks                          | ✅ Implemented (not yet run on GitHub)                                               |
| Authentication design              | ✅ Decided (ADR 0001, amended after Phase 2)                                         |
| GitHub authorization spike harness | ✅ Prepared, offline-tested. **Not yet run against a real GitHub App.**              |
| GitHub App registration            | ✅ Created and installed. Credentials are configured locally only.                   |
| Auth broker + sign-in (PKCE)       | ✅ Implemented; manually verified against real GitHub. Automated tests use mocks.    |
| GitHub data layer (read-only)      | 🟡 Repository discovery, `GET /user`, branch head and file tree; the rest is later   |
| Visualizations                     | 🟡 Overview, language chart and file-tree architecture done; the rest (Phases 6–10)  |
| Deployment (Pages + Render)        | ⏳ Planned (Phase 11)                                                                |

## Repository layout

```
.
├── apps/
│   ├── api/            # Hono API (future stateless auth broker). Deploys to Render Free.
│   └── web/            # React + Vite SPA. Deploys to GitHub Pages.
├── packages/
│   └── shared/         # Zod schemas and types shared by web and api (compiled to dist/)
├── docs/               # Assessment, architecture, ADRs, spikes
├── scripts/            # Repo tooling (license gate) and local-only spike harnesses
│   └── spikes/github-auth/   # Read-only authorization spike harness (not part of the product)
└── .github/workflows/  # CI
```

## Target runtime architecture (planned)

```
Browser (SPA on GitHub Pages)
   │  0. GET /health ───────────────▶ Auth broker (pre-warm; Render Free may be asleep)
   │  1. redirect to github.com/login/oauth/authorize  (state + PKCE S256, explicit redirect_uri)
   │  2. POST {code, code_verifier, redirect_uri} ──▶ Auth broker (Render Free, stateless)
   │                                     └─ adds client_secret, exchanges with GitHub,
   │                                        returns {access_token, expires_in} ONLY.
   │                                        The refresh_token is discarded. Nothing is stored.
   │  3. Authorization: Bearer <user access token>   (kept in sessionStorage, access token only)
   ├─────────────────────────────────▶ api.github.com  (REST + GraphQL, read-only, CORS)
   │  4. on logout: POST {access_token} ──▶ Auth broker ──▶ revoke at GitHub (needs client_secret)
```

### Principles

- **The broker never reads GitHub repository data.** It has no installation token, PAT or app private
  key. Repository data never passes through it.
- **The broker handles credentials in transit and holds the client secret, but stores no user
  credentials at rest.** It sees the authorization code, the PKCE verifier and the resulting access
  token while a request is in flight, and nothing is kept afterwards.
- **The authenticated browser calls GitHub directly** for all repository data, using the user's own
  token.
- **Token storage (D1):** only the short-lived access token is kept, in `sessionStorage`. The
  refresh token is never stored in the browser, because the broker never returns it.
- **Token revocation requires the broker**, because revoking needs the client secret.
- **Read-only everywhere:** read-only GitHub App permissions, a single client wrapper permitting only
  `GET` and GraphQL `query`, and tests that enforce it.
- **Static frontend, stateless backend:** no database, sessions or disk (fits Render Free).

## Authentication and data access (planned, decided in ADR 0001)

### GitHub App

| Setting                                        | Value                                                                                       |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Type                                           | GitHub App (not an OAuth App)                                                               |
| Owner (D3)                                     | The `VisUniverseG` organization                                                             |
| Repository permissions (D2)                    | Metadata, Contents, Pull requests, Issues, Actions: **all read-only**                       |
| Other permissions                              | None: no write, no organization administration, no account permissions (including starring) |
| User-token expiration                          | On (8 hours)                                                                                |
| Device flow                                    | Off                                                                                         |
| Request user authorization during installation | **Off** (it bypasses our `state` and PKCE)                                                  |
| Webhook                                        | Inactive                                                                                    |
| Visibility                                     | "Any account" (so non-owners and test accounts can install it)                              |

Adding a permission later forces re-approval at every installation, so the set above is fixed on
purpose. A feature that needs another permission is a decision, not a quiet change.

### URLs

| Purpose                     | Development                              | Production (exact match, trailing slash included)                         |
| --------------------------- | ---------------------------------------- | ------------------------------------------------------------------------- |
| User-authorization callback | `http://localhost:5173/auth/callback`    | `https://visuniverseg.github.io/github-visual-universe/auth/callback/`    |
| Setup URL                   | `http://localhost:5173/install/complete` | `https://visuniverseg.github.io/github-visual-universe/install/complete/` |
| Broker allowed origin       | `http://localhost:5173`                  | `https://visuniverseg.github.io`                                          |

Notes:

- Always pass `redirect_uri` explicitly, built from the app's own origin and base path.
- `http://127.0.0.1:5173/...` is a possible extra dev callback, **unverified** for GitHub Apps (U5).
- The callback and install-complete paths are planned as real static pages so GitHub's redirect gets
  an HTTP 200. The router decision (`HashRouter` or a fallback) is still pending.
- The production hostname casing and query preservation are unverified until Pages is enabled (U11).

### What the broker and the browser each see

| Item                                 | Broker (Render)                       | Browser (SPA)                             |
| ------------------------------------ | ------------------------------------- | ----------------------------------------- |
| Client secret                        | Holds it (environment variable)       | Never                                     |
| Authorization code and PKCE verifier | In transit, one request               | Creates the verifier; receives the code   |
| User access token                    | In transit, once, and on logout       | Holds it in `sessionStorage`              |
| Refresh token                        | In transit from GitHub; **discarded** | Never                                     |
| Repository, issue, PR, Actions data  | Never                                 | Fetches it directly from `api.github.com` |
| User credentials at rest             | None                                  | Access token only, for at most 8 hours    |

### Private repository access

Authorizing the app is not enough. A user sees a private repository only when **both** hold:

1. The user authorized the app.
2. The app is **installed on the account that owns the repository, with that repository granted**
   ("All repositories" or "Only select repositories").

The token then reaches only the intersection of what the user can access and what the app was
granted. Organization repositories may need an owner to install or approve the app, and
SAML-protected organizations need an active SSO session at authorization and installation time. The
UI must detect a missing grant (via `GET /user/installations` and its repository list) and explain
the install step, not show an empty page. The installation id on the Setup URL can be spoofed, so it
is never trusted on its own.

### Token handling

| Concern                 | Decision                                                                                                                    |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| OAuth `state`, verifier | Random from WebCrypto, stored in `sessionStorage`, single-use, deleted before the exchange, expire after about 10 minutes   |
| Callback URL            | `code` and `state` removed from the address bar immediately; `returnTo` limited to internal paths                           |
| Access token            | `sessionStorage`, access token only (D1). Cleared on logout and expiry                                                      |
| Expiry                  | After 8 hours the user re-authorizes. A `401` is never retried (repeated bad credentials can lock the user out temporarily) |
| Logout                  | Call the broker to revoke at GitHub, then clear local state. Local state is cleared even if revocation fails                |
| Broker logging          | Method, path, status and a request id only. Never bodies, codes, verifiers, tokens or `Authorization` headers               |
| Broker CORS             | Exact origin allow-list, `POST` and `Content-Type` allowed, no credentials or cookies, requests from other origins rejected |

### XSS and the token (an honest statement)

`sessionStorage` is readable by any script that runs on our origin, and **memory-only storage would
not remove that risk either**: injected script can read memory, or simply start a new authorize flow
(GitHub skips the consent screen for an app the user already authorized). `sessionStorage` was
chosen because it survives reloads in a tab, avoids minting a new token and waking the broker on
every reload, and is cleared when the tab closes. That reasoning is our inference, not a documented
GitHub fact.

Because the risk cannot be removed, preventing script injection is mandatory (see Known gaps):

- A `<meta>` Content Security Policy with no inline or third-party scripts.
- Repository content (README and Markdown included) is never rendered as raw HTML.
- Few dependencies, exact pins, a committed lockfile, the license and audit gates.
- A restrictive referrer policy; no tokens in URLs, logs or error messages.
- The token is read-only, lasts at most 8 hours, and is revoked on logout.

### Security properties and non-properties

| Property                                                         | Status                                                                             |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| One user cannot read another user's private data through the app | Relies on GitHub's user/app intersection. Verified by the harness, **not yet run** |
| The broker keeps no user credentials at rest                     | By design (stateless, no database, no disk)                                        |
| The broker cannot read repository data                           | By design (holds no installation token, PAT or app private key)                    |
| A compromised broker deployment cannot capture tokens            | **Not guaranteed.** It sees tokens in transit. Mitigated, not eliminated           |
| The token is safe from script running on our origin              | **Not guaranteed**, with `sessionStorage` or with memory-only storage              |

## Current implementation details

### `packages/shared`

- ESM package `@gvu/shared`, built with `tsc` to `dist/` (exports map points at `dist`).
- Contains `healthResponseSchema` (Zod) and the `HealthResponse` type: the contract of
  `GET /health`, validated by the web app and produced by the API.
- Consumers need it built first, so root scripts (`dev:*`, `typecheck`, `test`, `build`) run
  `build:shared` first.

### `apps/api`

- Hono app factory `createApp({ allowedOrigins, version })` in `src/app.ts` (testable via
  `app.request`), server bootstrap in `src/index.ts`.
- `GET /health` → `{ status: "ok", service: "gvu-api", version }` with `Cache-Control: no-store`.
- Security headers via `hono/secure-headers`; CORS is an **exact-match origin allow-list**
  (wildcards, paths and trailing slashes are rejected at startup); only `GET`/`OPTIONS` are
  advertised. Errors return generic JSON (no internals leaked).
- Config (`src/config.ts`): `PORT` (default 8787), `HOST` (default `127.0.0.1`; use `0.0.0.0` on
  Render), `ALLOWED_ORIGINS`. Graceful shutdown on `SIGTERM`/`SIGINT`. The commented
  `GITHUB_APP_CLIENT_ID` / `GITHUB_APP_CLIENT_SECRET` entries in `.env.example` are placeholders only.
- Dev: `tsx watch`; production: `tsc` → `node dist/index.js`.
- **Auth broker (Phase 3).** `POST /auth/token` exchanges the code (plus PKCE verifier) and returns
  only `{ access_token, expires_in }`; the refresh token is discarded. `POST /auth/revoke` asks GitHub
  to revoke a token and answers `{ revoked: true }` **only if GitHub itself confirmed it (HTTP 204)**;
  any other outcome is a 502 `revocation_not_confirmed`. Both require an allow-listed `Origin`, a JSON
  content type and a body of at most 4 KB, and validate input with the shared schemas. The
  `redirect_uri` must exactly equal an entry of `ALLOWED_REDIRECT_URIS` (no normalization, no
  wildcards). The API starts without `GITHUB_APP_CLIENT_ID` / `GITHUB_APP_CLIENT_SECRET`; `/auth/*`
  then answers a generic 503. Logs contain only fixed reason strings, never request or response
  content. There is no database and nothing is stored.

### `apps/web`

- React 19 + Vite 8, TypeScript, no router or state library yet.
- Calls **our own** `/health` (not GitHub) and validates the response with the shared schema; shows
  "API online", or a friendly "may be waking up" message (Render cold start).
- `VITE_API_BASE_URL` selects the API; `VITE_BASE_PATH` sets Vite's `base` (`/` locally,
  `/github-visual-universe/` for GitHub Pages).
- Only `VITE_`-prefixed variables reach the bundle. No secrets belong in the web app.
- **Sign-in (Phase 3).** "Connect GitHub" stores a random `state` and PKCE verifier in
  `sessionStorage`, wakes the API, then redirects to GitHub with an S256 challenge. At the exact
  configured callback URI (`VITE_AUTH_REDIRECT_URI`) the page reads `code`/`state`, **replaces the URL
  immediately**, validates `state` (single-use, 10-minute TTL) **before** sending the code to the
  broker, and stores the returned access token in `sessionStorage` (never `localStorage`; no refresh
  token). Repositories come from `GET /user/installations` and
  `GET /user/installations/{id}/repositories` (read-only GETs to `api.github.com` with the user's own
  token; GitHub returns the user ∩ app intersection). A 401 ends the session.
- **Repository Overview dashboard (Phase 4).** All repository data comes from the same read-only
  requests as sign-in discovery, plus one `GET /user` for the signed-in login. No other requests,
  permissions or write operations were added.
  - _Data:_ the installation endpoints already return full repository objects. The shared schema now
    also keeps `language`, `stargazers_count`, `forks_count`, `open_issues_count`, `updated_at`,
    `pushed_at`, `visibility`, `fork`, `archived`, `default_branch`, `topics` and `owner.type`.
    Every one of them is **optional**: a missing or malformed value becomes "absent" (shown as
    nothing, never as `0` or "unknown"), and a repository entry that cannot be read at all is
    skipped and **counted**, so one bad entry cannot hide the rest or silently shrink the totals.
  - _Complete dataset:_ all pages and installations are loaded automatically, up to a safety cap of
    **30 repository pages (3,000 repositories) per batch**. Statistics and the language chart are
    labelled **Complete** only when every page loaded and every entry was readable; otherwise they
    are labelled **Partial** (still loading, cap reached with a "Load more" button, a request
    failed part-way with "Try again", or entries were unreadable), each with its own message.
  - _Personal vs organization:_ "personal" means `owner.login` equals the login from `GET /user`.
    Organization comes from `owner.type`. A repository owned by another user (for example one you
    collaborate on) is counted as "Other accounts", and one whose owner type is missing is reported
    as undeterminable. If `GET /user` fails, personal figures and the Personal filter are hidden
    or disabled with an explanation and a retry.
  - _Language chart:_ repositories counted by GitHub's single primary `language`. It is a count of
    repositories, **not bytes or lines of code**. Byte counts would need one extra request per
    repository (`GET /repos/{owner}/{repo}/languages`) and were deliberately not added.
    Repositories without a detected language form a "No language detected" row. Bars are SVG
    attributes (no inline `style`, which the CSP forbids) and no chart library is used.
  - _Search, filters, sort:_ name search, visibility, owner, language and sort (name, or recently
    updated by `updated_at`) all combine (AND). Statistics always describe the whole loaded dataset,
    not the filtered view. "Last pushed" (`pushed_at`) appears in the detail panel only.
  - _Selection:_ choosing a card opens a detail panel with only fields the list already returned.
- **Architecture view (Phase 5).** The detail panel's "View architecture" button opens a read-only
  view of one repository's file tree on its **default branch**. It needs no backend change: the
  browser calls `api.github.com` directly with the user's token, using the Contents (read-only)
  permission that was already part of the App.
  - _Requests (all GET):_ `GET /repos/{owner}/{repo}/branches/{branch}` (head commit and tree SHA),
    then `GET /repos/{owner}/{repo}/git/trees/{tree_sha}?recursive=1`. If the repository list did
    not include a default branch, one `GET /repos/{owner}/{repo}` comes first. File contents, blobs
    and other branches are never requested. Owner and repository names are validated before they
    are placed in a URL, and the tree SHA is validated as hex by the shared schema.
  - _What it shows:_ a snapshot "of branch X at commit abc1234" with totals (files, folders, total
    size, deepest level, symlinks, submodules), a treemap of the current folder (tiles sized by
    bytes or by file count, drawn with SVG attributes only: no inline `style`, no chart library), a
    breadcrumb, a table of the folder's entries (the keyboard and screen-reader route to the same
    information), and a count of files by extension (a file count, not lines of code). Folders
    open from the table, the treemap or the breadcrumb.
  - _Partial data:_ GitHub caps a recursive listing at 100,000 entries or 7 MB and then sets
    `truncated`. The view then says so and labels every figure **Partial** ("lower bounds, not
    totals"); entries that cannot be read, or that contradict the tree, are skipped, counted and
    reported the same way. It never presents a cut-off listing as complete. A file without a
    reported size counts as a file but adds no bytes, and is reported.
  - _Failures:_ an empty repository (409), a missing branch or no access (404), a refusal such as a
    missing Contents permission (403), rate limits and network errors each have their own message
    with "Try again"; a 401 ends the session as everywhere else.
  - _Untrusted paths:_ file and folder names come from the repository. They are shown as text only
    (control and bidirectional-override characters are replaced, long names cut), are never used
    to build URLs, and `.`/`..` are plain names: nothing is resolved.
  - _Nothing is stored:_ the listing lives in memory while the view is open and is dropped when
    you go back. There is no cache.
- **Disconnect** has two separately reported halves: the browser session is cleared immediately, and
  GitHub revocation is requested through the broker and reported as done **only if GitHub confirmed
  it**.
- A strict `<meta>` CSP (`connect-src` limited to our API and `api.github.com`) and a `no-referrer`
  policy are injected into the **built** `index.html` only; the dev server has none, because a meta
  CSP would break hot reload.

### Spike harness (`scripts/spikes/github-auth`)

- A zero-dependency, local-only script used to gather evidence about the GitHub App model before
  Phase 3. It is **not part of the product** and is not built or deployed.
- It is read-only by construction (only `GET`, credential-free `OPTIONS` and GraphQL queries to
  `api.github.com`), accepts only GitHub App user tokens supplied through the environment, and never
  prints tokens or repository names. It is covered by offline tests against a mock server.
- Plan, runbook and limits: [`docs/spikes/github-auth-harness.md`](./spikes/github-auth-harness.md).

## Conventions

- TypeScript strict mode with `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` and
  `verbatimModuleSyntax`. Node ESM with `.js` import extensions in `api` and `shared`.
- Dependencies are exact-pinned (`.npmrc` `save-exact`); `package-lock.json` is committed.
- Install scripts are reviewed explicitly (`allowScripts` in the root `package.json`).
- New dependencies must pass the license gate (`npm run licenses:check`); exceptions need a written
  justification in `scripts/license-exceptions.json`.

## Known gaps

- **CSP is build-only.** The `<meta>` CSP is injected into the built site; `npm run dev` runs without
  one, so check CSP behaviour with `vite preview`. A `<meta>` CSP cannot express every directive
  (for example `frame-ancestors`).
- **Rate limiting is NOT implemented and is a required security task before any public deployment.**
  `/auth/token` and `/auth/revoke` currently have no per-client limits. It was deferred only because
  this milestone runs locally.
- GitHub Pages serves static files, so the production callback
  (`.../github-visual-universe/auth/callback/`) needs a real `auth/callback/index.html` (or a
  `404.html` fallback) before deployment. This is deployment work that has not been done.
- Sign-in and repository discovery have been run by the maintainer against real GitHub (personal,
  private and organization repositories were listed). Automated tests still use mocks only. Not yet
  verified live: the dashboard's extra repository fields (read from GitHub's documented response),
  `GET /user`, and token revocation.
- **Dashboard limits:** language is a repository count by primary language, not bytes. Branches,
  commits, pull requests, issues and workflows have no views yet. The 30-page cap means an
  account with more than about 3,000 accessible repositories shows partial statistics until
  "Load more" is used. The installation list itself is capped at 10 pages.
- **Architecture view limits:** default branch only. For a repository over GitHub's tree limit the
  view shows the partial listing GitHub returned and labels it partial; folders are **not** loaded
  on demand to complete it. Sizes are the sizes of Git blobs (a Git LFS file shows its small pointer
  size), and committed build output or vendored folders will dominate a size view. Verified live
  by the maintainer on one small repository (branch and tree requests, 65 entries, not truncated).
  Not yet verified live: a truncated tree, an empty repository, a branch name containing `/`, an
  organization repository, submodules and symlinks (covered by mocked tests only).
- No `404.html`/router fallback yet (decision pending: `HashRouter` vs. fallback, spike item 10).
  The auth callback paths depend on this decision.
- No deploy workflows, `render.yaml`, Dependabot config, or issue/PR templates.

## Unresolved behaviour (from the Phase 2 spike)

Nothing here is assumed by the design. Details, owners of the evidence and the planned resolution
for each item are in [ADR 0001](./adr/0001-auth-broker-and-direct-github-access.md#unresolved-behaviour-not-yet-verified).

| ID  | Open question                                                                                    |
| --- | ------------------------------------------------------------------------------------------------ |
| U1  | Are the user's public repos, where the app is not installed, listed by `GET /user/repos`?        |
| U2  | What private contribution detail does a GitHub App user token see through GraphQL?               |
| U3  | Does a token issued before installation see newly installed repositories without re-authorizing? |
| U4  | Is wildcard callback matching available on the app registration? (It must stay off.)             |
| U5  | Is a loopback-IP callback with a variable port accepted for GitHub Apps?                         |
| U6  | Response format and error semantics of the web-flow token endpoint                               |
| U7  | Actions endpoints on public repos without installation; workflow file contents                   |
| U8  | `X-GitHub-SSO` behaviour for app tokens                                                          |
| U9  | Per-user token-minting limits for GitHub Apps (documented for OAuth Apps only)                   |
| U10 | Authorization code lifetime for GitHub Apps                                                      |
| U11 | GitHub Pages hostname casing and query preservation on the callback path                         |

Also open: real `304` and rate-limit cost for conditional requests, browser-enforced CORS, and
refresh-token rotation and revocation against real GitHub.
