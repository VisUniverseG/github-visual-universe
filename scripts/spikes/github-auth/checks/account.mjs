// Account checks: need ONE GitHub App user access token (account A) plus repository fixtures.
//
// Output rule: only statuses, counts, booleans and header *presence* are ever returned.
// Repository names, logins, ids and header values stay in memory.

import {
  getAllPages,
  headerPresence,
  hoursUntil,
  lower,
  repoPath,
  summariseStatuses,
} from './helpers.mjs';
import { fingerprint } from '../lib/safety.mjs';

const REPO_QUERY =
  'query($o: String!, $n: String!) { repository(owner: $o, name: $n) { isPrivate pullRequests { totalCount } issues { totalCount } defaultBranchRef { target { ... on Commit { history(first: 1) { totalCount } } } } } }';

const VIEWER_PRIVATE_REPOS_QUERY =
  'query { viewer { repositories(first: 100, ownerAffiliations: [OWNER], privacy: PRIVATE) { totalCount nodes { nameWithOwner } } } }';

const CONTRIBUTIONS_QUERY =
  'query { viewer { contributionsCollection { totalCommitContributions totalIssueContributions totalPullRequestContributions totalPullRequestReviewContributions restrictedContributionsCount hasAnyRestrictedContributions contributionCalendar { totalContributions } commitContributionsByRepository(maxRepositories: 100) { repository { isPrivate nameWithOwner } contributions { totalCount } } } } rateLimit { cost remaining } }';

const graphqlErrorTypes = (json) =>
  Array.isArray(json?.errors) ? json.errors.map((e) => String(e?.type ?? 'UNKNOWN')) : [];

async function runProbes(client, probes) {
  const results = [];
  for (const probe of probes) {
    const res = await client.get(probe.path);
    results.push({ ...probe, status: res.status, json: res.json });
  }
  return results;
}

const mismatches = (results) =>
  results.filter((r) => !r.informational && !r.expect.includes(r.status));

export const acc01 = {
  id: 'ACC-01',
  group: 'account',
  title: 'Token identity, token-metadata headers, rate-limit shape',
  resolves: ['S5', 'S4'],
  requires: { tokens: ['A'] },
  maxRequests: 2,
  plan: ['GET /user', 'GET /rate_limit'],
  async run(ctx) {
    const user = await ctx.a.get('/user');
    const limit = await ctx.a.get('/rate_limit');
    if (user.status === 200 && user.json) {
      ctx.state.idA = user.json.id;
    }
    return {
      verdict: user.status === 200 ? 'PASS' : 'UNEXPECTED',
      expected: {
        status: 200,
        'x-oauth-scopes header': 'absent for GitHub App tokens (hypothesis)',
      },
      observed: {
        status: user.status,
        tokenFingerprint: fingerprint(ctx.tokens.A),
        hasLogin: typeof user.json?.login === 'string',
        headers: headerPresence(user.headers, [
          'x-oauth-scopes',
          'x-accepted-oauth-scopes',
          'github-authentication-token-expiration',
          'x-ratelimit-limit',
        ]),
        hoursUntilExpiry: hoursUntil(user.headers.get('github-authentication-token-expiration')),
        rateLimit: {
          status: limit.status,
          core: limit.json?.resources?.core?.limit ?? null,
          graphql: limit.json?.resources?.graphql?.limit ?? null,
        },
      },
      note: 'hoursUntilExpiry is null when the header is absent; that is itself a finding (token expiry would then be learnt only from the exchange response).',
    };
  },
};

export const acc02 = {
  id: 'ACC-02',
  group: 'account',
  title: 'Installations visible to the user token',
  resolves: ['U3'],
  requires: { tokens: ['A'] },
  maxRequests: 3,
  plan: ['GET /user/installations (up to 3 pages)'],
  async run(ctx) {
    const { items, status, truncated } = await getAllPages(ctx.a, '/user/installations', {
      key: 'installations',
      maxPages: 3,
    });
    ctx.state.installations = items.map((item) => ({ id: item.id }));
    const selection = {};
    const accountTypes = {};
    for (const item of items) {
      selection[item.repository_selection] = (selection[item.repository_selection] ?? 0) + 1;
      const type = item.account?.type ?? 'unknown';
      accountTypes[type] = (accountTypes[type] ?? 0) + 1;
    }
    return {
      verdict: status === 200 && items.length > 0 ? 'PASS' : 'UNEXPECTED',
      expected: 'status 200 and at least one installation (the app must be installed first)',
      observed: { status, count: items.length, selection, accountTypes, truncated },
      note: 'For U3 run this check (with ACC-03) before and after installing the app, using the SAME token. Compare tokenFingerprint in ACC-01 to prove it is the same token.',
    };
  },
};

export const acc03 = {
  id: 'ACC-03',
  group: 'account',
  title: 'Repositories granted per installation; fixture sanity',
  resolves: ['S1', 'U3'],
  requires: { tokens: ['A'] },
  dependsOn: ['ACC-02'],
  maxRequests: 15,
  plan: ['GET /user/installations/{id}/repositories (first 5 installations, up to 3 pages each)'],
  async run(ctx) {
    const granted = new Set();
    const grantedPrivate = new Set();
    const perInstallation = [];
    for (const installation of ctx.state.installations.slice(0, 5)) {
      const { items, status, truncated } = await getAllPages(
        ctx.a,
        `/user/installations/${installation.id}/repositories`,
        { key: 'repositories', maxPages: 3 },
      );
      let privateCount = 0;
      for (const repo of items) {
        granted.add(lower(repo.full_name));
        if (repo.private) {
          grantedPrivate.add(lower(repo.full_name));
          privateCount += 1;
        }
      }
      perInstallation.push({ status, total: items.length, private: privateCount, truncated });
    }
    ctx.state.granted = granted;
    ctx.state.grantedPrivate = grantedPrivate;

    const fixtureProblems = [];
    const { privGranted, privNotGranted } = ctx.fixtures;
    if (privGranted && !granted.has(privGranted.key)) {
      fixtureProblems.push('GVU_SPIKE_REPO_PRIV_GRANTED is not in the granted set');
      ctx.state.badFixtures.add('privGranted');
    }
    if (privNotGranted && granted.has(privNotGranted.key)) {
      fixtureProblems.push('GVU_SPIKE_REPO_PRIV_NOT_GRANTED IS in the granted set');
      ctx.state.badFixtures.add('privNotGranted');
    }
    return {
      verdict: fixtureProblems.length ? 'FIXTURE_ERROR' : 'INFO',
      expected: 'granted-private fixture is granted; not-granted fixture is not',
      observed: {
        installationsChecked: perInstallation.length,
        perInstallation,
        totalGranted: granted.size,
        totalGrantedPrivate: grantedPrivate.size,
      },
      note: fixtureProblems.length
        ? `${fixtureProblems.join('; ')}. Fix the fixture or the installation and re-run; dependent checks are skipped.`
        : undefined,
    };
  },
};

export const acc04 = {
  id: 'ACC-04',
  group: 'account',
  title: '/user/repos vs the installation grant (does it leak anything beyond it?)',
  resolves: ['U1', 'S1'],
  requires: { tokens: ['A'] },
  dependsOn: ['ACC-03'],
  maxRequests: 5,
  plan: ['GET /user/repos?affiliation=owner&visibility=all (up to 5 pages)'],
  async run(ctx) {
    const { items, status, truncated } = await getAllPages(
      ctx.a,
      '/user/repos?affiliation=owner&visibility=all',
      { maxPages: 5 },
    );
    let privateCount = 0;
    let outsidePublic = 0;
    let outsidePrivate = 0;
    for (const repo of items) {
      const outside = !ctx.state.granted.has(lower(repo.full_name));
      if (repo.private) privateCount += 1;
      if (outside && repo.private) outsidePrivate += 1;
      if (outside && !repo.private) outsidePublic += 1;
    }
    return {
      verdict: outsidePrivate > 0 ? 'CRITICAL' : 'INFO',
      expected: {
        outsideGrantPrivate: 0,
        outsideGrantPublic: 'unknown (this is the U1 question)',
      },
      observed: {
        status,
        total: items.length,
        private: privateCount,
        outsideGrantPrivate: outsidePrivate,
        outsideGrantPublic: outsidePublic,
        truncated,
      },
      note:
        outsidePrivate > 0
          ? 'A private repository outside the installation grant was listed. This contradicts the documented intersection model. Stop and investigate before any Phase 3 work.'
          : 'outsideGrantPublic > 0 means /user/repos also lists public repos where the app is not installed (answers U1).',
    };
  },
};

export const acc05 = {
  id: 'ACC-05',
  group: 'account',
  title: 'Private repository NOT granted to the app is unreachable (intersection model)',
  resolves: ['S1'],
  requires: { tokens: ['A'], fixtures: ['privNotGranted'] },
  maxRequests: 3,
  plan: [
    'GET /repos/{privNotGranted}',
    'GET /repos/{privNotGranted}/contents/',
    'GET /repos/{privNotGranted}/pulls',
  ],
  async run(ctx) {
    const base = repoPath(ctx.fixtures.privNotGranted);
    const results = await runProbes(ctx.a, [
      { name: 'metadata', path: base, expect: [403, 404] },
      { name: 'contents', path: `${base}/contents/`, expect: [403, 404] },
      { name: 'pulls', path: `${base}/pulls?per_page=1`, expect: [403, 404] },
    ]);
    const leaked = results.filter((r) => r.status === 200);
    return {
      verdict: leaked.length > 0 ? 'CRITICAL' : mismatches(results).length ? 'UNEXPECTED' : 'PASS',
      expected: 'every request is denied (403 or 404)',
      observed: summariseStatuses(results),
      note: leaked.length
        ? 'The app token read a private repository that was not granted to the app. Stop and investigate.'
        : undefined,
    };
  },
};

export const acc06 = {
  id: 'ACC-06',
  group: 'account',
  title: 'Granted private repo: every REST read the product needs works with the D2 permission set',
  resolves: ['S3', 'U7'],
  requires: { tokens: ['A'], fixtures: ['privGranted'] },
  maxRequests: 13,
  plan: [
    'metadata: GET /repos/{r}, /languages',
    'contents: /contents/, /git/trees/HEAD?recursive=1, /commits, /branches',
    'pull requests: /pulls',
    'issues: /issues',
    'actions: /actions/workflows, /actions/runs',
    'informational: /stats/contributors, /dependency-graph/sbom, /contents/.github/workflows',
  ],
  async run(ctx) {
    const base = repoPath(ctx.fixtures.privGranted);
    const results = await runProbes(ctx.a, [
      { name: 'metadata', perm: 'metadata', path: base, expect: [200] },
      { name: 'languages', perm: 'metadata', path: `${base}/languages`, expect: [200] },
      { name: 'contents', perm: 'contents', path: `${base}/contents/`, expect: [200] },
      {
        name: 'tree',
        perm: 'contents',
        path: `${base}/git/trees/HEAD?recursive=1`,
        expect: [200],
      },
      { name: 'commits', perm: 'contents', path: `${base}/commits?per_page=1`, expect: [200] },
      { name: 'branches', perm: 'contents', path: `${base}/branches?per_page=1`, expect: [200] },
      {
        name: 'pulls',
        perm: 'pull_requests',
        path: `${base}/pulls?state=all&per_page=1`,
        expect: [200],
      },
      {
        name: 'issues',
        perm: 'issues',
        path: `${base}/issues?state=all&per_page=1`,
        expect: [200],
      },
      { name: 'workflows', perm: 'actions', path: `${base}/actions/workflows`, expect: [200] },
      { name: 'runs', perm: 'actions', path: `${base}/actions/runs?per_page=1`, expect: [200] },
      {
        name: 'statsContributors',
        perm: 'contents',
        path: `${base}/stats/contributors`,
        expect: [200, 202],
        informational: true,
      },
      {
        name: 'sbom',
        perm: 'contents',
        path: `${base}/dependency-graph/sbom`,
        expect: [200],
        informational: true,
      },
      {
        name: 'workflowFiles',
        perm: 'contents',
        path: `${base}/contents/.github/workflows`,
        expect: [200, 404],
        informational: true,
      },
    ]);
    const bad = mismatches(results);
    const tree = results.find((r) => r.name === 'tree');
    return {
      verdict: bad.length ? 'UNEXPECTED' : 'PASS',
      expected: 'all required reads return 200 (informational probes may differ)',
      observed: {
        statuses: summariseStatuses(results),
        treeTruncated: tree?.json?.truncated ?? null,
      },
      note: bad.length
        ? `unexpected statuses: ${bad.map((r) => `${r.name}(${r.perm})=${r.status}`).join(', ')}. A required permission may be missing from the app registration.`
        : undefined,
    };
  },
};

export const acc07 = {
  id: 'ACC-07',
  group: 'account',
  title: 'Least privilege: endpoints behind permissions we did NOT request are denied',
  resolves: ['S3'],
  requires: { tokens: ['A'], fixtures: ['privGranted'] },
  maxRequests: 7,
  plan: [
    'GET /user/starred (starring: not requested)',
    'GET /repos/{r}/commits/HEAD/check-runs (checks)',
    'GET /repos/{r}/commits/HEAD/status (statuses)',
    'GET /repos/{r}/dependabot/alerts',
    'GET /repos/{r}/code-scanning/alerts',
    'GET /repos/{r}/hooks (administration)',
    'GET /user/emails (email addresses)',
  ],
  async run(ctx) {
    const base = repoPath(ctx.fixtures.privGranted);
    const results = await runProbes(ctx.a, [
      { name: 'starred', path: '/user/starred?per_page=1', expect: [403, 404] },
      { name: 'checkRuns', path: `${base}/commits/HEAD/check-runs`, expect: [403, 404] },
      { name: 'combinedStatus', path: `${base}/commits/HEAD/status`, expect: [403, 404] },
      { name: 'dependabotAlerts', path: `${base}/dependabot/alerts`, expect: [403, 404] },
      { name: 'codeScanningAlerts', path: `${base}/code-scanning/alerts`, expect: [403, 404] },
      { name: 'hooks', path: `${base}/hooks`, expect: [403, 404] },
      { name: 'userEmails', path: '/user/emails', expect: [403, 404] },
    ]);
    const bad = mismatches(results);
    return {
      verdict: bad.length ? 'UNEXPECTED' : 'PASS',
      expected: 'all denied (403 or 404) because those permissions were not requested',
      observed: summariseStatuses(results),
      note: bad.length
        ? `${bad.map((r) => r.name).join(', ')} succeeded: the app may hold broader permissions than the agreed D2 set. Review the app registration.`
        : undefined,
    };
  },
};

export const acc08 = {
  id: 'ACC-08',
  group: 'account',
  title: 'Public repo without installation (read behaviour incl. Actions)',
  resolves: ['U1', 'U7'],
  requires: { tokens: ['A'], fixtures: ['pubNotGranted'] },
  maxRequests: 6,
  plan: ['GET /repos/{pub}, /contents/, /pulls, /issues, /actions/workflows, /actions/runs'],
  async run(ctx) {
    const base = repoPath(ctx.fixtures.pubNotGranted);
    const results = await runProbes(ctx.a, [
      { name: 'metadata', path: base, expect: [200] },
      { name: 'contents', path: `${base}/contents/`, expect: [200] },
      { name: 'pulls', path: `${base}/pulls?per_page=1`, expect: [200] },
      { name: 'issues', path: `${base}/issues?per_page=1`, expect: [200] },
      { name: 'workflows', path: `${base}/actions/workflows`, expect: [200] },
      { name: 'runs', path: `${base}/actions/runs?per_page=1`, expect: [200] },
    ]);
    return {
      verdict: 'INFO',
      expected: 'hypothesis: public reads succeed (200); Actions endpoints are the uncertain part',
      observed: summariseStatuses(results),
    };
  },
};

export const acc09 = {
  id: 'ACC-09',
  group: 'account',
  title: 'Conditional requests: ETag -> 304, and whether a 304 costs rate limit',
  resolves: ['S4'],
  requires: { tokens: ['A'], fixtures: ['privGranted'] },
  maxRequests: 5,
  plan: [
    'GET /rate_limit',
    'GET /repos/{r}',
    'GET /rate_limit',
    'GET /repos/{r} (If-None-Match)',
    'GET /rate_limit',
  ],
  async run(ctx) {
    const path = repoPath(ctx.fixtures.privGranted);
    const remaining = (res) => res.json?.resources?.core?.remaining ?? null;
    const before = await ctx.a.get('/rate_limit');
    const first = await ctx.a.get(path);
    const afterFirst = await ctx.a.get('/rate_limit');
    const etag = first.headers.get('etag');
    const second = etag ? await ctx.a.get(path, { headers: { 'If-None-Match': etag } }) : null;
    const afterSecond = second ? await ctx.a.get('/rate_limit') : null;
    const delta = (a, b) => (a === null || b === null ? null : a - b);
    const costFirst = delta(remaining(before), remaining(afterFirst));
    const costConditional = afterSecond
      ? delta(remaining(afterFirst), remaining(afterSecond))
      : null;
    return {
      verdict: etag && second?.status === 304 ? 'PASS' : 'UNEXPECTED',
      expected: { firstStatus: 200, conditionalStatus: 304, conditionalCost: '0 (hypothesis)' },
      observed: {
        firstStatus: first.status,
        hasEtag: Boolean(etag),
        conditionalStatus: second?.status ?? null,
        costFirst,
        costConditional,
      },
      note: 'Rate-limit deltas can be noisy if anything else uses this token concurrently.',
    };
  },
};

const graphqlRepo = (client, repo) => client.graphql(REPO_QUERY, { o: repo.owner, n: repo.name });

export const acc10 = {
  id: 'ACC-10',
  group: 'account',
  title: 'GraphQL: viewer works, granted repo readable, non-granted repo is null',
  resolves: ['S1', 'S3'],
  requires: { tokens: ['A'], fixtures: ['privGranted', 'privNotGranted'] },
  dependsOn: ['ACC-03'],
  maxRequests: 3,
  plan: [
    'POST /graphql repository(granted)',
    'POST /graphql repository(not granted)',
    'POST /graphql viewer.repositories(PRIVATE)',
  ],
  async run(ctx) {
    const granted = await graphqlRepo(ctx.a, ctx.fixtures.privGranted);
    const hidden = await graphqlRepo(ctx.a, ctx.fixtures.privNotGranted);
    const mine = await ctx.a.graphql(VIEWER_PRIVATE_REPOS_QUERY);
    const nodes = mine.json?.data?.viewer?.repositories?.nodes ?? [];
    const outside = nodes.filter((n) => !ctx.state.grantedPrivate.has(lower(n.nameWithOwner)));
    const hiddenLeaked = hidden.json?.data?.repository != null;
    const grantedOk = granted.json?.data?.repository != null;
    let verdict = 'PASS';
    if (hiddenLeaked || outside.length > 0) verdict = 'CRITICAL';
    else if (!grantedOk) verdict = 'UNEXPECTED';
    return {
      verdict,
      expected: {
        granted: 'non-null',
        notGranted: 'null (NOT_FOUND)',
        viewerPrivateOutsideGrant: 0,
      },
      observed: {
        grantedStatus: granted.status,
        grantedReadable: grantedOk,
        notGrantedReadable: hiddenLeaked,
        notGrantedErrorTypes: graphqlErrorTypes(hidden.json),
        viewerPrivateTotal: mine.json?.data?.viewer?.repositories?.totalCount ?? null,
        viewerPrivateOutsideGrant: outside.length,
      },
      note:
        verdict === 'CRITICAL'
          ? 'GraphQL exposed a private repository outside the installation grant. Stop and investigate.'
          : undefined,
    };
  },
};

export const acc11 = {
  id: 'ACC-11',
  group: 'account',
  title: 'Contribution data (counts only): what does an app user token see?',
  resolves: ['U2'],
  requires: { tokens: ['A'] },
  dependsOn: ['ACC-03'],
  maxRequests: 1,
  plan: ['POST /graphql viewer.contributionsCollection (+ per-repo breakdown)'],
  async run(ctx) {
    const res = await ctx.a.graphql(CONTRIBUTIONS_QUERY);
    const c = res.json?.data?.viewer?.contributionsCollection;
    const breakdown = c?.commitContributionsByRepository ?? [];
    const privateInBreakdown = breakdown.filter((b) => b.repository?.isPrivate);
    const privateOutsideGrant = privateInBreakdown.filter(
      (b) => !ctx.state.grantedPrivate.has(lower(b.repository.nameWithOwner)),
    );
    return {
      verdict: c ? (privateOutsideGrant.length ? 'UNEXPECTED' : 'INFO') : 'UNEXPECTED',
      expected: 'hypothesis: per-repo breakdown only names private repos inside the grant',
      observed: {
        status: res.status,
        errorTypes: graphqlErrorTypes(res.json),
        totals: c
          ? {
              commits: c.totalCommitContributions,
              issues: c.totalIssueContributions,
              pullRequests: c.totalPullRequestContributions,
              reviews: c.totalPullRequestReviewContributions,
              calendar: c.contributionCalendar?.totalContributions ?? null,
            }
          : null,
        restrictedContributionsCount: c?.restrictedContributionsCount ?? null,
        hasAnyRestrictedContributions: c?.hasAnyRestrictedContributions ?? null,
        breakdownRepos: breakdown.length,
        breakdownPrivateRepos: privateInBreakdown.length,
        breakdownPrivateOutsideGrant: privateOutsideGrant.length,
        graphqlCost: res.json?.data?.rateLimit?.cost ?? null,
      },
      note: 'restrictedContributionsCount > 0 with breakdownPrivateRepos = 0 would mean private contributions are counted but not itemised for app tokens.',
    };
  },
};

export const acc12 = {
  id: 'ACC-12',
  group: 'account',
  title: 'SAML-protected organisation repo (optional): X-GitHub-SSO behaviour',
  resolves: ['U8'],
  requires: { tokens: ['A'], fixtures: ['ssoRepo'] },
  maxRequests: 1,
  plan: ['GET /repos/{ssoRepo}'],
  async run(ctx) {
    const res = await ctx.a.get(repoPath(ctx.fixtures.ssoRepo));
    const sso = res.headers.get('x-github-sso');
    return {
      verdict: 'INFO',
      expected: 'hypothesis: 200 because app tokens are auto-authorized for SAML SSO',
      observed: {
        status: res.status,
        ssoHeaderPresent: sso !== null,
        ssoRequired: sso ? sso.startsWith('required') : null,
      },
      note: 'The X-GitHub-SSO header value can contain a one-time URL, so only its presence is reported.',
    };
  },
};

export const ACCOUNT_CHECKS = [
  acc01,
  acc02,
  acc03,
  acc04,
  acc05,
  acc06,
  acc07,
  acc08,
  acc09,
  acc10,
  acc11,
  acc12,
];
