// A tiny in-process fake of the parts of api.github.com the harness uses. It listens on
// loopback only and exists purely for tests. Tokens here are synthetic test data.

import http from 'node:http';

export const TOKEN_A = `ghu_${'a'.repeat(36)}`;
export const TOKEN_B = `ghu_${'b'.repeat(36)}`;

export const REPOS = {
  privGranted: 'acct-a/priv-granted',
  privNotGranted: 'acct-a/priv-hidden',
  pubNotGranted: 'acct-a/pub-open',
};

const DENIED_SUFFIXES = [
  '/commits/HEAD/check-runs',
  '/commits/HEAD/status',
  '/dependabot/alerts',
  '/code-scanning/alerts',
  '/hooks',
];

/**
 * options:
 *  leakNotGranted  account A can read the not-granted private repo (violation)
 *  leakCross       account B can read A's private repos (violation)
 *  hiddenInGrant   the not-granted repo shows up in the installation grant (fixture error)
 *  sameAccount     token B resolves to the same account as token A
 *  always401       every authenticated request gets 401
 *  anonRateLimited every anonymous non-preflight request gets a 403 rate-limit response
 */
export async function startMockGitHub(options = {}) {
  const log = [];
  let remaining = 5000;

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const url = new URL(req.url, 'http://127.0.0.1');
      const auth = req.headers.authorization ?? null;
      const who = auth === `Bearer ${TOKEN_A}` ? 'A' : auth === `Bearer ${TOKEN_B}` ? 'B' : null;
      const bodyText = Buffer.concat(chunks).toString('utf8');
      log.push({ method: req.method, path: url.pathname, query: url.search, who, bodyText });

      const send = (status, json, headers = {}) => {
        res.writeHead(status, {
          'content-type': 'application/json',
          'access-control-allow-origin': '*',
          'access-control-expose-headers':
            'ETag, Link, Retry-After, X-RateLimit-Remaining, X-GitHub-SSO',
          'x-ratelimit-limit': '5000',
          'x-ratelimit-remaining': String(remaining),
          // Echo the credential everywhere a careless harness might copy it from.
          'x-echo-auth': auth ?? '',
          ...headers,
        });
        res.end(json === undefined ? '' : JSON.stringify(json));
      };
      const notFound = () => send(404, { message: `Not Found ${auth ?? ''}` });

      if (req.method === 'OPTIONS') {
        return send(204, undefined, {
          'access-control-allow-methods': 'GET, POST, PATCH, PUT, DELETE',
          'access-control-allow-headers':
            'Authorization, Content-Type, If-Match, If-None-Match, X-GitHub-Api-Version',
        });
      }
      if (options.always401 && auth) return send(401, { message: `Bad credentials ${auth}` });
      if (options.anonRateLimited && !auth) {
        remaining = 0;
        return send(403, { message: 'API rate limit exceeded' }, { 'retry-after': '60' });
      }

      const path = url.pathname;
      remaining -= path === '/rate_limit' ? 0 : 1;

      const repoMatch = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(path);
      const canRead = (name) => {
        const key = name.toLowerCase();
        if (key === REPOS.pubNotGranted || key === 'octocat/hello-world') return true;
        if (key === REPOS.privGranted) return who === 'A' || (options.leakCross && who === 'B');
        if (key === REPOS.privNotGranted) {
          return (options.leakNotGranted && who === 'A') || (options.leakCross && who === 'B');
        }
        return false;
      };

      if (path === '/user') {
        if (!who) return send(401, { message: 'Requires authentication' });
        const id = who === 'B' && !options.sameAccount ? 2 : 1;
        return send(
          200,
          { id, login: `user-${id}` },
          {
            'github-authentication-token-expiration': '2099-01-01 00:00:00 UTC',
          },
        );
      }
      if (path === '/rate_limit') {
        const limit = who ? 5000 : 60;
        return send(200, {
          resources: { core: { limit, remaining }, graphql: { limit, remaining } },
        });
      }
      if (path === '/user/installations') {
        if (!who) return send(401, { message: 'Requires authentication' });
        const id = who === 'A' ? 11 : 22;
        return send(200, {
          total_count: 1,
          installations: [{ id, repository_selection: 'selected', account: { type: 'User' } }],
        });
      }
      const installRepos = /^\/user\/installations\/(\d+)\/repositories$/.exec(path);
      if (installRepos) {
        const wanted = Number(installRepos[1]);
        const mine = who === 'A' ? 11 : who === 'B' ? 22 : 0;
        if (wanted !== mine && !(options.leakCross && wanted === 11)) return notFound();
        const repositories = [{ full_name: REPOS.privGranted, private: true }];
        if (options.hiddenInGrant)
          repositories.push({ full_name: REPOS.privNotGranted, private: true });
        return send(200, { total_count: repositories.length, repositories });
      }
      if (path === '/user/repos') {
        if (who !== 'A') return send(200, []);
        const repos = [
          { full_name: REPOS.privGranted, private: true },
          { full_name: REPOS.pubNotGranted, private: false },
        ];
        if (options.leakNotGranted) repos.push({ full_name: REPOS.privNotGranted, private: true });
        return send(200, repos);
      }
      if (path === '/user/starred' || path === '/user/emails') {
        return send(403, { message: 'Resource not accessible by integration' });
      }
      if (repoMatch) {
        const fullName = `${repoMatch[1]}/${repoMatch[2]}`;
        const rest = repoMatch[3] ?? '';
        if (!canRead(fullName)) return notFound();
        if (DENIED_SUFFIXES.some((suffix) => rest.endsWith(suffix))) {
          return send(403, { message: 'Resource not accessible by integration' });
        }
        if (rest === '') {
          const etag = 'W/"abc"';
          if (req.headers['if-none-match'] === etag) {
            remaining += 1; // conditional hits are free
            return send(304, undefined, { etag });
          }
          return send(200, { private: fullName.toLowerCase() !== REPOS.pubNotGranted }, { etag });
        }
        if (rest.startsWith('/git/trees')) return send(200, { tree: [], truncated: false });
        if (rest === '/stats/contributors') return send(202, undefined);
        if (rest.startsWith('/contents/.github')) return notFound();
        return send(200, rest.includes('/actions/') ? { total_count: 0 } : []);
      }
      if (path === '/graphql' && req.method === 'POST') {
        if (!who) return send(401, { message: 'Requires authentication' });
        const { query, variables } = JSON.parse(bodyText);
        if (query.includes('contributionsCollection')) {
          return send(200, {
            data: {
              viewer: {
                contributionsCollection: {
                  totalCommitContributions: 7,
                  totalIssueContributions: 1,
                  totalPullRequestContributions: 2,
                  totalPullRequestReviewContributions: 0,
                  restrictedContributionsCount: 3,
                  hasAnyRestrictedContributions: true,
                  contributionCalendar: { totalContributions: 13 },
                  commitContributionsByRepository: [
                    { repository: { isPrivate: true, nameWithOwner: REPOS.privGranted } },
                  ],
                },
              },
              rateLimit: { cost: 1, remaining },
            },
          });
        }
        if (query.includes('viewer { repositories')) {
          const nodes = [{ nameWithOwner: REPOS.privGranted }];
          if (options.leakNotGranted) nodes.push({ nameWithOwner: REPOS.privNotGranted });
          return send(200, {
            data: { viewer: { repositories: { totalCount: nodes.length, nodes } } },
          });
        }
        if (query.includes('repository(owner')) {
          const name = `${variables.o}/${variables.n}`;
          if (!canRead(name)) {
            return send(200, {
              data: { repository: null },
              errors: [{ type: 'NOT_FOUND', message: `Could not resolve ${name} ${auth}` }],
            });
          }
          return send(200, { data: { repository: { isPrivate: true } } });
        }
      }
      return notFound();
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    log,
    close: () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  };
}

/** Env with every fixture and both tokens set, pointing at the REPOS above. */
export function fullEnv(extra = {}) {
  return {
    GVU_SPIKE_TOKEN_A: TOKEN_A,
    GVU_SPIKE_TOKEN_B: TOKEN_B,
    GVU_SPIKE_REPO_PRIV_GRANTED: REPOS.privGranted,
    GVU_SPIKE_REPO_PRIV_NOT_GRANTED: REPOS.privNotGranted,
    GVU_SPIKE_REPO_PUB_NOT_GRANTED: REPOS.pubNotGranted,
    GVU_SPIKE_REPO_SSO: REPOS.pubNotGranted,
    ...extra,
  };
}
