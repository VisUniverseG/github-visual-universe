# ADR 0001: Thin auth broker plus direct-to-GitHub data access

- **Status:** Accepted (design), **amended 2026-10-27** after the Phase 2 technical spike.
  **Implemented in part** (noted 2026-10-28): the broker, PKCE sign-in, the read-only GitHub client,
  repository discovery and the architecture view exist and are tested with mocked GitHub responses.
  Live verification is incomplete and several decisions are not yet implemented. See
  [Implementation status (2026-10-28)](#implementation-status-2026-10-28). The decisions below are
  unchanged.
- **Date:** 2026-10-27 (original), amended 2026-10-27, implementation status added 2026-10-28

## Context

GitHub Visual Universe is a free, open-source, read-only tool for 10–20 initial users. The frontend
is static (GitHub Pages). The backend must run on Render's free tier. Users sign in with their own
GitHub accounts and may view private repositories, and no user may ever reach another user's private
data. Budget is ₹0.

### Verified facts (official GitHub documentation)

Sources are listed under [References](#references). Observations marked 🔬 were made with
anonymous requests and are **not** contractual.

- A GitHub App **user access token** can only reach what both the user and the app can reach.
- Exchanging an authorization `code` for a token requires the app's **client secret**, even when PKCE
  is used. PKCE is optional on GitHub's side (S256 only). `github.com/login/oauth/access_token` does
  not support CORS preflight 🔬, so a browser cannot do the exchange on its own. A browser-only (SPA)
  client type exists only as a paused preview ([roadmap #1153](https://github.com/github/roadmap/issues/1153)).
- User access tokens expire after 8 hours; refresh tokens last 6 months, are single-use and rotate.
  Refreshing also needs the client secret (except device flow).
- **Authorizing** and **installing** a GitHub App are separate steps. Private repository access needs
  the app to be **installed on the account that owns the repository, with that repository granted**
  ("All repositories" or "Only select repositories"). Authorizing alone never grants private access.
- The app always has read access to public repositories.
- Revoking a user token needs `DELETE /applications/{client_id}/token` with **Basic auth using the
  client secret**.
- The Setup URL receives an `installation_id` query parameter that can be spoofed.
- The option "Request user authorization (OAuth) during installation" redirects to the callback
  without our `state` or PKCE verifier.
- `api.github.com` supports CORS from any origin 🔬, allows the `Authorization`, `Content-Type`,
  `If-None-Match` and `X-GitHub-Api-Version` request headers 🔬, and exposes `ETag`, `Link`,
  `Retry-After`, `X-RateLimit-*` and `X-GitHub-SSO` to JavaScript 🔬.
- Adding permissions to an app later requires re-approval at every installation.
- Render Free sleeps after 15 minutes idle (about 1 minute wake), has no persistent disk, and may
  suspend services with high service-initiated traffic.
- `github.io` and `onrender.com` are different sites, so third-party-cookie blocking is likely.

## Decision

### Application

1. Use a **GitHub App** (not an OAuth App), **owned by the `VisUniverseG` organization** (D3).
2. Request **only these read-only permissions** (D2):

   | Permission    | Level | Used for                                    |
   | ------------- | ----- | ------------------------------------------- |
   | Metadata      | read  | Repository metadata (granted automatically) |
   | Contents      | read  | Files, trees, commits, branches             |
   | Pull requests | read  | Pull requests and reviews                   |
   | Issues        | read  | Issues and timelines                        |
   | Actions       | read  | Workflows and runs                          |

   Not requested: any write permission, any organization administration permission, any account
   permission (including **starring**), Checks, Statuses, Dependabot alerts. Permissions are fixed
   up front deliberately, because adding one later forces re-approval at every installation.

3. Required app settings:
   - User-token expiration **on**.
   - Device flow **off**.
   - "Request user authorization (OAuth) during installation" **off** (see Phase 2 corrections).
   - Webhook inactive.
   - Callback URLs are exact matches with no wildcard. Pass `redirect_uri` explicitly.
   - Visibility "Any account" so people other than the owner can install it.

### Auth broker

4. Run an **auth broker** (`apps/api`, Hono) on Render Free. It is **stateless** and holds the
   **client secret**. It handles user credentials **in transit only** and stores none at rest. It
   exposes exactly two operations:
   - **Token exchange:** accepts `{code, code_verifier, redirect_uri}`, exchanges them with GitHub
     using the client secret, and returns only `{access_token, expires_in}`. The `refresh_token` is
     **discarded**, never returned to the browser.
   - **Revocation:** accepts `{access_token}` and revokes it with GitHub (revocation requires the
     client secret, so only the broker can do it).
5. The broker **never** holds an installation token, PAT, or app private key, and never reads GitHub
   repository data.
6. The broker must not log request bodies, codes, verifiers, tokens or `Authorization` headers
   (method, path, status and a request id only). It rejects requests whose `Origin` is not on the
   exact allow-list, validates `redirect_uri` against a server-side allow-list, limits body size,
   rate-limits per client, times out upstream calls, and answers with `Cache-Control: no-store`.

### Browser

7. The **authenticated browser calls GitHub directly** (`api.github.com`, REST and GraphQL) with the
   user's own token for all repository data. Repository data never passes through the broker.
8. **Token storage (D1):** the short-lived **access token only** is kept in `sessionStorage`. The
   **refresh token is never stored in the browser** (the broker does not return it). On expiry
   (8 hours) or on logout, the user re-runs the authorize redirect.
9. OAuth `state` and the PKCE `code_verifier` are single-use, stored in `sessionStorage`, deleted
   before the exchange, and expire after about 10 minutes. The callback page removes `code` and
   `state` from the URL immediately. Any `returnTo` value is restricted to internal paths.
10. Before redirecting to GitHub, the SPA pre-warms the broker (`GET /health`) so a Render cold start
    does not eat into the authorization code's lifetime.
11. Strong XSS protection is a **requirement** of this design, not an option: a `<meta>` Content
    Security Policy with no inline scripts and no third-party scripts, sanitized rendering of
    repository content (README and Markdown are never rendered as raw HTML), minimal and pinned
    dependencies, a restrictive `Referrer-Policy`, and no tokens in URLs, logs or error messages.

### Private repository access

12. To see a private repository, the user must (a) authorize the app and (b) install it on the
    account that owns the repository with that repository granted. For organization repositories an
    owner may have to install or approve the app, and SAML-protected organizations additionally need
    an active SSO session at authorization and installation time. The product must explain this
    step and detect a missing grant (`GET /user/installations` and its repository list) instead of
    showing an empty result.
13. The Setup URL is treated as a navigation hint only. The `installation_id` it carries is never
    trusted; the installation is confirmed with the user's token.

## Phase 2 corrections to the earlier design

These supersede the corresponding statements in the original ADR and in the
[Phase 0 assessment](../phase-0-assessment.md).

| Earlier statement                                                                                      | Correction                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The broker "stores and logs nothing"                                                                   | The broker holds the client secret and **handles credentials in transit** (the code, verifier and the resulting access token). It stores **no user credentials at rest** and logs no sensitive content.                                                               |
| "The server has no credential able to read private data" / "structurally impossible" cross-user access | Overstated. GitHub enforces the user/app intersection, and the broker keeps nothing at rest, but a **compromised broker deployment could capture tokens in transit**. Deploy integrity, minimal dependencies and no body logging are therefore security requirements. |
| Revoke on logout (implied to be browser-side)                                                          | **Token revocation requires the broker**, because it needs the client secret.                                                                                                                                                                                         |
| Installation flow unspecified                                                                          | "Request user authorization during installation" **must be disabled**: it bypasses our `state` and PKCE. The Setup URL is used instead.                                                                                                                               |
| Private access described loosely                                                                       | Private repository access **requires the app to be installed on the owning account with the repository granted**. Authorizing alone is not enough.                                                                                                                    |
| "Token in memory only" as the XSS mitigation                                                           | **Memory-only storage does not eliminate XSS risk.** A script running on our origin can read an in-memory token, or start a new authorize flow (GitHub skips the consent screen for an already-authorized app). It also forces a new token on every reload.           |
| Data access path                                                                                       | Confirmed and made explicit: the **authenticated browser calls GitHub directly** for repository data.                                                                                                                                                                 |
| The localhost callback was unverified                                                                  | `http://localhost:<port>/...` is verified for GitHub Apps. A loopback IP with a variable port is documented only for OAuth Apps and stays open (U5).                                                                                                                  |
| A private dev app was acceptable                                                                       | A second test account can only install the app if its visibility is "Any account".                                                                                                                                                                                    |

## Consequences

**Positive**

- GitHub enforces the user/app intersection, and the broker keeps nothing at rest, so there is no
  token store that could leak across users. A compromised broker is the main residual risk and is
  mitigated, not eliminated (see below).
- Render only handles tiny auth requests, so cold starts affect only login, and the bandwidth and
  service-initiated-traffic limits are not at risk.
- No database or session store is needed, which fits Render Free's ephemeral filesystem.
- Repository data never touches our server.

**Negative / risks**

- **XSS is the main threat to the access token.** `sessionStorage` is readable by any script on our
  origin. The mitigations in Decision 11 reduce the likelihood, and the token's limits reduce the
  impact: it is read-only, lasts at most 8 hours, and is cleared from the browser on logout, where
  revocation is requested through the broker (confirmed only when GitHub answers 204; not yet
  verified live; see Implementation status). They do not remove the risk. Memory-only storage would not remove it either (see corrections).
- **Why `sessionStorage` and not memory-only (D1).** Memory-only would force a new token, and a
  possible broker wake-up, on every reload, and it could trip token-minting limits (U9). This is
  **our inference, not a documented GitHub fact.** `sessionStorage` is per tab, is cleared when the
  tab closes, and survives reloads. Its added exposure compared with memory is that a stored token
  can be read at any time by injected script, rather than only while the page runs.
- A compromised or misconfigured broker could capture tokens in transit. Mitigations: tiny code
  surface, no body logging, strict CORS and `redirect_uri` allow-lists, pinned dependencies, and
  protected deployment credentials.
- Users re-authorize about every 8 hours, because no refresh token is kept anywhere. Keeping refresh
  tokens would need either browser storage (rejected by D1) or server-side storage (it would
  introduce credentials at rest and break the stateless design), so it is out of scope.
- Private repositories need an explicit **installation** step; organization repositories may need an
  owner's approval.
- Heavy aggregation happens client-side.
- Render Free cold starts (about 1 minute) affect the first sign-in after idle time.

## Alternatives considered

| Alternative                                      | Why not                                                                                   |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| OAuth App                                        | Coarse scopes (`repo` can write), non-expiring tokens                                     |
| Fully proxy all GitHub calls through the backend | Wastes Render bandwidth, adds cold-start latency to every view, backend sees private data |
| Backend session cookie                           | Third-party-cookie blocking across `github.io` ↔ `onrender.com`                           |
| Browser-only PKCE (SPA client type)              | Paused preview, not in official docs                                                      |
| Installation tokens held by the backend          | Backend would hold a credential able to read many users' private data                     |
| Memory-only access token                         | Does not remove XSS risk; a new token on every reload; see D1                             |
| Refresh tokens in the browser                    | A long-lived secret exposed to XSS (rejected by D1)                                       |
| Broker-held or sealed refresh tokens             | Introduces credentials at rest or a token-use oracle; breaks the stateless design         |
| Device flow                                      | Enables phishing-style impersonation of the app; GitHub advises disabling it              |

## Implementation status (2026-10-28)

This section records what the repository contains today. It does **not** change any decision above
and does not resolve any of U1 to U11. Decisions are numbered as in the Decision section.

Terms:

- **Implemented:** present in the code, checked against the source.
- **Mock or local tests:** covered by automated tests that use fake GitHub responses or run locally.
  This shows the code behaves as designed. It is not evidence about real GitHub.
- **Verified live:** observed against real GitHub and recorded in this repository.
- **Assumption:** depends on GitHub behaviour or settings that are not verified.

### Verified live, as recorded

- Only the anonymous harness checks `ANON-01` to `ANON-03` (CORS preflight responses and exposed
  response headers, inspected from Node). See the
  [harness document](../spikes/github-auth-harness.md#12-verified-live).
- [ARCHITECTURE.md](../ARCHITECTURE.md) reports that the maintainer ran sign-in and repository
  discovery against real GitHub (personal, private and organization repositories were listed) and
  opened the architecture view of one small repository. These are documented claims that cannot be
  reproduced from this repository, and they are not treated here as recorded test evidence. Token
  revocation, large-repository lazy loading and the other items below have **not** been verified
  live.

### By decision

- **Decisions 1 to 3 (GitHub App, permissions, settings).** The app registration is not part of the
  repository, so none of this is verifiable from the code. **Assumption.** The code calls only user,
  installation, repository-list, branch and git-tree endpoints, so it uses the Metadata and Contents
  permissions. Pull requests, Issues and Actions are requested by design but unused today.
  _(Update 2026-10-29: the sentence above is kept as written; it dates from
  2026-10-28. Since then the Activity view has added the commit-list and branch-list endpoints
  (expected to need Contents, read) and the pull-request-list endpoint,
  `GET /repos/{owner}/{repo}/pulls` (expected to need Pull requests, read). Pull requests is
  therefore **no longer unused**; Issues and Actions still are. Which permission GitHub requires
  for each endpoint has not been checked against a live token. The maintainer reports that Pull
  requests (read-only) is enabled on the app and that the pull request list loaded in their own
  browser; the repository can show neither. See [ARCHITECTURE.md](../ARCHITECTURE.md).)_
- **Decision 4 (auth broker).** _Implemented:_ `apps/api` (Hono) exposes `POST /auth/token` and
  `POST /auth/revoke`, plus an unauthenticated `GET /health` that the pre-warm in Decision 10 uses.
  Token exchange returns only `{access_token, expires_in}`: the broker builds its response
  explicitly, so the refresh token is dropped, and it refuses a response without a positive
  integer `expires_in`. Revocation calls `DELETE /applications/{client_id}/token` with Basic auth
  and reports success only when GitHub answers 204. It is stateless and writes nothing to disk.
  _Mock tests:_ yes, with a mocked GitHub. _Verified live:_ no (see above). The real token
  response shape and the real revocation call have not been observed in recorded evidence.
- **Decision 5.** _Implemented:_ the broker has no installation-token, PAT or private-key
  configuration, makes no GitHub data calls, and its only outbound calls are the token exchange and
  the revocation. _Mock tests:_ partly (credential-handling and no-leak tests).
- **Decision 6 (broker controls).** _Implemented and mock-tested:_ exact `Origin` allow-list, exact
  `redirect_uri` allow-list, 4 KB body limit, JSON-only content type, strict request schemas, a
  10-second upstream timeout, `Cache-Control: no-store`, and no logging of request or response
  content. _Not implemented:_ see "Decisions not yet implemented" below.
- **Decision 7 (direct browser access).** _Implemented, REST only:_ `githubGet` in
  `apps/web/src/github/client.ts` is the only code that calls `api.github.com`. It sends only
  `GET`, refuses any other origin, sends no cookies and does not follow redirects. _Mock tests:_
  each call site asserts GET requests to `api.github.com` only. There is no lint rule or global test
  forbidding other methods. GraphQL is not implemented.
- **Decision 8 (token storage).** _Implemented and mock-tested:_ the access token only, in
  `sessionStorage`; a token within 60 seconds of expiry counts as expired; the refresh token never
  reaches the browser. On logout the browser clears the token first, then asks the broker to revoke
  it. The UI reports revocation only when GitHub confirmed it and warns otherwise. If revocation
  fails the token stays valid until it expires. The 8-hour lifetime is GitHub's documented figure and
  has not been measured by us.
- **Decision 9 (`state` and PKCE).** _Implemented and mock-tested:_ `state` and the verifier come
  from `crypto.getRandomValues`; the S256 challenge is checked against the RFC 7636 test vector;
  the pending record is removed when it is read, so a callback is single-use; it expires after 10
  minutes; `state` is compared before the code is sent to the broker; the callback URL is replaced
  immediately. _Not implemented:_ `returnTo`. _Assumption:_ that GitHub enforces the
  `code_verifier` for a GitHub App.
- **Decision 10 (pre-warm).** _Implemented and mock-tested:_ the SPA calls `GET /health` (60-second
  timeout) before redirecting and does not redirect if the API is unreachable.
- **Decision 11 (XSS protection).** _Implemented:_ a `<meta>` Content Security Policy and a
  `no-referrer` policy are injected into the built `index.html` only; there are no inline or
  third-party scripts; dependencies are exact-pinned; tokens are never placed in URLs, logs or error
  messages (the web app has no logging calls). _Tests:_ the policy string is unit-tested, and
  inspecting the `index.html` from a local `npm run build` shows it injected (no automated test
  covers the injection); enforcement in real browsers is untested. _Not applicable yet:_
  sanitized rendering, because no repository text content is rendered.
- **Decision 12 (private repository access).** _Partly implemented:_ discovery uses the installation
  endpoints, and an empty result explains that the app lists only repositories it is installed on.
  The architecture view's 403 message mentions installation. `X-GitHub-SSO` is not detected, so
  SAML-protected organizations get only the generic forbidden message. _Mock tests:_ yes.
  _Verified live:_ no, beyond the maintainer's reported listing. Whether the user-token
  intersection model holds is an **assumption** (harness `ACC-04`, `ACC-05` and `ISO-*` not run).
- **Decision 13 (Setup URL).** _Not implemented._

### Repository discovery and architecture view

These are not described by the decisions above. Both are **implemented and mock-tested only** as far
as recorded evidence goes. Their behaviour against real GitHub (large repositories, rate limits,
organization repositories) is **not verified**.

- **Discovery.** `GET /user/installations` and `GET /user/installations/{id}/repositories`, plus
  `GET /user` for the signed-in login. Entries are parsed leniently, one at a time, and unreadable
  ones are counted as skipped. Totals are labelled complete only when nothing was skipped and every
  page was read. Pagination auto-loads up to 30 pages and offers "Load more" beyond that; the
  installation list is capped at 10 pages.
- **Architecture view.** `GET /repos/{owner}/{repo}/branches/{branch}` for the branch head, then
  `GET /repos/{owner}/{repo}/git/trees/{sha}`. The default branch is used and branch names are
  percent-encoded. If GitHub reports the recursive listing as truncated, the cut-off listing is
  discarded and the root is listed non-recursively ("lazy mode"). Folders then load on demand, one
  non-recursive request each, by tree SHA.
- **Loader behaviour (mock tests only).** At most four concurrent requests with the rest queued;
  one shared request per folder; no automatic retry; blocking of further requests until the reset
  time GitHub reports after a rate limit; a 401 aborts everything in flight and calls back once;
  disposal on unmount aborts in-flight requests. Figures stay lower bounds, shown as partial, until
  every folder is listed. File names are displayed as plain text with control and bidirectional
  characters made visible.
- **Not verified live:** lazy loading of a real large repository, rate-limit behaviour under real
  limits, empty repositories, branch names containing `/` against our own code, organization
  repositories, and submodules and symlinks in our own code.

### Decisions not yet implemented

The decision text above stays as the requirement. The code does not yet meet these parts of it:

- **Per-client rate limiting in the broker** (Decision 6). `/auth/token` and `/auth/revoke` have no
  per-client limits. It is required before any public deployment.
- **Per-request logging** (Decision 6). The broker logs no method, path, status or request id. It
  logs only fixed reason strings for failed exchanges and revocations.
- **GraphQL** (Decision 7). Only REST is implemented.
- **`returnTo` restricted to internal paths** (Decision 9). There is no `returnTo` feature.
- **Setup URL and `installation_id` handling** (Decisions 12 and 13). No code handles the Setup URL.
- **Sanitized rendering of repository content** (Decision 11). No README, issue or Markdown content
  is rendered yet. The web source has no HTML injection sinks (found by search, not enforced by a
  lint rule).
- **Deployment and the cache.** Nothing is deployed, and no per-user cache exists, so cache keys
  and clearing on logout are still design intent.

## Unresolved behaviour (not yet verified)

These come from the Phase 2 report and must be settled with a real development app. None of them is
assumed in the design above. Evidence is gathered by the
[spike harness](../spikes/github-auth-harness.md) (U1–U3, U7, U8) or by manual checks (the rest).

As of 2026-10-28 **none of U1 to U11 is resolved** by the evidence recorded in this repository. The
only harness checks run live are the anonymous ones, `ANON-01` to `ANON-03`; see the
[harness document](../spikes/github-auth-harness.md#12-verified-live). The questions and their
statuses below are unchanged.

| ID  | Open question                                                                                                           | How it will be resolved                                              |
| --- | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| U1  | Does `GET /user/repos` with a user token list the user's public repos where the app is **not** installed?               | Harness `ACC-04`, `ACC-08`                                           |
| U2  | What private contribution detail is visible to a GitHub App user token (GraphQL)?                                       | Harness `ACC-11`                                                     |
| U3  | Does a token issued **before** installation see newly installed repos without re-authorizing?                           | Harness `ACC-02`, `ACC-03` (before and after)                        |
| U4  | Does the app registration offer wildcard callback matching? (It must stay off.)                                         | Manual (settings page)                                               |
| U5  | Is a loopback IP (`127.0.0.1`) callback with a variable port accepted for GitHub Apps? (Documented for OAuth Apps only) | Manual authorize test                                                |
| U6  | Default response format and error semantics of the web-flow token endpoint. (Device flow returns errors as HTTP 200.)   | Manual; the broker's mocked tests only encode the current assumption |
| U7  | Actions endpoints on public repos without installation; workflow file contents via Contents read                        | Harness `ACC-06`, `ACC-08`                                           |
| U8  | `X-GitHub-SSO` behaviour for **app** tokens (documented for PATs only)                                                  | Harness `ACC-12`, needs an SSO organization                          |
| U9  | Per-user token-minting limits for GitHub Apps (documented for OAuth Apps: 10 tokens and 10 per hour)                    | Observed passively only; not probed deliberately                     |
| U10 | Authorization code lifetime for GitHub Apps (OAuth Apps: 10 minutes)                                                    | Manual; the broker's mocked tests only encode the current assumption |
| U11 | GitHub Pages hostname casing and query-string preservation on the callback path                                         | When Pages is enabled (Phase 11 deploy step)                         |

Also open:

- **Real 304 and rate-limit cost** for conditional requests (harness `ACC-09`). Headers are exposed 🔬,
  but behaviour with a real token is untested.
- **Browser CORS enforcement.** **Not yet verified.** Node cannot enforce it, and the harness only
  inspects headers. The web module exists, but no browser-based CORS test or result is recorded. The
  maintainer's reported local live discovery run would be indirect evidence for the
  `http://localhost:5173` origin only; the GitHub Pages origin is untested.
- **Token revocation against real GitHub.** The broker's revocation call and the web app's handling
  are tested with a mocked GitHub only. A live run with a test account's own token has not
  happened.
- **Refresh-token rotation.** Not exercised by this design: the broker discards the refresh token
  and the product never uses one (D1). Its discard is mock-tested, and the real token response has
  not been observed in recorded evidence. This becomes relevant only if refresh tokens are ever
  adopted.
- **The `sessionStorage` trade-off** (D1) is a design judgement, not an API fact.

## Documentation alignment

`PRIVACY.md`, `SECURITY.md` and `docs/phase-0-assessment.md` were aligned with this ADR and with
[ARCHITECTURE.md](../ARCHITECTURE.md) on 2026-10-27. Since then `SECURITY.md` was rewritten
(2026-10-28) to describe the implemented controls, their test evidence and what is still
unverified. `PRIVACY.md` has not been re-audited against the code. The Phase 0 assessment is kept
as a historical record, with corrected passages marked _(amended)_; it still contains superseded
statements (for example, it describes a lint rule enforcing the read-only wrapper that does not
exist, and its roadmap table predates the implementation). If any of these documents ever differs
from this ADR, this ADR takes precedence.

## Revisit when

- GitHub ships SPA support for GitHub Apps (`github/roadmap#1153`): the broker could be removed.
- Render's free-tier terms change.
- Spike or live verification results contradict any item in the unresolved table.
- A feature needs a permission outside D2, which would require re-approval at every installation.

## References

Official GitHub documentation used for the verified facts:

- [Generating a user access token for a GitHub App](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app)
- [Refreshing user access tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens)
- [Authenticating with a GitHub App on behalf of a user](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-with-a-github-app-on-behalf-of-a-user)
- [About the user authorization callback URL](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/about-the-user-authorization-callback-url)
- [About the Setup URL](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/about-the-setup-url)
- [Making a GitHub App public or private](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/making-a-github-app-public-or-private)
- [Modifying a GitHub App registration](https://docs.github.com/en/apps/maintaining-github-apps/modifying-a-github-app-registration)
- [Best practices for creating a GitHub App](https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/best-practices-for-creating-a-github-app)
- [Authorizing GitHub Apps](https://docs.github.com/en/apps/using-github-apps/authorizing-github-apps)
- [Installing a GitHub App from a third party](https://docs.github.com/en/apps/using-github-apps/installing-a-github-app-from-a-third-party)
- [Requesting a GitHub App from your organization owner](https://docs.github.com/en/apps/using-github-apps/requesting-a-github-app-from-your-organization-owner)
- [SAML and GitHub Apps](https://docs.github.com/en/apps/using-github-apps/saml-and-github-apps)
- [Endpoints available for GitHub App user access tokens](https://docs.github.com/en/rest/overview/endpoints-available-for-github-app-user-access-tokens)
- [Permissions required for GitHub Apps](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps)
- [OAuth application endpoints (revocation)](https://docs.github.com/en/rest/apps/oauth-applications)
- [Rate limits for the REST API](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)
- [Using CORS and JSONP to make cross-origin requests](https://docs.github.com/en/rest/using-the-rest-api/using-cors-and-jsonp-to-make-cross-origin-requests)
- [Authorizing OAuth Apps](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps) (code lifetime and token limits, documented for OAuth Apps only)
- [PKCE support changelog](https://github.blog/changelog/2025-07-14-pkce-support-for-oauth-and-github-app-authentication/)
- [Render free tier](https://render.com/docs/free)
