# Architecture

This document separates what **exists today** from what is **planned**. Rationale and verified
facts are in the [Phase 0 assessment](./phase-0-assessment.md); the authentication and data-access
decision (amended after the Phase 2 spike) is recorded in
[ADR 0001](./adr/0001-auth-broker-and-direct-github-access.md), which takes precedence where the two
differ. `PRIVACY.md`, `SECURITY.md` and the Phase 0 assessment have been aligned with both.

## Status

| Component                          | Status                                                                  |
| ---------------------------------- | ----------------------------------------------------------------------- |
| npm workspaces monorepo            | ✅ Implemented                                                          |
| `packages/shared` (contracts)      | ✅ Scaffold (`/health` schema only)                                     |
| `apps/api` (Hono)                  | ✅ Scaffold (`GET /health`, CORS, headers)                              |
| `apps/web` (React + Vite)          | ✅ Scaffold (status page calling `/health`)                             |
| CI checks                          | ✅ Implemented (not yet run on GitHub)                                  |
| Authentication design              | ✅ Decided (ADR 0001, amended after Phase 2). **No auth code exists.**  |
| GitHub authorization spike harness | ✅ Prepared, offline-tested. **Not yet run against a real GitHub App.** |
| GitHub App registration            | ⏳ Not created (Phase 3, done by the organization owner)                |
| Auth broker + sign-in (PKCE)       | ⏳ Planned (Phase 3)                                                    |
| GitHub data layer (read-only)      | ⏳ Planned (Phase 4)                                                    |
| Visualizations                     | ⏳ Planned (Phases 5–10)                                                |
| Deployment (Pages + Render)        | ⏳ Planned (Phase 11)                                                   |

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
- **No authentication code exists.** The broker endpoints described above are not implemented.

### `apps/web`

- React 19 + Vite 8, TypeScript, no router or state library yet.
- Calls **our own** `/health` (not GitHub) and validates the response with the shared schema; shows
  "API online", or a friendly "may be waking up" message (Render cold start).
- `VITE_API_BASE_URL` selects the API; `VITE_BASE_PATH` sets Vite's `base` (`/` locally,
  `/github-visual-universe/` for GitHub Pages).
- Only `VITE_`-prefixed variables reach the bundle. No secrets belong in the web app.

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

- **No CSP yet, and one is now a hard prerequisite for sign-in.** GitHub Pages cannot set response
  headers, so a `<meta>` CSP (and any dev-server adjustments) must land **before** the auth code,
  not with it. A `<meta>` CSP cannot express every directive (for example `frame-ancestors`).
- The API's CORS currently advertises only `GET`/`OPTIONS`. The broker needs `POST` and a
  `Content-Type` preflight, with the exact-origin rule kept.
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
