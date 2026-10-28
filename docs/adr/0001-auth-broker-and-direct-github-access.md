# ADR 0001: Thin auth broker plus direct-to-GitHub data access

- **Status:** Accepted (design), **amended 2026-10-27** after the Phase 2 technical spike. Not yet
  implemented; `apps/api` currently only serves `/health`.
- **Date:** 2026-10-27 (original), amended 2026-10-27

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
  impact: it is read-only, lasts at most 8 hours, and is revoked on logout. They do not remove the
  risk. Memory-only storage would not remove it either (see corrections).
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

## Unresolved behaviour (not yet verified)

These come from the Phase 2 report and must be settled with a real development app. None of them is
assumed in the design above. Evidence is gathered by the
[spike harness](../spikes/github-auth-harness.md) (U1–U3, U7, U8) or by manual checks (the rest).

| ID  | Open question                                                                                                           | How it will be resolved                          |
| --- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| U1  | Does `GET /user/repos` with a user token list the user's public repos where the app is **not** installed?               | Harness `ACC-04`, `ACC-08`                       |
| U2  | What private contribution detail is visible to a GitHub App user token (GraphQL)?                                       | Harness `ACC-11`                                 |
| U3  | Does a token issued **before** installation see newly installed repos without re-authorizing?                           | Harness `ACC-02`, `ACC-03` (before and after)    |
| U4  | Does the app registration offer wildcard callback matching? (It must stay off.)                                         | Manual (settings page)                           |
| U5  | Is a loopback IP (`127.0.0.1`) callback with a variable port accepted for GitHub Apps? (Documented for OAuth Apps only) | Manual authorize test                            |
| U6  | Default response format and error semantics of the web-flow token endpoint. (Device flow returns errors as HTTP 200.)   | Manual, then Phase 3 broker tests                |
| U7  | Actions endpoints on public repos without installation; workflow file contents via Contents read                        | Harness `ACC-06`, `ACC-08`                       |
| U8  | `X-GitHub-SSO` behaviour for **app** tokens (documented for PATs only)                                                  | Harness `ACC-12`, needs an SSO organization      |
| U9  | Per-user token-minting limits for GitHub Apps (documented for OAuth Apps: 10 tokens and 10 per hour)                    | Observed passively only; not probed deliberately |
| U10 | Authorization code lifetime for GitHub Apps (OAuth Apps: 10 minutes)                                                    | Manual, then Phase 3 broker tests                |
| U11 | GitHub Pages hostname casing and query-string preservation on the callback path                                         | When Pages is enabled (Phase 11 deploy step)     |

Also open:

- **Real 304 and rate-limit cost** for conditional requests (harness `ACC-09`). Headers are exposed 🔬,
  but behaviour with a real token is untested.
- **Browser CORS enforcement.** Node cannot enforce it; verified in the Phase 3 web module.
- **Refresh-token rotation and revocation** against real GitHub. Both need the client secret, so they
  are tested with a mocked GitHub in Phase 3 and then once against a development app.
- **The `sessionStorage` trade-off** (D1) is a design judgement, not an API fact.

## Documentation alignment

`PRIVACY.md`, `SECURITY.md` and `docs/phase-0-assessment.md` have been aligned with this ADR and
with [ARCHITECTURE.md](../ARCHITECTURE.md). The Phase 0 assessment is kept as a historical record,
with corrected passages marked _(amended)_. If any of these documents ever differs from this ADR,
this ADR takes precedence.

## Revisit when

- GitHub ships SPA support for GitHub Apps (`github/roadmap#1153`): the broker could be removed.
- Render's free-tier terms change.
- Phase 3 spike results contradict any item in the unresolved table.
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
