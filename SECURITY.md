# Security Policy

GitHub Visual Universe is designed to be **read-only** and to keep your repository data between your
browser and GitHub. This document describes the security model and how to report problems.

> **Current status:** local development. **Sign-in and repository listing are implemented and have
> been manually verified against real GitHub by the maintainer. Automated tests use mocked GitHub
> responses only, and nothing is deployed.** Rate limiting on the broker is **not implemented and is required before any public
> deployment.** The model below is the agreed **design** (see [ADR 0001](./docs/adr/0001-auth-broker-and-direct-github-access.md)).
> Sections marked _(planned)_ are not yet in code. Where this document and the ADR differ, the ADR
> takes precedence.

## Reporting a vulnerability

Please **do not** open a public issue for security problems.

- Use GitHub's private vulnerability reporting: the repository's **Security → Report a
  vulnerability** (enable it in repository settings if you do not see it).
- Include steps to reproduce, affected versions or commits, and impact.

We will acknowledge reports on a best-effort basis; this is a volunteer, free project with no
service-level guarantee.

## Security model

### Intended security boundary

> **The backend never reads repository data and stores no user credentials at rest. It does handle
> credentials in transit.**

This is an intended boundary, not an absolute guarantee. What GitHub enforces, what our design
provides, and which controls are still required are listed separately below.

1. The backend (`apps/api`) _(planned)_ is a stateless **auth broker** built with Hono. It holds the
   GitHub App **client secret** and performs the authorization-code exchange: it receives the
   `code`, the PKCE `code_verifier` and the `redirect_uri` from the browser, obtains a user access
   token from GitHub, and returns **only the access token and its lifetime**. The **refresh token is
   discarded**. It is never stored by the broker and never returned to the frontend. The broker also
   revokes tokens on sign-out, because revocation needs the client secret.
2. The broker handles credentials **in transit** (codes, verifiers, access tokens). It stores **no
   user credentials at rest** (no database, session store or disk) and logs no sensitive content.
3. The backend **never** uses installation tokens, personal access tokens or the GitHub App private
   key, and repository data never passes through it.
4. The **authenticated browser calls GitHub directly** (`api.github.com`) for repository data, with
   **the user's own token**. GitHub is expected to limit that token to what both the user and the
   app can access.
5. The application is **read-only** at three layers _(planned)_: read-only GitHub App permissions; a
   single client wrapper that allows only `GET` and GraphQL `query`; automated tests that fail on
   anything else.

### GitHub App permissions

Read-only only: **Metadata, Contents, Pull requests, Issues and Actions**. No write permissions, no
organization administration permissions, and no account permissions (including starring). The app is
owned by the `VisUniverseG` organization. Adding a permission later forces re-approval at every
installation, so any change is a deliberate, reviewed decision.

### Private repository access

Signing in is not enough to reach a private repository. The GitHub App must also be **installed on
the account that owns the repository, with that repository granted**. Organization repositories may
need an organization owner to install or approve the app, and SAML-protected organizations need an
active SSO session. A user token can reach only the **intersection** of what the user can access and
what the app was granted. We rely on GitHub to enforce this, and the authorization spike harness
exists to check it with real accounts _(not yet run)_.

### What still has to be true (controls required)

The boundary above only holds if these controls are built and kept. None of them exists yet:

- The broker must not log request bodies, codes, verifiers, tokens or `Authorization` headers; it
  must restrict `Origin` to an exact allow-list, validate `redirect_uri` against an allow-list, limit
  body size, and apply rate limiting. _Implemented: no sensitive logging, exact `Origin` and
  `redirect_uri` allow-lists, a 4 KB body limit. **Not implemented: rate limiting. It is a required
  task before public deployment.**_
- OAuth `state` and the PKCE verifier must be random, single-use and short-lived.
- The GitHub App setting **"Request user authorization (OAuth) during installation" must stay
  disabled**, because that path bypasses our `state` and PKCE checks. Device flow must stay off.
- The installation id passed to the Setup URL must never be trusted without confirming it with the
  user's token.
- A compromised or misconfigured broker deployment could capture tokens in transit. Deployment
  credentials must be protected and the broker's code and dependency surface kept small.

### Secrets

- **Never commit secrets.** `.env` files are git-ignored; only `.env.example` files with
  placeholders are tracked.
- The GitHub App **client secret** lives only in the API's environment (a git-ignored `apps/api/.env`
  locally, the Render environment in production), never in the repository
  or the frontend bundle. Only `VITE_`-prefixed variables reach the browser bundle, so nothing
  sensitive may use that prefix.
- If a secret is ever exposed, rotate it immediately in the GitHub App settings and Render.

### Browser

- The short-lived **access token only** is stored, in `sessionStorage`. The **refresh
  token is never stored in the browser** and is never returned to the frontend. Tokens must never
  appear in `localStorage`, URLs, logs or error reports.
- **`sessionStorage` does not eliminate XSS risk.** Any script running on our origin can read the
  token. Memory-only storage would not remove that risk either, because injected script could read
  memory or start a new authorization. The token is read-only, expires after about 8 hours and is
  revoked on sign-out, which limits the damage but does not prevent theft.
- **A strict Content Security Policy is a prerequisite for authentication.** It is a `<meta>` CSP
  because GitHub Pages cannot set response headers, so it cannot express every directive (for example
  `frame-ancestors`). It is injected into the **built** site only; the dev server has none.
- No third-party scripts or analytics.
- Rendered repository content (READMEs, issue bodies) must be sanitized before any HTML rendering
  _(planned)_. Markdown and README content is never rendered as raw HTML.
- Per-user cache keys; the cache is cleared on sign-out _(planned)_.

### Supply chain

- Exact-pinned dependencies and a committed lockfile.
- CI runs `npm audit --audit-level=high` and a license gate that fails on unreviewed licenses.
- Dependency install scripts are explicitly reviewed (`allowScripts` in the root `package.json`).
- CI actions are pinned to commit SHAs and the workflow token is read-only.

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

Also open: real `304` rate-limit cost, browser-enforced CORS, and refresh-token rotation and
revocation against real GitHub. Until resolved, treat statements about these as unproven.

## Risk register

See section 13 of the [Phase 0 assessment](./docs/phase-0-assessment.md#13-security-risks-and-mitigations)
and the [architecture document](./docs/ARCHITECTURE.md).

## Out of scope

Vulnerabilities in GitHub, Render or GitHub Pages themselves should be reported to those vendors.
