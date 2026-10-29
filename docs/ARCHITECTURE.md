# Architecture

This document separates what **exists today** from what is **planned**. Rationale and verified
facts are in the [Phase 0 assessment](./phase-0-assessment.md); the authentication and data-access
decision (amended after the Phase 2 spike) is recorded in
[ADR 0001](./adr/0001-auth-broker-and-direct-github-access.md), which takes precedence where the two
differ. `PRIVACY.md`, `SECURITY.md` and the Phase 0 assessment have been aligned with both.

## Status

| Component                          | Status                                                                                                                                                                                             |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| npm workspaces monorepo            | ✅ Implemented                                                                                                                                                                                     |
| `packages/shared` (contracts)      | ✅ `/health`, auth-broker and GitHub response schemas (Zod, lenient optional fields)                                                                                                               |
| `apps/api` (Hono)                  | ✅ `GET /health`, `POST /auth/token`, `POST /auth/revoke`                                                                                                                                          |
| `apps/web` (React + Vite)          | ✅ Sign-in (PKCE), Overview dashboard, Architecture view, Activity view, Disconnect; build-time CSP                                                                                                |
| CI checks                          | ✅ Implemented (not yet run on GitHub)                                                                                                                                                             |
| Authentication design              | ✅ Decided (ADR 0001, amended after Phase 2)                                                                                                                                                       |
| GitHub authorization spike harness | ✅ Prepared, offline-tested. Only the anonymous checks `ANON-01` to `ANON-03` have been run live; **no account-dependent check has**.                                                              |
| GitHub App registration            | 🟡 Reported by the maintainer as created and installed, with credentials kept locally. Not verifiable from the repository.                                                                         |
| Auth broker + sign-in (PKCE)       | ✅ Implemented and mock-tested. 🟡 Live use is **maintainer-reported only** (not reproducible from the repository); token revocation is not verified live. See [Known gaps](#known-gaps).          |
| GitHub data layer (read-only)      | 🟡 Repository discovery, `GET /user`, branch head and file tree, commit, branch and pull request lists (mock-tested; all 3 lists are also maintainer-reported working locally); the rest is later. |
| Visualizations                     | 🟡 Overview, language chart, file-tree architecture, a per-repository activity timeline, history graph and pull request list done; the rest (Phases 7–10)                                          |
| Deployment (Pages + Render)        | ⏳ Planned (Phase 11)                                                                                                                                                                              |

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

| Property                                                         | Status                                                                                                             |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| One user cannot read another user's private data through the app | Relies on GitHub's user/app intersection. To be checked by the harness; **not yet run** (an assumption until then) |
| The broker keeps no user credentials at rest                     | By design (stateless, no database, no disk)                                                                        |
| The broker cannot read repository data                           | By design (holds no installation token, PAT or app private key)                                                    |
| A compromised broker deployment cannot capture tokens            | **Not guaranteed.** It sees tokens in transit. Mitigated, not eliminated                                           |
| The token is safe from script running on our origin              | **Not guaranteed**, with `sessionStorage` or with memory-only storage                                              |

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
- **Architecture view (Phases 5 and 6).** The detail panel's "View architecture" button opens a
  read-only view of one repository's file tree on its **default branch**. It needs no backend
  change: the browser calls `api.github.com` directly with the user's token, using the Contents
  (read-only) permission that was already part of the App.
  - _Requests (all GET):_ `GET /repos/{owner}/{repo}/branches/{branch}` (head commit and tree SHA),
    then `GET /repos/{owner}/{repo}/git/trees/{tree_sha}?recursive=1`. If the repository list did
    not include a default branch, one `GET /repos/{owner}/{repo}` comes first. A repository too
    large for that one request adds the per-folder listings described under _Large repositories_
    below. File contents, blobs and other branches are never requested. Owner and repository names
    are validated before they are placed in a URL, and every tree SHA is validated as hex (by the
    shared schema, and again before each request).
  - _What it shows:_ a snapshot "of branch X at commit abc1234" with totals (files, folders, total
    size, deepest level, symlinks, submodules), a treemap of the current folder (tiles sized by
    bytes or by file count, drawn with SVG attributes only: no inline `style`, no chart library), a
    breadcrumb, a table of the folder's entries (the keyboard and screen-reader route to the same
    information), and a count of files by extension (a file count, not lines of code). Folders
    open from the table, the treemap or the breadcrumb.
  - _Partial data:_ entries that cannot be read, or that contradict the tree, are skipped, counted
    and reported, and every figure is then labelled **Partial** ("lower bounds, not totals"). A
    file without a reported size counts as a file but adds no bytes, and is reported. The view
    never presents an incomplete listing as complete.
  - _Large repositories (Phase 6):_ GitHub caps a recursive listing at 100,000 entries or 7 MB and
    then sets `truncated`. A cut-off listing is not guaranteed to be a clean prefix of the tree, so
    none of it is used. The view discards it and lists only the root's direct children
    (`GET /repos/{owner}/{repo}/git/trees/{tree_sha}`, sent without a `recursive` parameter,
    because GitHub treats any value of it as true). This is "lazy" mode: the root's folders start
    out **not loaded**, and a folder is listed when it is opened (from the table, the treemap or
    the breadcrumb, or with its "Load this folder" button), by the tree SHA GitHub gave for it. A
    repository that fits in one request is read completely up front and makes no folder requests.
  - _How folders are loaded:_ each folder takes one non-recursive request. Concurrent requests for
    one folder share a single request, a folder that is already listed is not requested again, and
    at most four requests are active at once (the rest wait in a queue). Files, symlinks,
    submodules and folders without a well-formed SHA are never requested; such a folder is shown
    as "cannot be loaded". Nothing is loaded in advance or retried automatically.
  - _Figures while folders are missing:_ a folder that has not been listed has an unknown size and
    file count, shown as "—" and never as `0`, and it is not drawn in the treemap. Totals and each
    folder's figures cover only what has been listed, and are marked "≥" while they are lower
    bounds (a floor of zero is shown as "—", not "≥ 0"). The summary says **Partial** until every
    folder has been listed with nothing cut off or unreadable, and **Complete** after that.
  - _Cut-off folders:_ a single folder can itself be too large for GitHub to list in full (it sets
    `truncated` on that folder's own listing, or on the root's). Its missing entries cannot be
    loaded and asking again will not bring them back, so the view says so and the repository stays
    **Partial** even after every folder has been loaded.
  - _Failures:_ an empty repository (409), a missing branch or no access (404), a refusal such as a
    missing Contents permission (403), rate limits and network errors each have their own message
    with "Try again"; a 401 ends the session as everywhere else. If the root listing of a large
    repository fails, that failure is reported; the cut-off data is not used as a fallback. A
    failure while loading a folder affects only that folder: it is shown as failed with a fixed
    message (nothing from GitHub's response is echoed), and "Try again" is offered only when
    asking again could help (a network error, a server error or 408, or a rate limit). When GitHub
    reports that the rate limit is used up, no further requests are made until the reset time
    GitHub gave (`retry-after` first, otherwise `x-ratelimit-reset`), and the view says when
    folders can be loaded again. A 401 on any folder ends the session: requests in flight are
    cancelled and nothing more is requested.
  - _Untrusted paths:_ file and folder names come from the repository. They are shown as text only
    (control and bidirectional-override characters are replaced, long names cut), are never used
    to build URLs, and `.`/`..` are plain names: nothing is resolved.
  - _Nothing is stored:_ the listing, including any folders loaded later, lives in memory while the
    view is open and is dropped when you go back. There is no cache.
- **Activity view.** The detail panel's "View activity" button, next to "View architecture", opens a
  read-only view of one repository's recent commits on its **default branch**, its branches and,
  on request, its pull requests.
  The dashboard keeps its state (it is hidden, not unmounted) and one view is open at a time
  (`{ kind: 'architecture' | 'activity'; repoId }`). It needs no backend change and no new
  permission, dependency or storage: the browser calls `api.github.com` through the same `githubGet`
  wrapper (GET only, no credentials, no redirects, 30 s timeout).
  - _Requests (all GET, none until the view is opened):_
    `GET /repos/{owner}/{repo}/commits?per_page=100[&sha={default branch}]` and
    `GET /repos/{owner}/{repo}/branches?per_page=100`. Older pages are fetched by following
    GitHub's `Link: rel="next"` URL, which must be on `api.github.com`. **These two endpoints are
    mock-tested, and have no recorded live evidence.** The maintainer reports a live run in their own
    browser (see "Live verification status"); which permission GitHub requires for them has not been
    checked against a live token. No GraphQL, no per-commit requests, no file contents.
  - _Limits:_ 100 items per page and at most **5 pages (500 items) per list**. Further pages load
    only when asked ("Load older commits" / "Load more branches"); nothing loads in advance or is
    retried automatically. At the cap the view says GitHub has more that cannot be loaded here.
  - _What is kept:_ per commit the first line of the message, author name and login, the author
    date (the committer date if it is missing or unreadable), the SHA and the parents' SHAs (more
    than one is shown as a merge; a parent that cannot be read is kept as an unreadable entry,
    not dropped, and no other parent field is kept); per branch its name, protected flag and head SHA. Author **email
    addresses and message bodies are dropped** by the shared schema, never held. Text is shown
    through the same sanitizer as file names (control, bidirectional and zero-width characters
    replaced, 200-character cap).
  - _Timeline:_ commits per UTC day, week (Monday start) or month, chosen from the span of the loaded
    dates (up to 120 days: days; up to three years: weeks; else months), zero-filled. A date is not
    plotted if it is missing, unreadable, before 2005-04-07 or later than tomorrow (UTC); those
    commits stay in the table, are counted and reported. The chart is an SVG drawn with attributes
    only (no inline `style`), with the table as its accessible equivalent. Dates are whatever the
    commit says (an author can set any date), so the timeline is not evidence of when work was done.
  - _History graph:_ the parent links of the loaded commits, drawn above the table with no extra
    request (it is laid out from the parent SHAs already in each commit). `buildHistoryGraph`
    (`apps/web/src/activity/historyGraph.ts`) is one pass in GitHub's order, newest first. A lane
    is a column waiting for one parent; when that commit's row arrives every line waiting for it
    ends there. The first parent continues in the commit's lane and further parents of a merge join
    a lane already waiting for them or take the lowest free one. It is `O(commits x lanes)`, has
    no recursion (self-parents and cycles end), and rows already laid out never move when older
    commits are appended: loading more only adds rows and joins open lines. At most **12 lanes**
    are drawn; a link with no free lane is dropped and counted, and a commit with no lane at all
    sits in one extra, hollow, grey column. Nothing is guessed: a root commit (no parents), a commit
    whose parents GitHub did not state, an unreadable parent, a parent that is not loaded (a
    dashed line to the bottom, explained differently while more can be loaded, at the 500 cap and
    at the end), a parent listed above its child (GitHub's order is not guaranteed to put parents
    below children, so this can happen: no line is drawn, the child gets a dashed blue outline and a
    small up arrow, and the Parents column says "listed above"; a commit listed as its own parent
    says "itself") and a repeated commit (drawn hollow, without lines, counted) are distinct states,
    each with a shape or class and a sentence under the graph. Subjects are shown as text (cut
    at 72 code points; the whole subject is in the tooltip). The drawing uses SVG attributes and
    CSS classes only (no inline `style`), is one labelled image inside a keyboard-focusable
    scrollable region, and the table's **Parents** column lists the same links as text. Each parent entry of an
    examined commit has exactly one outcome in the layout (drawn, dropped for lack of a lane, listed
    above, or unreadable); a repeated copy's entries are not examined. Only the
    default branch's loaded commits are drawn: not other branches, pull requests or file changes.
  - _Pull requests (read-only, on request):_ a third panel on the Activity page, between Commits
    and Branches. It lives on this page, not in a view of its own, because matching a merged pull
    request to a commit needs the commits that the history graph has loaded, and a separate view
    would either lose them or fetch them again. **Nothing about pull requests is requested when
    the page opens**: the panel is a "Load pull requests" button, and the list (with its own paging,
    failure and rate-limit handling) exists only after it is pressed.
    - _Request:_ `GET /repos/{owner}/{repo}/pulls?state=all&sort=updated&direction=desc&per_page=100`
      through the same `githubGet` wrapper (GET only). Later pages are fetched only when asked
      ("Load older pull requests") by following GitHub's `Link: rel="next"` URL, at most **5 pages
      (500 pull requests)**; nothing loads in advance, nothing is retried or polled, and there is
      **no request per pull request**. No GraphQL, no new permission, dependency, endpoint or
      storage. It needs the **Pull requests (read)** permission, which the maintainer reports is
      enabled; the repository cannot show this.
    - _What is kept:_ per pull request its number, title, state, draft flag, the four dates, the
      head and base branch names, the author's login and its merge commit SHA. Bodies, labels,
      reviewers, e-mail addresses and the head and base repositories are dropped by the shared
      schema, so a pull request whose head repository was deleted is read like any other. Text is
      shown through the same sanitizer as commits. An entry without a usable number or state, or
      an open one that also has a merge date (a contradiction), is skipped and counted, and the
      list says it is incomplete. Missing branch names, author, title or dates are shown as absent
      ("not stated", "Unknown", "(no title)", "date unknown"), never as zero or an invented value.
    - _States:_ **Open**; **Draft** (open, and GitHub said so; an open PR without the flag is shown
      as open, and says its draft status was not stated); **Merged** (closed, with a merge date);
      **Closed** (closed without one). Each row shows the number and title, the state,
      base ← head, the author, and the date that fits the state (opened, merged or closed, in UTC).
    - _Linking a merged pull request to the history graph:_ `linkMergeCommit`
      (`apps/web/src/activity/pullLinks.ts`) compares the PR's `merge_commit_sha`, **as a whole and
      exactly**, with the SHAs of the commits already loaded. A match becomes a button that moves
      focus to that commit's row in the table (it is not a URL fragment, which could disturb the
      sign-in address handling). Nothing else is compared: not branch names, titles, dates,
      abbreviated or near-miss SHAs (an abbreviated one is not even accepted as a SHA). GitHub
      documents the field as naming a commit on the base branch for every way of merging (see
      "`merge_commit_sha`: documented versus verified" below), so the three methods link the same
      way; the list data cannot tell a squash from a rebase, and the view does not claim to. Only a
      commit with two or more parents is called a merge commit. A merge commit that is not loaded says **"Merge
      commit not loaded"**, with the reason: the commits are still loading or failed, older commits
      can be loaded above, the loading limit was reached, or it is not among the loaded commits of
      the default branch (the pull request may have been merged into another branch). For a PR
      that is not merged, GitHub's `merge_commit_sha` is a throwaway test merge, so it is dropped
      and never linked, and a merged PR without a stated SHA says so.
    - _`merge_commit_sha`: documented versus verified._
      - _Documented_ (GitHub REST API, "Get a pull request" on
        [Pull requests](https://docs.github.com/en/rest/pulls/pulls), read 2026-10-29): before a
        pull request is merged the field holds the SHA of a test merge commit, which is not added to
        the base or head branch. After it is merged, the field is the SHA of the merge commit (merge
        commit method), the SHA of the squashed commit on the base branch (squash), or "the commit
        that the base branch was updated to" (rebase).
      - _Limit of that documentation:_ the text is on the single-pull-request endpoint. In the page
        as read, it is not repeated for the list endpoint this view uses
        (`GET /repos/{owner}/{repo}/pulls`), so that the list gives the same values with the same
        meaning is **an assumption** that the code relies on. The comment in the code that calls the
        rebase value "the last of the rebased commits" is a paraphrase, not GitHub's wording.
      - _Observed, once, outside the application:_ on 2026-10-29 a read-only call to the list
        endpoint (GitHub CLI, not part of the tests, not recorded elsewhere) gave, for this
        repository's eight merged pull requests (#1 to #8), a `merge_commit_sha` equal to a
        two-parent commit on `main`, and for the open #9 a SHA that is not in `main`'s history. That
        agrees with the documentation for the **merge commit method** and for the test merge. It is
        a one-time observation that anyone with access can repeat; it is not a test.
      - _Not verified live:_ the **squash** and **rebase** methods. No such pull request was seen,
        so the squash and rebase handling is mock-tested against fixtures that assume the
        documented meaning, and it has not been tested live.
    - _Failures:_ the list loads and fails independently of commits and branches. A 401 ends the
      session once, together with the other lists. A 403 says the GitHub App may be missing read
      access to Pull requests (or is not installed on the repository). A rate limit pauses further
      requests until GitHub's reset time and offers no retry. A failed later page keeps the loaded
      rows and retries the same page. An empty list is shown as **Empty**. Messages are fixed
      strings: nothing from a response is echoed.
    - _Accessibility:_ one table with a caption, column headers and a row header per row; the arrow
      in base ← head has a spoken equivalent; the state is always a word, the colour only backs it
      up; the link button's name says which commit it shows.
    - _Status:_ **mock-tested, and maintainer-reported working** in the maintainer's own browser
      with the local app. First report: the pull request list loaded, a merged pull request's
      commit button took the reader to the matching commit row, and the row was focused, scrolled
      into view and highlighted, as intended. Second report (2026-10-29), from a screenshot the
      maintainer holds and this repository does not: 9 pull requests loaded, #9 was shown as
      Draft, merged pull requests showed their merge commit links, and the table layout was
      readable. These are reports, not recorded evidence: the repository cannot reproduce them, and
      they do not name the merge method or say whether light and dark mode were both looked at.
      **No automated browser test exists.** Nine pull requests fit on one page, so paging beyond
      the first page was not exercised. Not reported, so unverified live: paging beyond the first
      page, the 403, rate-limit and other error states, a repository with many pull requests,
      forks (including deleted head repositories), narrow screens, and `merge_commit_sha` for the
      squash and rebase methods (see "`merge_commit_sha`: documented versus verified").
  - _Partial data:_ each list is labelled **Complete** (the last page was reached and nothing was
    skipped), **Partial** (more exists, the cap was reached, or entries were unreadable and
    skipped and counted), **Partial, with an error** (a later page failed) or **Failed**. The count
    shown is "N loaded", never the repository's total.
  - _Failures:_ commits and branches load and fail independently. A failed first page offers
    "Try again" only when asking again could help. A failed later page keeps what was loaded and
    retries the same page. An empty repository (409 on commits) is shown as empty. When GitHub
    reports the rate limit is used up, no request is made until the reset time it gave. A 401 on
    either list ends the session exactly once and cancels the other. Messages are fixed strings:
    nothing from a response is echoed.
  - _Known limit:_ if a commit is pushed while older pages are being loaded, the same commit can
    appear on two pages; it is not de-duplicated.
  - _Nothing is stored:_ everything lives in memory while the view is open and is dropped when you
    go back. There is no cache, `localStorage` or IndexedDB.
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
  prints tokens or repository names. It is covered by offline tests against a mock server, which run
  in CI as part of `npm test` (`npm run test:spikes`) and use no credentials.
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
- **Live verification status.** Terms: _recorded live evidence_ is in this repository;
  _maintainer-reported_ means the maintainer says it was done and the repository cannot reproduce or
  confirm it; _mock-tested_ means automated tests with fake GitHub responses, which show the code
  behaves as designed but say nothing about real GitHub.
  - _Recorded live evidence:_ only the anonymous harness checks `ANON-01` to `ANON-03` (CORS
    preflight responses and exposed headers, inspected from Node), as in
    [ADR 0001](./adr/0001-auth-broker-and-direct-github-access.md#implementation-status-2026-10-28).
  - _Maintainer-reported:_ sign-in and repository discovery against real GitHub (personal, private
    and organization repositories were listed), and, separately, opening the architecture view of
    one small repository (see "Architecture view limits"). These are separate reports. **No evidence
    covers the whole flow (sign-in, then dashboard, then architecture view) as one verified live
    run.**
  - _Maintainer-reported (Activity view, 2026-10-29):_ in the maintainer's own browser the
    connection was read-only and successful, the commit and branch requests returned HTTP 200,
    small repositories loaded as **Complete**, commit subjects showed only their first line, merge
    badges and the default-branch indicator worked, and a repository with more than 500 commits
    showed the 500-commit cap, with no visible application error. Separately, the history graph
    was looked at on two real repositories (10 and 17 loaded commits): it rendered, merge commits
    and several lanes were visible, the Parents column was shown, and no obvious rendering
    problem was noticed in the maintainer's screenshots. The screenshots are not in this
    repository. See "Activity view limits" for what these reports do not cover.
  - _Maintainer-reported (Pull requests panel):_ the list loaded, and the merged-pull-request
    commit button, row focus, scrolling and highlight worked, in the maintainer's own browser with
    the local app; a second report (2026-10-29) says 9 pull requests loaded with #9 shown as
    Draft. Details and what the reports do not cover are under the Pull requests _Status_ above
    and "Pull requests panel limits".
  - _Mock-tested only:_ every automated test uses mocks.
  - _Not verified live:_ the dashboard's extra repository fields (read from GitHub's documented
    response), `GET /user`, and token revocation. Account-dependent behaviour (user isolation,
    private-repository access, U1 to U11) is also unverified.
- **Dashboard limits:** language is a repository count by primary language, not bytes. Pull
  requests are listed only in the Activity view; issues and workflows have no views yet. The 30-page cap means an
  account with more than about 3,000 accessible repositories shows partial statistics until
  "Load more" is used. The installation list itself is capped at 10 pages.
- **Architecture view limits:** default branch only. For a repository over GitHub's tree limit only
  the root is listed at first and each folder is loaded when it is opened, one request per folder,
  with nothing loaded in advance. The repository stays **Partial** until every folder has been
  listed, and a folder that GitHub itself cuts off can never be completed. Sizes are the sizes of
  Git blobs (a Git LFS file shows its small pointer size), and committed build output or vendored
  folders will dominate a size view. Reported by the maintainer as run live on one small
  repository (branch and tree requests, 65 entries, not truncated); this is not recorded evidence and
  the repository cannot reproduce it. Not yet verified live: lazy loading of a
  large repository (a truncated tree, per-folder listings and their rate limits), an empty
  repository, a branch name containing `/`, an organization repository, submodules and symlinks
  (covered by mocked tests only).
- **Activity view limits:** default branch only, at most 500 commits and 500 branches per view, a history
  graph of the loaded commits only (no other branches, no pull-request relationships beyond the
  merge-commit links below, no zoom, pan or export), no per-commit detail. **Mock-tested, and
  maintainer-reported working in a local browser** for commits, branches and the history graph (no
  recorded evidence, no automated browser test; see "Live verification status"). **Not verified
  live:** which permission GitHub requires for the commit and branch endpoints (not checked
  against a live token), an empty repository, an organization repository, a repository with many branches, a
  default branch name containing `/`, and whether real orderings always put every parent below its
  child (the graph was looked at on two small repositories). Paging is reported only as far as the
  500-commit cap being shown.
- **Pull requests panel limits:** the 500 most recently updated pull requests at most; a list, not a
  graph (no review, comment, file or check detail, no head-to-base network); a merged pull request
  is linked only to a commit that is loaded, so older merges (and merges into other branches) show
  "Merge commit not loaded"; squash and rebase merges are not told apart; no filters or search.
  **Mock-tested, and maintainer-reported working in a local browser** (no recorded evidence, no
  automated browser test; see the Pull requests _Status_ above for what was and was not reported).
  **Not verified live:** which permission GitHub requires for the pull request list, paging beyond
  the first page, the 403 and rate-limit states, forks, and the squash and rebase methods
  (mock-tested only).
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
