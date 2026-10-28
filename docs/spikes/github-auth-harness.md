# GitHub authorization spike harness: test plan and runbook

Status: **prepared. Only the anonymous checks have been run against real GitHub. The account and isolation checks (`ACC-*`, `ISO-*`) have not been run**, because they need real user tokens and fixture repositories that this repository does not contain. The product itself now implements GitHub App sign-in (see the table below), so the harness is no longer a prerequisite for writing authentication code. It remains the plan for gathering evidence on the open questions.

Code: `scripts/spikes/github-auth/` (zero dependencies, Node 24). Run with `node scripts/spikes/github-auth/run.mjs --help`.

Offline tests (no credentials, no internet): `npm run test:spikes`. They also run as part of `npm test` and therefore in CI.

## Current state at a glance

| Level                                         | What it covers                                                                                                                                                                                                                                                                                                                   |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Implemented in the product                    | GitHub App sign-in with PKCE (S256) through the stateless Hono auth broker in `apps/api` (`/auth/token`, `/auth/revoke`), and read-only REST repository discovery and architecture views in `apps/web`. Details: [ARCHITECTURE.md](../ARCHITECTURE.md).                                                                          |
| Mocked or local test coverage                 | The 44 harness tests (a loopback fake of `api.github.com`; run in CI) and the product's Vitest suites (mocked `fetch`). They show that the code behaves as designed. They do not show how real GitHub behaves.                                                                                                                   |
| Verified live against GitHub                  | Harness checks `ANON-01` to `ANON-03` (anonymous, no credentials; see section 11). The maintainer's live sign-in and repository-discovery runs are reported in [ARCHITECTURE.md](../ARCHITECTURE.md); they are documented there and not re-verified here.                                                                        |
| Still unverified live (not run, or no result) | `ACC-01` to `ACC-12` and `ISO-01` to `ISO-05`; U1 to U11 (statuses unchanged, see [ADR 0001](../adr/0001-auth-broker-and-direct-github-access.md#unresolved-behaviour-not-yet-verified)); token revocation; large-repository lazy loading; private and organization isolation with real accounts; real browser CORS enforcement. |

## 1. Decisions this plan is built on

| ID  | Decision                                                                                                              | Effect on the harness                                                                                    |
| --- | --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| D1  | Access token in `sessionStorage` only, no refresh token in the browser, strong XSS protections, trade-off documented  | None directly (Phase 3). The harness never handles refresh tokens and rejects `ghr_` tokens outright.    |
| D2  | Read-only permissions: Metadata, Contents, Pull requests, Issues, Actions. No write, org-admin or starring permission | `ACC-06` proves the needed reads work. `ACC-07` proves endpoints behind _other_ permissions are denied.  |
| D3  | The GitHub App is owned by the `VisUniverseG` organization                                                            | Org owner must register the app. To test with a personal account the app must be public ("Any account"). |

## 2. Safety model (enforced in code, covered by 44 offline tests)

| Rule                                                                                                        | Enforced by                           |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| Only `api.github.com` over HTTPS. `github.com` (OAuth endpoints) is blocked                                 | `assertAllowedRequest`                |
| Only `GET`, `HEAD`, credential-free `OPTIONS`, and GraphQL **queries**                                      | `assertAllowedRequest`                |
| Any GraphQL document containing `mutation` or `subscription` is refused                                     | `assertReadOnlyGraphQL`               |
| Only GitHub App user tokens (`ghu_`) are accepted. PATs, `gho_`, `ghs_`, `ghr_` rejected                    | `assertUserToken`                     |
| Tokens come only from the process environment; never from files or arguments                                | `runner.mjs`                          |
| Tokens, repo names, logins and ids are never printed. Output is counts, statuses, booleans, header presence | check design + `redact`               |
| Redirects are never followed                                                                                | `client.mjs`                          |
| No retries. A `401` or a rate-limit response stops the whole run                                            | `client.mjs`, `runner.mjs`            |
| Hard request budget (default 150, max 500) and a per-check ceiling                                          | `createBudget`, `maxRequests` tests   |
| Nothing is written to disk by the harness                                                                   | design                                |
| The target origin cannot be changed from the CLI or environment                                             | `run.mjs` (only tests can inject one) |

`--dry-run` prints the exact request plan and what would be skipped, and makes **no** requests.

**Offline tests versus live runs.** The 44 tests (`npm run test:spikes`) only talk to loopback servers on `127.0.0.1` that they start themselves, and they pass fake tokens and fixture names to the harness directly. They never read `GVU_SPIKE_*` or any other variable from the process environment (only the CLI entry point, `run.mjs`, does), so CI neither needs nor accepts real tokens or fixture repositories. CI never runs `run.mjs` and makes no live GitHub requests. Live runs stay manual, local and outside CI.

## 3. What the harness tests

Verdicts: `PASS` (matched the hypothesis), `INFO` (evidence recorded, no hypothesis), `UNEXPECTED` (differs from the hypothesis; investigate), `CRITICAL` (violates the security model; stop), `FIXTURE_ERROR` (your test setup is wrong), `SKIPPED` (missing input), `ABORTED` (stopped by a 401, rate limit or budget), `ERROR`.

Exit codes: `0` ok, `1` any `CRITICAL`, `2` usage or safety error, `3` aborted or errored.

### Anonymous (no token, runnable today)

| Check   | What it does                                                                                                                                                                 | Question |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| ANON-01 | Credential-free CORS preflights for `visuniverseg.github.io` and `localhost:5173`, for `GET /user` and `POST /graphql` with `authorization`, `content-type`, `if-none-match` | S6       |
| ANON-02 | Which response headers are exposed to browser JS (`etag`, `link`, `retry-after`, `x-ratelimit-remaining`, `x-github-sso`)                                                    | S4, S6   |
| ANON-03 | `/user` is `401` without a token; anonymous rate-limit shape                                                                                                                 | S4       |

### Account A (one user token plus fixtures)

| Check  | What it does                                                                                                                                                                                           | Question |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- |
| ACC-01 | Identity, token fingerprint, header presence (`x-oauth-scopes`, token-expiration header), hours until expiry, rate-limit shape                                                                         | S4, S5   |
| ACC-02 | Installations the token can see (count, `all` vs `selected`, account types)                                                                                                                            | U3       |
| ACC-03 | Repos granted per installation. Validates your fixtures (granted repo is granted, not-granted repo is not)                                                                                             | S1, U3   |
| ACC-04 | `/user/repos` vs the grant: **CRITICAL** if any private repo outside the grant appears; reports whether un-installed public repos appear                                                               | U1, S1   |
| ACC-05 | The private repo **not granted** to the app: REST metadata, contents and pulls must be denied. **CRITICAL** on `200`                                                                                   | S1       |
| ACC-06 | Granted private repo: all reads the product needs, mapped to D2 permissions (metadata, contents, trees, commits, branches, pulls, issues, workflows, runs; informational: stats, SBOM, workflow files) | S3, U7   |
| ACC-07 | Least privilege: starred, check-runs, combined status, Dependabot, code scanning, hooks, `/user/emails` must be denied                                                                                 | S3       |
| ACC-08 | Public repo without installation: metadata, contents, pulls, issues, Actions                                                                                                                           | U1, U7   |
| ACC-09 | ETag then `If-None-Match` gives `304`; does a `304` cost rate limit (measured via `/rate_limit`, which is free)                                                                                        | S4       |
| ACC-10 | GraphQL: granted repo readable, non-granted repo is `null`, `viewer.repositories(PRIVATE)` has nothing outside the grant (**CRITICAL** otherwise)                                                      | S1, S3   |
| ACC-11 | Contribution totals, restricted-contribution count, per-repo breakdown vs the grant (counts only)                                                                                                      | U2       |
| ACC-12 | Optional SAML-protected org repo: status and presence of `X-GitHub-SSO`                                                                                                                                | U8       |

### Isolation (token A plus token B from an unrelated account)

| Check  | What it does                                                                                 | Question |
| ------ | -------------------------------------------------------------------------------------------- | -------- |
| ISO-01 | Token B really belongs to a different account than token A (otherwise isolation checks skip) | S2       |
| ISO-02 | B cannot read A's granted private repo (6 REST reads and GraphQL). **CRITICAL** on any `200` | S2       |
| ISO-03 | B cannot read A's non-granted private repo. **CRITICAL** on any `200`                        | S2       |
| ISO-04 | B cannot list A's installation repos and shares no installation with A                       | S2       |
| ISO-05 | Anonymous requests cannot read A's private repo                                              | S2       |

Worst case with every input present: **91 requests**, spread over two accounts. Well inside the 5,000/hour per-user limit.

## 4. Question key

`U1` to `U11` come from the Phase 2 report. New ones introduced here:

| ID  | Question                                                                                  |
| --- | ----------------------------------------------------------------------------------------- |
| S1  | Is a user token limited to the intersection of user access and app grant (private repos)? |
| S2  | Can account B ever read account A's private data through the app or anonymously?          |
| S3  | Does the app hold exactly the D2 permissions, no more and no less?                        |
| S4  | Real behaviour of conditional requests, rate-limit headers and header exposure            |
| S5  | Is token-expiry information visible on API responses for GitHub App user tokens?          |
| S6  | CORS behaviour the SPA depends on (preflight, allowed and exposed headers)                |

## 5. Test fixtures (you create these; the harness never does)

**Accounts.** Account A is a personal account you control. Account B is an unrelated account: not a collaborator, not in any shared organization.

**Repositories owned by A** (throwaway, can be tiny, each with one commit, one issue, one PR and one workflow file that has run once):

| Env variable                      | Repo                                                                                 |
| --------------------------------- | ------------------------------------------------------------------------------------ |
| `GVU_SPIKE_REPO_PRIV_GRANTED`     | private; the app **is** installed on it                                              |
| `GVU_SPIKE_REPO_PRIV_NOT_GRANTED` | private; installation is "Only select repositories" and this one is **not** selected |
| `GVU_SPIKE_REPO_PUB_NOT_GRANTED`  | public; the app is **not** installed on it                                           |
| `GVU_SPIKE_REPO_SSO` (optional)   | a repo in a SAML-protected organization                                              |

## 6. Runbook

Nothing below is done by the harness. Steps 1 to 3 are yours.

1. **Register the dev app** under `VisUniverseG` with the settings from the Phase 2 report: D2 permissions only, user-token expiration on, device flow off, "Request user authorization during installation" off, webhook inactive, visibility "Any account", callback `http://localhost:5173/auth/callback`.
2. **Install it on account A** with "Only select repositories": just the `PRIV_GRANTED` repo.
3. **Obtain one user token per account, by hand**, with the standard code flow in a browser plus one `curl` to the token endpoint. Keep the secret and tokens out of shell history and out of chat:

   ```sh
   read -rs GVU_SPIKE_TOKEN_A   # paste, press Enter; nothing is echoed
   export GVU_SPIKE_TOKEN_A
   ```

   Do not use or store the `refresh_token` from the response. Tokens last 8 hours. Unset them when done.

4. **Dry run** first (no requests): `node scripts/spikes/github-auth/run.mjs all --dry-run`
5. **Anonymous:** `... anonymous`
6. **Account A:** `... account --label post-install`
7. **U3 (token created before the install):** with the same token, run `... account --only ACC-01,ACC-02,ACC-03 --label pre-install` _before_ step 2, then again _after_. Matching `tokenFingerprint` proves it is the same token; a change in `totalGranted` answers U3. Before the install, `ACC-02` reporting `UNEXPECTED` (no installations) and `ACC-03` reporting `FIXTURE_ERROR` (the granted repo is not granted yet) is the expected outcome, not a failure.
8. **Isolation:** export token B, then `... isolation`
9. **Revocation behaviour:** revoke the app's authorization in your GitHub settings, then re-run `... account --only ACC-01`. Expect an immediate `ABORTED` after one request.

Save outputs with `--json > somefile`, but only under a path that is git-ignored (for example a name ending in `.log`). The output contains no secrets, but it is still data about your private repos.

## 7. Manual checks (cannot be automated here)

| #   | Check                                                                                                                                                                                | Question |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- |
| M1  | Inspect the app's settings page for any wildcard or loose callback-matching option; keep it off                                                                                      | U4       |
| M2  | Try authorizing with `redirect_uri=http://127.0.0.1:5173/auth/callback` and with another port; note which are accepted                                                               | U5       |
| M3  | Record the token-endpoint response by hand (default content type, field names, `expires_in`, error shape on reuse of a code and on a wrong secret). Record shapes only, never values | U6, U10  |
| M4  | Install the app and note where GitHub redirects (Setup URL) and which query parameters arrive                                                                                        | -        |
| M5  | Install on an organization as a non-owner member to see the request-approval flow                                                                                                    | -        |
| M6  | Count how many authorizations you make while testing; note any prompt about token limits (do not try to trigger it)                                                                  | U9       |

## 8. Hypotheses and how to read results

| Expectation (all unproven until run)                                               | If it fails                                                    |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Non-granted private repo is `403` or `404` over REST and `null` over GraphQL       | `CRITICAL`: the intersection model does not hold; stop Phase 3 |
| Account B gets `403` or `404` for everything of A's                                | `CRITICAL`: stop                                               |
| `/user/repos` lists only repos inside the grant (public outside it is unknown, U1) | any private outside the grant is `CRITICAL`                    |
| All D2 reads in `ACC-06` return `200`                                              | a permission is missing from the registration                  |
| All `ACC-07` probes are denied                                                     | the app holds more than D2; fix the registration               |
| A `304` costs no rate limit                                                        | adjust the caching assumption in the Phase 3 design            |

Ambiguous or unexpected results are recorded as evidence, never silently reinterpreted. Any result that contradicts documentation is reported with its check id so it can be re-run.

## 9. Exit criteria for this spike

- No `CRITICAL` result in any run.
- Every `UNEXPECTED` has an explanation or a follow-up item.
- U1, U2, U3, U7, U8 each have evidence from at least one run, or are explicitly left open with a reason.
- The results are summarised in a new report under `docs/spikes/`, with docs updated only after approval.

## 10. Still unresolved after this harness

| ID                            | Why the harness cannot settle it                                    | Where it gets resolved                                              |
| ----------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------- |
| U4, M1                        | A settings-UI observation                                           | Manual (M1)                                                         |
| U5                            | Needs real authorize redirects                                      | Manual (M2)                                                         |
| U6, U10                       | Needs the client secret; the harness refuses to touch `github.com`  | Manual (M3), then Phase 3 broker tests                              |
| U9                            | Would require minting many tokens; deliberately not probed          | Observed passively (M6)                                             |
| U11                           | Needs GitHub Pages enabled                                          | Phase 3 deploy step                                                 |
| Refresh and revoke            | Both need the client secret                                         | Phase 3 broker tests with mocked GitHub, then one real dev-app test |
| Real browser CORS             | Node cannot enforce browser CORS; `ANON-01/02` only inspect headers | Phase 3 web module smoke test                                       |
| `sessionStorage` threat model | A design decision, not an API fact                                  | Phase 3 security doc (D1)                                           |

## 11. Verification already done (offline)

- 44 tests with a loopback mock GitHub that echoes tokens in headers and bodies: read-only behaviour, no token leakage into any rendering, redirect refusal, halt on `401`, halt on rate limit, request budget, per-check ceilings, `CRITICAL` detection for both leak types, fixture-error handling, dependency selection, dry run with zero requests.
- These tests run in CI (inside `npm test`, via `npm run test:spikes`). They use no credentials and no internet access.

## 12. Verified live

Only anonymous (no credentials) harness checks have been run against real GitHub:

- First run (Phase 2): `ANON-01` passed for all four preflights. The anonymous rate limit (60 per hour per IP, partly used by earlier probing) halted the run at `ANON-02`, which is the intended safety stop.
- Re-run on 2026-10-28, 7 requests: `ANON-01`, `ANON-02` and `ANON-03` all passed. All four preflights returned 204 and allowed `authorization`, `content-type` and `if-none-match`. A public repository response exposed `etag`, `link`, `retry-after`, `x-ratelimit-remaining` and `x-github-sso`. `/user` returned 401 without a token, and the anonymous core limit was 60. This is header inspection from Node, not browser-enforced CORS.

Nothing else in this document has been verified live. `ACC-*` and `ISO-*` have not been run, and U1 to U11 keep the statuses recorded in ADR 0001.
