// Isolation checks: need TWO tokens from two unrelated GitHub accounts (A owns the
// fixtures, B has no relationship to A). They prove that account B can never read
// account A's private data, with or without the app.

import { getAllPages, repoPath, summariseStatuses } from './helpers.mjs';

const REPO_QUERY =
  'query($o: String!, $n: String!) { repository(owner: $o, name: $n) { isPrivate } }';

async function crossUserProbe(client, repo) {
  const base = repoPath(repo);
  const paths = {
    metadata: base,
    contents: `${base}/contents/`,
    pulls: `${base}/pulls?per_page=1`,
    issues: `${base}/issues?per_page=1`,
    actionsRuns: `${base}/actions/runs?per_page=1`,
    commits: `${base}/commits?per_page=1`,
  };
  const results = [];
  for (const [name, path] of Object.entries(paths)) {
    const res = await client.get(path);
    results.push({ name, status: res.status });
  }
  const gql = await client.graphql(REPO_QUERY, { o: repo.owner, n: repo.name });
  const graphqlReadable = gql.json?.data?.repository != null;
  const leaked = results.filter((r) => r.status === 200).length > 0 || graphqlReadable;
  const notDenied = results.filter((r) => ![403, 404].includes(r.status));
  return {
    verdict: leaked ? 'CRITICAL' : notDenied.length ? 'UNEXPECTED' : 'PASS',
    expected: 'REST 403/404 for every request and GraphQL repository = null',
    observed: { rest: summariseStatuses(results), graphqlReadable },
    note: leaked
      ? "Account B read account A's private repository. Stop immediately and investigate."
      : undefined,
  };
}

export const iso01 = {
  id: 'ISO-01',
  group: 'isolation',
  title: 'Tokens A and B belong to different accounts',
  resolves: ['S2'],
  requires: { tokens: ['A', 'B'] },
  dependsOn: ['ACC-01'],
  maxRequests: 1,
  plan: ['GET /user (token B)'],
  async run(ctx) {
    const res = await ctx.b.get('/user');
    const sameAccount = res.status === 200 && res.json?.id === ctx.state.idA;
    if (sameAccount || res.status !== 200) ctx.state.badFixtures.add('tokenB');
    return {
      verdict: sameAccount ? 'FIXTURE_ERROR' : res.status === 200 ? 'PASS' : 'UNEXPECTED',
      expected: 'status 200 and a different account id than token A',
      observed: { status: res.status, sameAccountAsA: sameAccount },
      note: sameAccount
        ? 'GVU_SPIKE_TOKEN_B belongs to the same account as token A. Isolation checks are skipped.'
        : undefined,
    };
  },
};

export const iso02 = {
  id: 'ISO-02',
  group: 'isolation',
  title: "Account B cannot read A's private repo that the app IS granted",
  resolves: ['S2'],
  requires: { tokens: ['A', 'B'], fixtures: ['privGranted'] },
  dependsOn: ['ISO-01'],
  maxRequests: 7,
  plan: ['6 REST reads + 1 GraphQL repository query against {privGranted} using token B'],
  run: (ctx) => crossUserProbe(ctx.b, ctx.fixtures.privGranted),
};

export const iso03 = {
  id: 'ISO-03',
  group: 'isolation',
  title: "Account B cannot read A's private repo that the app is NOT granted",
  resolves: ['S2'],
  requires: { tokens: ['A', 'B'], fixtures: ['privNotGranted'] },
  dependsOn: ['ISO-01'],
  maxRequests: 7,
  plan: ['6 REST reads + 1 GraphQL repository query against {privNotGranted} using token B'],
  run: (ctx) => crossUserProbe(ctx.b, ctx.fixtures.privNotGranted),
};

export const iso04 = {
  id: 'ISO-04',
  group: 'isolation',
  title: "Account B cannot list A's installation repositories or see A's installation",
  resolves: ['S2'],
  requires: { tokens: ['A', 'B'] },
  dependsOn: ['ISO-01', 'ACC-02'],
  maxRequests: 4,
  plan: [
    "GET /user/installations/{A's installation}/repositories (token B)",
    'GET /user/installations (token B, up to 3 pages)',
  ],
  async run(ctx) {
    const aInstallation = ctx.state.installations[0];
    if (!aInstallation) {
      return {
        verdict: 'SKIPPED',
        observed: {},
        note: 'token A has no installation, so there is nothing to probe',
      };
    }
    const direct = await ctx.b.get(
      `/user/installations/${aInstallation.id}/repositories?per_page=1`,
    );
    const { items } = await getAllPages(ctx.b, '/user/installations', {
      key: 'installations',
      maxPages: 3,
    });
    const aIds = new Set(ctx.state.installations.map((i) => i.id));
    const overlap = items.filter((i) => aIds.has(i.id)).length;
    const leaked = direct.status === 200 || overlap > 0;
    return {
      verdict: leaked ? 'UNEXPECTED' : 'PASS',
      expected:
        'direct list denied (403/404) and no overlap between B installations and A installations',
      observed: { directStatus: direct.status, overlappingInstallations: overlap },
      note: leaked
        ? 'Legitimate only if A and B share an organisation installation. Otherwise this is an isolation failure.'
        : undefined,
    };
  },
};

export const iso05 = {
  id: 'ISO-05',
  group: 'isolation',
  title: "Anonymous requests cannot read A's private repo",
  resolves: ['S2'],
  requires: { fixtures: ['privGranted'] },
  maxRequests: 1,
  plan: ['GET /repos/{privGranted} (no token)'],
  async run(ctx) {
    const res = await ctx.anon.get(repoPath(ctx.fixtures.privGranted));
    return {
      verdict:
        res.status === 200 ? 'CRITICAL' : [403, 404].includes(res.status) ? 'PASS' : 'UNEXPECTED',
      expected: '404 (or 403) without a token',
      observed: { status: res.status },
    };
  },
};

export const ISOLATION_CHECKS = [iso01, iso02, iso03, iso04, iso05];
