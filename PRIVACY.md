# Privacy Statement

_Status: this describes how the application is **designed** to work. **Sign-in and GitHub data
access do not exist yet and nothing is deployed.** Today the app contains no authentication, has
no GitHub App behind it, and collects no user data. Sections below that describe sign-in explain the
**intended** behaviour so you can judge it before it is built._

GitHub Visual Universe is free, open-source software. It has no accounts of its own, no database and
no advertising. It is read-only: it can look at your GitHub data but never change it.

## What data is involved (intended design)

| Data                                  | Where it goes                                                                                             | Does our server store it?                                                    |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Your GitHub sign-in (a one-time code) | Your browser → our small sign-in server (the "broker", on Render) → GitHub, once per sign-in              | **Not stored.** It does pass through the server while signing in             |
| Your GitHub access token              | GitHub → our broker → your browser. Kept in your browser tab's `sessionStorage`. Sent to `api.github.com` | **Not stored.** It passes through the broker once, and again if you sign out |
| Your GitHub refresh token             | GitHub → our broker, which **discards it**. It is never sent to your browser and never stored             | **No**                                                                       |
| Your repositories, commits, issues, … | Fetched **directly from GitHub to your browser** using your token                                         | Our server is not involved, by design                                        |
| Cached GitHub responses               | Your browser's local storage (IndexedDB), per user _(planned)_                                            | Only on your device; cleared on sign-out                                     |

## What the backend sees

The sign-in server (the broker) **does handle your credentials while you sign in**. That cannot be
avoided: GitHub only hands out a token in exchange for a secret that lives on a server, not in a web
page. During sign-in the broker receives:

- the temporary sign-in code and a one-time verifier from your browser,
- the access token that GitHub returns, which it passes straight back to you,
- a refresh token that GitHub also returns, which it discards immediately,
- your IP address, as any web server does.

When you sign out, your browser asks the broker to revoke the token, so the broker sees the token
once more.

The broker is designed **not to store** any of this and **not to write it to logs**. It does not
read your repositories, issues or pull requests. Render, as the hosting provider, may keep standard
infrastructure logs under its own policy, which we do not control.

## What stays in your browser

- **Access token:** kept in `sessionStorage` for the tab you signed in on. It is cleared when you
  close the tab or sign out, and it expires after about 8 hours (then you sign in again).
- **Refresh token:** never stored in your browser and never sent to it. The sign-in server receives it
  from GitHub, throws it away, and keeps nothing.
- **Cache of GitHub data** _(planned)_: stored on your device only, separately for each user, and
  cleared when you sign out.

## Permissions

The app asks GitHub for **read-only** access to these things only: repository **metadata**,
**contents**, **pull requests**, **issues** and **Actions** (workflows and runs). It does not ask
for any write permission, any organization administration permission, or permission to star
repositories. It cannot create issues or pull requests, change repositories, or write anything to
GitHub.

**Private repositories** are visible to the app only if you **install the GitHub App on the account
that owns them and grant that repository**. Signing in alone is not enough. For an organization's
repositories, an organization owner may need to install or approve the app. Even then, the token
reaches only what you yourself can access, and it is meant to be usable only by you.

## What we cannot promise

No software can promise perfect security, and we want to be clear about the limits:

- A sign-in token in a web page can be read by any script running on that page. We plan strict
  protections against that (a Content Security Policy, no third-party scripts, careful handling of
  repository content). Keeping the token in `sessionStorage` reduces how long it exists, but it does
  **not** remove this risk. The token is read-only and short-lived to limit the damage.
- The sign-in server handles credentials in transit, so a compromised server deployment could in
  principle capture them. We keep that server small and review its code in the open.
- Some behaviours of GitHub's system are **not yet verified**, for example which private
  contribution details GitHub shows to an app like this, and how some organization and enterprise
  settings affect access. This statement will be updated as they are confirmed.

## Analytics and third parties

No analytics, trackers, advertising or third-party scripts. The app talks only to GitHub, the
GitHub Pages host that serves it, and its own sign-in server.

## Your controls

- Sign out to revoke the token and clear the stored token and the local cache _(planned)_.
- Revoke the app any time at GitHub → Settings → Applications.
- Uninstall the GitHub App from your account or organization to remove private-repository access.

## Changes

This statement will be updated alongside any change to how data is handled. History is in Git. For
the technical design, see [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) and
[`docs/adr/0001-auth-broker-and-direct-github-access.md`](./docs/adr/0001-auth-broker-and-direct-github-access.md).
