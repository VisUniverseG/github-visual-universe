// Anonymous checks: no token, no fixtures. These are the only checks that are safe to run
// before any GitHub App exists.

const BROWSER_ORIGINS = ['https://visuniverseg.github.io', 'http://localhost:5173'];
const PREFLIGHT_HEADERS = [
  'authorization',
  'content-type',
  'if-none-match',
  'x-github-api-version',
];
const EXPOSED_HEADERS = ['etag', 'link', 'retry-after', 'x-ratelimit-remaining', 'x-github-sso'];

const splitList = (value) =>
  (value ?? '')
    .toLowerCase()
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);

export const anon01 = {
  id: 'ANON-01',
  group: 'anonymous',
  title: 'CORS preflight for the SPA origins (GET with auth headers, POST /graphql)',
  resolves: ['S6'],
  requires: {},
  maxRequests: 4,
  plan: ['OPTIONS /user (x2 origins)', 'OPTIONS /graphql (x2 origins)'],
  async run(ctx) {
    const observed = {};
    const problems = [];
    for (const origin of BROWSER_ORIGINS) {
      observed[origin] = {};
      for (const [label, path, method] of [
        ['user', '/user', 'GET'],
        ['graphql', '/graphql', 'POST'],
      ]) {
        const res = await ctx.anon.options(path, {
          headers: {
            Origin: origin,
            'Access-Control-Request-Method': method,
            'Access-Control-Request-Headers': PREFLIGHT_HEADERS.join(','),
          },
        });
        const allowOrigin = res.headers.get('access-control-allow-origin');
        const allowHeaders = splitList(res.headers.get('access-control-allow-headers'));
        const allowMethods = splitList(res.headers.get('access-control-allow-methods'));
        const missingHeaders = PREFLIGHT_HEADERS.filter((name) => !allowHeaders.includes(name));
        const originOk = allowOrigin === '*' || allowOrigin === origin;
        const methodOk = allowMethods.length === 0 || allowMethods.includes(method.toLowerCase());
        observed[origin][label] = {
          status: res.status,
          originOk,
          methodOk,
          missingHeaders,
        };
        if (res.status >= 400 || !originOk || !methodOk || missingHeaders.length > 0) {
          problems.push(`${origin} ${label}`);
        }
      }
    }
    return {
      verdict: problems.length === 0 ? 'PASS' : 'UNEXPECTED',
      expected: 'all preflights succeed and allow authorization, content-type, if-none-match',
      observed,
      note: problems.length ? `preflight problems: ${problems.join('; ')}` : undefined,
    };
  },
};

export const anon02 = {
  id: 'ANON-02',
  group: 'anonymous',
  title: 'Response headers exposed to browser JavaScript',
  resolves: ['S4', 'S6'],
  requires: {},
  maxRequests: 1,
  plan: ['GET /repos/octocat/Hello-World (public, anonymous, with Origin header)'],
  async run(ctx) {
    const res = await ctx.anon.get('/repos/octocat/Hello-World', {
      headers: { Origin: BROWSER_ORIGINS[0] },
    });
    const exposed = splitList(res.headers.get('access-control-expose-headers'));
    const missing = EXPOSED_HEADERS.filter((name) => !exposed.includes(name));
    return {
      verdict: res.status === 200 && missing.length === 0 ? 'PASS' : 'UNEXPECTED',
      expected: `status 200 and expose ${EXPOSED_HEADERS.join(', ')}`,
      observed: {
        status: res.status,
        allowOrigin: res.headers.get('access-control-allow-origin'),
        missingExposedHeaders: missing,
      },
      note: 'Header inspection only. Real browser enforcement is verified in the Phase 3 web module.',
    };
  },
};

export const anon03 = {
  id: 'ANON-03',
  group: 'anonymous',
  title: 'Unauthenticated behaviour: /user is 401, anonymous rate limit shape',
  resolves: ['S4'],
  requires: {},
  maxRequests: 2,
  plan: ['GET /user (anonymous)', 'GET /rate_limit (anonymous)'],
  async run(ctx) {
    const user = await ctx.anon.get('/user');
    const limit = await ctx.anon.get('/rate_limit');
    return {
      verdict: user.status === 401 ? 'PASS' : 'UNEXPECTED',
      expected: '/user returns 401 without a token',
      observed: {
        userStatus: user.status,
        rateLimitStatus: limit.status,
        anonymousCoreLimit: limit.json?.resources?.core?.limit ?? null,
      },
    };
  },
};

export const ANONYMOUS_CHECKS = [anon01, anon02, anon03];
