# Security Policy

GitHub Visual Universe is designed to be **read-only** and to keep your repository data between your
browser and GitHub. This document describes the security model and how to report problems.

> **Current status:** local development; **nothing is deployed.** The auth broker (`apps/api`),
> GitHub App sign-in with PKCE, the read-only GitHub client and repository discovery are
> **implemented**. Their automated tests use **mocked** GitHub responses, which show that the code
> behaves as designed but not how real GitHub behaves. The maintainer reports running sign-in and
> repository discovery against real GitHub (see [ARCHITECTURE.md](./docs/ARCHITECTURE.md)); that is
> a documented claim that cannot be reproduced from this repository. Rate limiting on the broker is
> **not implemented and is required before any public deployment.** Many GitHub behaviours the
> model relies on are still **unverified** (see "Unresolved behaviour"). The model is described in
> [ADR 0001](./docs/adr/0001-auth-broker-and-direct-github-access.md). Sections marked
> _(planned)_ are not yet in code. Where this document and the ADR differ, the ADR takes precedence.

## Reporting a vulnerability

Please **do not** open a public issue for security problems.

- Use GitHub's private vulnerability reporting: the repository's **Security → Report a
  vulnerability** (enable it in repository settings if you do not see it).
- Include steps to reproduce, affected versions or commits, and impact.

We will acknowledge reports on a best-effort basis; this is a volunteer, free project with no
service-level guarantee.

## Security model

### How to read the status of a control

- **Implemented:** present in the code, checked against the source.
- **Mock or local tests:** covered by automated tests that use fake GitHub responses or run
  locally. This is not evidence about real GitHub.
- **Verified live:** observed against real GitHub. Today that is limited to the anonymous harness
  checks `ANON-01` to `ANON-03` (CORS preflight and exposed response headers, inspected from Node;
  see the [harness document](./docs/spikes/github-auth-harness.md)), plus the maintainer's
  documented manual sign-in and repository-discovery runs.
- **Assumption:** depends on GitHub's behaviour or on app settings that this repository cannot show.

### Intended security boundary

> **The backend never reads repository data and stores no user credentials at rest. It does handle
> credentials in transit.**

This is an intended boundary, not an absolute guarantee. What GitHub enforces, what our design
provides, and which controls are still required are listed separately below.

1. The backend (`apps/api`) is a stateless **auth broker** built with Hono _(implemented; mock-tested;
   not verified live beyond the maintainer's reported sign-in)_. It holds the GitHub App **client
   secret** and performs the authorization-code exchange: it receives the `code`, the PKCE
   `code_verifier` and the `redirect_uri` from the browser, obtains a user access token from
   GitHub, and returns **only the access token and its lifetime**. The **refresh token is
   discarded**: the broker builds its response explicitly, never stores the refresh token and never
   returns it to the frontend. The broker can also revoke a token at GitHub, because revocation
   needs the client secret; the web app asks it to do so when the user disconnects.
2. The broker handles credentials **in transit** (codes, verifiers, access tokens). In the code it
   stores **no user credentials at rest** (it has no database, session store or disk writes; its
   only file access reads its own version) and logs only fixed reason strings, never request or
   response content _(implemented; the logging behaviour is mock-tested)_.
3. The backend **never** uses installation tokens, personal access tokens or the GitHub App private
   key, and repository data never passes through it. In the code it exposes only `GET /health`,
   `POST /auth/token` and `POST /auth/revoke`, and its only outbound calls are the token exchange
   and the token revocation at GitHub _(implemented)_.
4. The **authenticated browser calls GitHub directly** (`api.github.com`) for repository data, with
   **the user's own token** _(implemented)_. GitHub is expected to limit that token to what both
   the user and the app can access _(assumption, not verified with real accounts)_.
5. The application is intended to be **read-only** at three layers:
   1. **Read-only GitHub App permissions.** Configured in GitHub, so **this repository cannot show
      them**. The harness check meant to probe least privilege (`ACC-07`) has not been run
      _(assumption)_.
   2. **A single client wrapper.** `githubGet` in `apps/web/src/github/client.ts` is the only code
      in the web app that calls `api.github.com`. It hard-codes `GET`, refuses any URL that is not
      `https://api.github.com`, sends no cookies, and does not follow redirects _(implemented;
      mock-tested)_. There is **no GraphQL support**, so no GraphQL query or mutation path exists.
      The web app's other two `fetch` calls go to our own API (`/health`, `/auth/*`).
   3. **Automated tests.** The tests for each GitHub call site assert `GET` requests to
      `api.github.com` only _(mock tests)_. There is **no lint rule and no repository-wide test**
      that forbids other HTTP methods or a direct `fetch` to GitHub elsewhere in the web app, so
      this layer is enforced by code structure and review, not by a global automated guard
      _(planned)_. The separate spike harness (`scripts/spikes`) is a local tool with its own
      GET-only guard and is not part of the product.

### GitHub App permissions

Read-only only: **Metadata, Contents, Pull requests, Issues and Actions**. No write permissions, no
organization administration permissions, and no account permissions (including starring). The app is
owned by the `VisUniverseG` organization. Adding a permission later forces re-approval at every
installation, so any change is a deliberate, reviewed decision.

This is the **intended** permission set. It lives in the GitHub App registration, which this
repository does not contain, so it **cannot be verified from the code** and has not been checked
with a live token. The code currently calls only user, installation, repository-list, branch and
git-tree endpoints, so it does not yet use the Pull requests, Issues or Actions permissions.

### Private repository access

Signing in is not enough to reach a private repository. The GitHub App must also be **installed on
the account that owns the repository, with that repository granted**. Organization repositories may
need an organization owner to install or approve the app, and SAML-protected organizations need an
active SSO session. A user token can reach only the **intersection** of what the user can access and
what the app was granted. We rely on GitHub to enforce this _(assumption)_. The authorization spike
harness exists to check it with real accounts, but its account and isolation checks have **not been
run**. The maintainer reports that private and organization repositories were listed in a live run;
that shows access was granted, not that isolation holds.

### Controls required, and their status

The boundary above only holds if these controls are built and kept. For each control: what the code
does, what the automated tests cover (all with fake GitHub responses; see "How to read the status
of a control"), what has been observed live, and what is still open. **No control below has been
verified live except where stated.**

**Broker does not log bodies, codes, verifiers, tokens or `Authorization` headers**

- Implemented: only fixed reason strings are logged, startup prints only whether credentials are
  loaded, and no request-logging middleware is used.
- Mock tests: tests spy on every console method and check that logs and responses contain no
  secret, code, verifier or token.
- Verified live: no.
- Open: logs kept by a hosting platform are not assessed (nothing is deployed).

**Exact `Origin` allow-list**

- Implemented: on `/auth/*` (403 otherwise), plus exact-match CORS.
- Mock tests: allowed, disallowed and missing `Origin`, and preflights.
- Verified live: no.
- Open: `Origin` is a browser-set header. A non-browser client can send any value, so this stops
  other websites, not scripted abuse. That is why rate limiting is required.

**`redirect_uri` allow-list**

- Implemented: exact string comparison. The config rejects wildcards, queries, fragments and
  non-canonical entries.
- Mock tests: trailing slash, `127.0.0.1`, another port, path, scheme, query and letter case are
  all rejected.
- Verified live: no.
- Open: whether the GitHub App registration matches callbacks loosely (U4) or accepts a loopback
  callback (U5) is unverified. The registered callback list is not visible from this repository.

**Body size limit and strict input**

- Implemented: 4 KB limit, JSON content type only, strict schemas and generic error codes.
- Mock tests: yes.
- Verified live: no.

**Rate limiting on the broker**

- Implemented: **no.** `/auth/token` and `/auth/revoke` have no per-client limits.
- Mock tests: none.
- Verified live: no.
- Open: **required before any public deployment.**

**`state` and PKCE verifier: random, single-use, short-lived**

- Implemented: both come from `crypto.getRandomValues`. The pending record is removed when it is
  read, so a callback can be used once. It expires after 10 minutes. `state` is compared before the
  code is sent to the broker.
- Mock or local tests: the RFC 7636 test vector for the S256 challenge (a deterministic local
  check of the algorithm), plus state mismatch, replay, expiry and missing-record cases.
- Verified live: the maintainer reports a working sign-in. That does not show that GitHub enforces
  the `code_verifier`.
- Open: whether GitHub rejects a wrong `code_verifier` for a GitHub App is unverified.

**Token handling in the browser**

- Implemented: access token only, in `sessionStorage`. The callback URL is replaced immediately.
  The token is sent only in an `Authorization` header to `api.github.com`.
- Mock tests: nothing in `localStorage`, the URL scrubbed, a callback code exchanged exactly once
  (also under React Strict Mode), and no token or code in error messages.
- Verified live: the maintainer reports a working sign-in.
- Open: behaviour with real browser extensions and storage settings is untested.

**Token revocation on disconnect**

- Implemented: the browser clears its token first, then asks the broker, which calls GitHub. The
  UI says the token was revoked only if GitHub confirmed it, and otherwise warns.
- Mock tests: yes, against a mocked GitHub.
- Verified live: **no.** The docs record that revocation has not been verified live.
- Open: if revocation fails, the token stays valid until it expires. Revocation and refresh-token
  behaviour against real GitHub are unverified.

**GitHub App setting "Request user authorization (OAuth) during installation" stays disabled, and
device flow stays off**

- Implemented: not applicable to code.
- Verified live: no. These settings cannot be inspected from this repository.
- Open: **assumption.** The first path bypasses our `state` and PKCE checks, so it must stay off.

**The installation id passed to the Setup URL is never trusted without confirming it with the
user's token**

- Implemented: no code handles the Setup URL or reads `installation_id` today.
- Open: apply this control if a Setup URL flow is added.

**Broker deployment is protected and kept small**

- Implemented: the broker has three routes and a small dependency surface. Nothing is deployed.
- Open: a compromised or misconfigured deployment could capture tokens in transit. Deployment
  credentials must be protected once there is a deployment.

### Secrets

- **Never commit secrets.** `.env` files are git-ignored; only `.env.example` files with
  placeholders are tracked _(implemented; checked against `.gitignore` and the tracked files, with
  no automated secret scanning in the repository)_.
- The GitHub App **client secret** lives only in the API's environment (a git-ignored `apps/api/.env`
  locally; the Render environment in production, which is _planned_ because nothing is deployed),
  never in the repository or the frontend bundle. The web app reads no client secret. Only
  `VITE_`-prefixed variables reach the browser bundle, so nothing sensitive may use that prefix.
- If a secret is ever exposed, rotate it immediately in the GitHub App settings and Render.

### Browser

- The short-lived **access token only** is stored, in `sessionStorage`. The **refresh
  token is never stored in the browser** and is never returned to the frontend. Tokens must never
  appear in `localStorage`, URLs, logs or error reports. _(Implemented and mock-tested; see the
  controls above. The web app has no logging or error-reporting calls.)_
- **`sessionStorage` does not eliminate XSS risk.** Any script running on our origin can read the
  token. Memory-only storage would not remove that risk either, because injected script could read
  memory or start a new authorization. The token is read-only (by the design of the app
  permissions, which are not verifiable here), is expected to expire after about 8 hours (GitHub's
  documented lifetime for user tokens, not measured by us; the broker refuses to pass on a token
  that has no expiry), and the app asks for revocation on sign-out. That limits the damage but does
  not prevent theft.
- **A strict Content Security Policy is a prerequisite for authentication.** It is a `<meta>` CSP
  because GitHub Pages cannot set response headers, so it cannot express every directive (for example
  `frame-ancestors`). It is injected into the **built** site only; the dev server has none.
  _(Implemented. Tests check the policy string and it is present in the built `index.html`; the
  script, style, image, font and `connect-src` directives are restricted to our own origin and
  `api.github.com`, with no inline scripts or styles. Enforcement in real browsers and on the real
  host is not tested.)_
- No third-party scripts or analytics _(implemented: none are in the code, and the built-site CSP
  would block them)_.
- Rendered repository content (READMEs, issue bodies) must be sanitized before any HTML rendering
  _(planned)_. **No such content is rendered today.** The web source contains no
  `dangerouslySetInnerHTML`, `innerHTML` or `eval` (found by search, not enforced by a lint rule).
  File and folder names from GitHub are shown as plain text, with control and bidirectional
  characters made visible, and are never used in URLs _(implemented; mock-tested)_.
- Per-user cache keys; the cache is cleared on sign-out _(planned)_. **No cache exists today**: the
  only data the app persists is the `sessionStorage` token and temporary sign-in state.

### Supply chain

- Exact-pinned dependencies and a committed lockfile.
- CI runs `npm audit --audit-level=high` and a license gate that fails on unreviewed licenses.
- Dependency install scripts are explicitly reviewed (`allowScripts` in the root `package.json`).
- CI actions are pinned to commit SHAs and the workflow token is read-only.

These are implemented and checked against the repository files (`package.json` files, the lockfile
and `.github/workflows/ci.yml`). There is no Dependabot configuration in the repository.
Repository-level GitHub settings (secret scanning, private vulnerability reporting, branch
protection) cannot be checked from here.

### Unresolved behaviour

These GitHub behaviours were **not verified** by the Phase 2 research, and the design does not
assume them. They are tracked as U1 to U11 in
[ADR 0001](./docs/adr/0001-auth-broker-and-direct-github-access.md#unresolved-behaviour-not-yet-verified):

- **U1:** whether `GET /user/repos` lists public repositories where the app is not installed.
- **U2:** which private contribution detail a GitHub App user token sees.
- **U3:** whether a token issued before installation sees newly installed repositories.
- **U4:** whether wildcard callback matching is available (it must stay off).
- **U5:** whether a loopback-IP callback with a variable port works for GitHub Apps.
- **U6:** response format and error semantics of the web-flow token endpoint.
- **U7:** Actions endpoints on public repositories without installation, and workflow file contents.
- **U8:** `X-GitHub-SSO` behaviour for app tokens.
- **U9:** per-user token-minting limits for GitHub Apps.
- **U10:** authorization code lifetime for GitHub Apps.
- **U11:** GitHub Pages hostname casing and query preservation on the callback path.

Also open: real `304` rate-limit cost, browser-enforced CORS, token revocation, and refresh-token
rotation against real GitHub. Until resolved, treat statements about these as unproven.

None of U1 to U11 is resolved by the evidence in this repository; their statuses are recorded in
the ADR and have not been changed. The only live harness results so far are the anonymous checks
`ANON-01` to `ANON-03` (see the [harness document](./docs/spikes/github-auth-harness.md)). They
inspected CORS preflight responses and exposed response headers from Node; they do not show
browser-enforced CORS. The harness's account and isolation checks, which would address the
private-repository intersection model, token-expiry visibility and least privilege, have not been
run.

## Risk register

See section 13 of the [Phase 0 assessment](./docs/phase-0-assessment.md#13-security-risks-and-mitigations)
and the [architecture document](./docs/ARCHITECTURE.md).

## Out of scope

Vulnerabilities in GitHub, Render or GitHub Pages themselves should be reported to those vendors.
