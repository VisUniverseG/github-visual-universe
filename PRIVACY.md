# Privacy Statement

_Status: this describes how the application is **designed** to work and what its code does today.
**Sign-in, a read-only repository overview and a repository architecture (file tree) view are
implemented for local development; nothing is deployed.** Their automated tests use mocked GitHub
responses. The maintainer reports running sign-in, repository discovery and one small repository's
architecture view against real GitHub; that report cannot be reproduced from this repository. Token
revocation and the items under "What we cannot promise" have **not** been verified live. The app has
no accounts and no database, and its code stores no user data on any server. Sections below that
describe sign-in explain the behaviour so you can judge it before it is deployed._

Where this statement says something is **implemented**, that was checked against the source code. An
**assumption** depends on GitHub's behaviour or on settings that this repository cannot show.

GitHub Visual Universe is free, open-source software. It has no accounts of its own, no database and
no advertising. It is read-only: it can look at your GitHub data but never change it.

## What data is involved (design and current implementation)

| Data                                                                                                  | Where it goes                                                                                                                                                     | Does our server store it?                                                    |
| ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Your GitHub sign-in (a one-time code)                                                                 | Your browser → our small sign-in server (the "broker"; planned host: Render) → GitHub, once per sign-in                                                           | **Not stored.** It does pass through the server while signing in             |
| Your GitHub access token                                                                              | GitHub → our broker → your browser. Kept in your browser tab's `sessionStorage`. Sent to `api.github.com`                                                         | **Not stored.** It passes through the broker once, and again if you sign out |
| Your GitHub refresh token                                                                             | GitHub → our broker, which **discards it**. It is never sent to your browser and never stored                                                                     | **No**                                                                       |
| Your repositories' metadata and your GitHub login                                                     | Fetched **directly from GitHub to your browser** using your token. Kept in memory while the page is open; not written to storage                                  | Our server is not involved, by design                                        |
| Your repositories' file and folder names and sizes                                                    | Fetched **directly from GitHub to your browser** when you open the architecture view. Kept in memory while that view is open                                      | Our server is not involved, by design                                        |
| Commit subjects, author names and logins, commit dates, branch names                                  | Fetched **directly from GitHub to your browser** when you open a repository's activity view. Kept in memory while that view is open                               | Our server is not involved, by design                                        |
| Commit author email addresses, commit message bodies                                                  | **Never read by the app.** GitHub's response contains them, but the app discards them as it reads the response                                                    | Not applicable                                                               |
| Pull request numbers, titles, states, dates, branch names, author logins and merge commit identifiers | Fetched **directly from GitHub to your browser** only when you press "Load pull requests" in a repository's activity view. Kept in memory while that view is open | Our server is not involved, by design                                        |
| Issues, workflow runs, file contents                                                                  | **Not read by the app today**                                                                                                                                     | Not applicable                                                               |
| Cached GitHub responses                                                                               | Your browser's local storage (IndexedDB), per user _(planned; **no cache exists today**)_                                                                         | Only on your device; cleared on sign-out                                     |

**Repository overview.** After you sign in, your browser asks GitHub which repositories the app is
installed on and reads, for each: its name, owner, visibility (public or private), description,
primary language, star, fork and open-issue counts, dates, default branch, topics, and whether it is
archived or a fork. It also reads your GitHub login, to tell which repositories are yours. This
stays in memory while the page is open and is lost when you reload or sign out; it is not written to
storage or sent to our server.

**File names in the architecture view.** When you open a repository's architecture view, your
browser reads that repository's **file and folder names and sizes** directly from GitHub, using your
token. It does not read file contents. For large repositories it lists one folder at a time, only
when you open it. The browser also receives GitHub's record of the branch's latest commit, but the
app reads only the commit and tree identifiers from it. The listing is kept in memory only while the
view is open (it is not written to storage) and is dropped when you go back; it is not cached,
stored or sent to our server.

**Commits and branches in the activity view.** When you open a repository's activity view, your
browser reads, directly from GitHub and using your token, up to 500 of the latest commits on the
repository's default branch and up to 500 of its branches. From each commit it keeps only the
**first line of the message** (the subject), the **author's name and GitHub login**, the commit
date, the commit's identifier and the identifiers of its parents (to draw the history graph). From each branch it keeps the name,
whether it is protected, and the identifier of its latest commit. It **never reads or keeps author
email addresses or the rest of a commit message**, and it does not read file contents. Commit
subjects can contain anything their authors typed, and names and logins identify the people who
made the commits, who may not be you: you can see them because the repository is accessible to you,
but be careful about screen-sharing or screenshots of this view. All of it is kept in memory only
while the view is open (it is not written to storage), is dropped when you go back, and is not
cached or sent to our server. Everything shown is only what has been loaded: the view labels a
list **Partial** while more exists, and never presents the number loaded as the repository's total.

**Pull requests in the activity view.** Nothing about pull requests is requested when the activity
view opens. Only when you press **Load pull requests** does your browser read, directly from GitHub
and using your token, up to 500 of the repository's most recently updated pull requests, one page
of 100 at a time and only when you ask for each. From each it keeps only the **number, title,
state, whether it is a draft, its created, updated, closed and merged dates, the names of its head
and base branches, the author's GitHub login and, for a merged pull request, the identifier of the
commit it produced**. It **never reads or keeps descriptions, comments, reviews, labels, reviewers,
e-mail addresses or file changes**, and it does not read the head repository. Titles and branch
names can contain anything their authors typed, and logins identify the people who opened the
pull requests, who may not be you. The same rules as for commits apply: kept in memory only while
the view is open, dropped when you go back, never written to storage or sent to our server, and
labelled **Partial** while more exists.

## What the backend sees

The sign-in server (the broker) **does handle your credentials while you sign in**. That cannot be
avoided: GitHub only hands out a token in exchange for a secret that lives on a server, not in a web
page. During sign-in the broker receives:

- the temporary sign-in code, a one-time verifier and the callback address from your browser,
- the access token that GitHub returns, which it passes straight back to you,
- a refresh token that GitHub may also return, which it discards immediately,
- your IP address and the website address (origin) your browser sends it from, as any web server
  does.

Your browser also contacts the broker just before you are sent to GitHub, to wake it up, so the
broker sees that request too.

When you sign out, your browser asks the broker to revoke the token, so the broker sees the token
once more. The broker then asks GitHub to revoke it, using the app's secret.

In the code, the broker **stores nothing** (it has no database or session store and writes no
files) and writes only fixed failure messages to its logs (for example "GitHub rejected the code"),
never codes, verifiers, tokens or request contents. Mocked tests check that no secret, code,
verifier or token appears in its logs or responses; this has **not** been verified on a live
deployment, because nothing is deployed. The broker has no route that reads your repositories,
issues or pull requests. Render, as the planned hosting provider, may keep standard infrastructure
logs under its own policy, which we do not control.

## What stays in your browser

- **Access token:** kept in `sessionStorage` for the tab you signed in on. It survives a reload of
  that tab and is cleared when you close the tab or sign out. It is also removed when it is within a
  minute of expiring or when GitHub rejects it. It is expected to expire after about 8 hours (then
  you sign in again); that is GitHub's documented lifetime and has not been measured by us, and the
  broker refuses to hand out a token that has no expiry. It is sent only to `api.github.com`, in an
  `Authorization` header, and never placed in a web address.
- **Temporary sign-in data:** while you sign in, a random `state` value, a one-time verifier, the
  callback address and a timestamp are kept in `sessionStorage` for at most 10 minutes. They are
  removed as soon as the sign-in response is read, whether it succeeds or fails.
- **Refresh token:** never stored in your browser and never sent to it _(implemented and
  mock-tested; the real response from GitHub has not been observed in recorded evidence)_. The
  sign-in server receives it from GitHub, throws it away, and keeps nothing.
- **Repository data:** held in memory only (see above), never in storage.
- **Cookies, `localStorage` and IndexedDB:** the app's code sets no cookies and uses no
  `localStorage` or IndexedDB (found by searching the source). Requests to GitHub are sent without
  cookies.
- **Cache of GitHub data** _(planned; none exists today)_: stored on your device only, separately
  for each user, and cleared when you sign out.

## Permissions

The app is meant to ask GitHub for **read-only** access to these things only: repository
**metadata**, **contents**, **pull requests**, **issues** and **Actions** (workflows and runs), and
not for any write permission, any organization administration permission, or permission to star
repositories. These permissions are set in the GitHub App's registration on GitHub, which is not part
of this repository, so this list is the **intended** configuration and has **not** been checked with
a live token.

What the code does today:

- The web app sends only `GET` requests to `api.github.com`. It reads your login, the list of
  installations and their repositories, repository default branches, branch heads, file listings,
  commit and branch lists, and, when you press "Load pull requests", the repository's pull request
  list (see above). It does not yet use the issue or Actions permissions, so those are requested by
  design but unused. The commit and branch lists rely on the Contents (read) permission and the
  pull request list on the Pull requests (read) permission; which permission GitHub actually
  requires for them has **not** been checked against a live token.
- The code has no call that creates or edits issues, pull requests, repositories or any other
  GitHub data.
- The only request that is not a read is made by the sign-in server when you sign out: it asks
  GitHub to revoke your own token. That changes the state of the token, not of any repository,
  issue or pull request.

**Private repositories** are visible to the app only if you **install the GitHub App on the account
that owns them and grant that repository**. Signing in alone is not enough. For an organization's
repositories, an organization owner may need to install or approve the app. GitHub is expected to
limit the token to what you yourself can access, and it is meant to be usable only by you. That is
an **assumption**: it has not been verified with real accounts, and the harness checks that would
test it have not been run.

## What we cannot promise

No software can promise perfect security, and we want to be clear about the limits:

- A sign-in token in a web page can be read by any script running on that page. We use strict
  protections against that (a Content Security Policy in the built site, no third-party scripts, and
  repository file names shown as plain text; no repository text such as a README is rendered yet).
  The Content Security Policy is implemented but its enforcement in real browsers has not been
  tested, and the development server has none. Keeping the token in `sessionStorage` reduces how
  long it exists, but it does **not** remove this risk. The token is meant to be read-only
  (that depends on the unchecked app permissions above) and short-lived to limit the damage.
- The sign-in server handles credentials in transit, so a compromised server deployment could in
  principle capture them. We keep that server small and review its code in the open. It also has no
  rate limiting yet, which is required before any public deployment.
- Some behaviours of GitHub's system are **not yet verified**, for example which private
  contribution details GitHub shows to an app like this, how some organization and enterprise
  settings affect access, whether private repositories and accounts are isolated from each other as
  designed, whether GitHub enforces the one-time verifier used at sign-in, and whether sign-out
  really revokes the token at GitHub. The open questions are listed in
  [`SECURITY.md`](./SECURITY.md#unresolved-behaviour). This statement will be updated as they are
  confirmed.

## Analytics and third parties

No analytics, trackers, advertising or third-party scripts. The code contains none, makes no
telemetry or error-reporting calls, and does not log to the browser console. In the built site a
Content Security Policy also blocks scripts and network requests to anything else (not tested in
real browsers).

The app talks only to:

- `api.github.com`, for your data, with your token;
- its own sign-in server;
- `github.com`, where your browser is sent to authorize the app when you sign in; and
- the host that serves the page (planned: GitHub Pages).

GitHub, the page host and Render, as providers, see your IP address and may keep logs under their
own policies, which we do not control.

## Your controls

- Sign out. Your browser immediately clears the stored token and the temporary sign-in data, then
  asks the sign-in server to revoke the token at GitHub. The page says whether GitHub confirmed the
  revocation. If it did not, the token stays valid until it expires (about 8 hours) unless you revoke
  the app at GitHub. Revocation has not been verified against real GitHub. Clearing a local cache on
  sign-out is _planned_, because no cache exists yet.
- Revoke the app any time at GitHub → Settings → Applications.
- Uninstall the GitHub App from your account or organization to remove private-repository access.

## Changes

This statement will be updated alongside any change to how data is handled. History is in Git. For
the technical design, see [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) and
[`docs/adr/0001-auth-broker-and-direct-github-access.md`](./docs/adr/0001-auth-broker-and-direct-github-access.md).
