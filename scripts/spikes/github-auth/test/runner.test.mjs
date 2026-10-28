import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { CHECKS } from '../checks/index.mjs';
import { renderDryRun, renderJson, renderText } from '../lib/report.mjs';
import { runSpike } from '../lib/runner.mjs';
import { SafetyError } from '../lib/safety.mjs';
import { REPOS, TOKEN_A, TOKEN_B, fullEnv, startMockGitHub } from './mock-github.mjs';

let mock;

const run = async (mockOptions, spike = {}) => {
  mock = await startMockGitHub(mockOptions);
  return runSpike({
    mode: 'all',
    env: fullEnv(),
    delayMs: 0,
    origin: mock.origin,
    allowedOrigins: [mock.origin],
    ...spike,
  });
};
const verdicts = (outcome) =>
  Object.fromEntries(outcome.result.entries.map((e) => [e.id, e.verdict]));

afterEach(async () => {
  await mock?.close();
  mock = undefined;
});

describe('registry', () => {
  it('has unique ids and dependencies that run earlier', () => {
    const ids = CHECKS.map((c) => c.id);
    assert.equal(new Set(ids).size, ids.length);
    CHECKS.forEach((check, index) => {
      for (const dependency of check.dependsOn ?? []) {
        assert.ok(ids.indexOf(dependency) < index, `${check.id} depends on later ${dependency}`);
      }
    });
  });
});

describe('healthy run (everything behaves as documented)', () => {
  it('has no CRITICAL or UNEXPECTED results and exit code 0', async () => {
    const outcome = await run();
    const v = verdicts(outcome);
    assert.equal(outcome.result.exitCode, 0, JSON.stringify(v));
    for (const [id, verdict] of Object.entries(v)) {
      assert.ok(
        !['CRITICAL', 'UNEXPECTED', 'ERROR', 'ABORTED', 'FIXTURE_ERROR'].includes(verdict),
        `${id}=${verdict}`,
      );
    }
    assert.equal(v['ISO-02'], 'PASS');
    assert.equal(v['ACC-05'], 'PASS');
  });

  it('is strictly read-only: only GET, OPTIONS and GraphQL queries are sent', async () => {
    await run();
    for (const request of mock.log) {
      if (request.method === 'POST') {
        assert.equal(request.path, '/graphql');
        assert.ok(!/mutation|subscription/i.test(request.bodyText));
      } else {
        assert.ok(['GET', 'OPTIONS'].includes(request.method), request.method);
      }
    }
  });

  it('never sends a token to OPTIONS or anonymous requests', async () => {
    await run();
    for (const request of mock.log.filter((r) => r.method === 'OPTIONS')) {
      assert.equal(request.who, null);
    }
  });

  it('never exceeds each check’s declared request ceiling', async () => {
    const outcome = await run();
    for (const [id, used] of Object.entries(outcome.result.requests.byCheck)) {
      const check = CHECKS.find((c) => c.id === id);
      assert.ok(used <= check.maxRequests, `${id} used ${used} > ${check.maxRequests}`);
    }
  });

  it('keeps tokens out of every rendering even though the server echoes them', async () => {
    const outcome = await run();
    const secrets = outcome.secrets;
    for (const rendered of [
      renderText(outcome.result, secrets),
      renderJson(outcome.result, secrets),
    ]) {
      assert.ok(!rendered.includes(TOKEN_A));
      assert.ok(!rendered.includes(TOKEN_B));
      assert.ok(!/ghu_/.test(rendered));
      assert.ok(!rendered.includes(REPOS.privGranted), 'repo names must not be printed');
      assert.ok(!rendered.includes(REPOS.privNotGranted));
    }
  });
});

describe('violation detection', () => {
  it('flags a private repo outside the grant as CRITICAL (exit code 1)', async () => {
    const outcome = await run({ leakNotGranted: true });
    const v = verdicts(outcome);
    assert.equal(outcome.result.exitCode, 1);
    assert.equal(v['ACC-04'], 'CRITICAL');
    assert.equal(v['ACC-05'], 'CRITICAL');
    assert.equal(v['ACC-10'], 'CRITICAL');
  });

  it('flags cross-account reads as CRITICAL', async () => {
    const outcome = await run({ leakCross: true });
    const v = verdicts(outcome);
    assert.equal(outcome.result.exitCode, 1);
    assert.equal(v['ISO-02'], 'CRITICAL');
    assert.equal(v['ISO-03'], 'CRITICAL');
  });

  it('treats a bad fixture as a fixture error and skips dependants', async () => {
    const outcome = await run({ hiddenInGrant: true });
    const v = verdicts(outcome);
    assert.equal(v['ACC-03'], 'FIXTURE_ERROR');
    assert.equal(v['ACC-05'], 'SKIPPED');
    assert.equal(v['ISO-03'], 'SKIPPED');
  });

  it('skips isolation checks when both tokens belong to the same account', async () => {
    const outcome = await run({ sameAccount: true });
    const v = verdicts(outcome);
    assert.equal(v['ISO-01'], 'FIXTURE_ERROR');
    assert.equal(v['ISO-02'], 'SKIPPED');
  });
});

describe('failure handling', () => {
  it('stops after the first 401 and aborts the remaining checks', async () => {
    const outcome = await run({ always401: true });
    const authed = mock.log.filter((r) => r.who !== null && r.method !== 'OPTIONS');
    assert.equal(authed.length, 1);
    assert.equal(outcome.result.exitCode, 3);
    assert.ok(outcome.result.entries.some((e) => e.verdict === 'ABORTED'));
  });

  it('reports a rate-limited check as ABORTED, not as a misleading finding', async () => {
    const outcome = await run({ anonRateLimited: true }, { mode: 'anonymous' });
    const v = verdicts(outcome);
    assert.equal(v['ANON-01'], 'PASS'); // preflights succeed before the limit is hit
    assert.equal(v['ANON-02'], 'ABORTED');
    assert.equal(v['ANON-03'], 'ABORTED');
    assert.equal(outcome.result.exitCode, 3);
    assert.equal(mock.log.filter((r) => r.method === 'GET').length, 1);
  });

  it('honours the request budget', async () => {
    const outcome = await run({}, { maxRequests: 5 });
    assert.ok(outcome.result.requests.total <= 5);
    assert.ok(outcome.result.entries.some((e) => e.verdict === 'ABORTED'));
  });
});

describe('inputs', () => {
  it('skips checks whose inputs are missing instead of guessing', async () => {
    const outcome = await run({}, { env: { GVU_SPIKE_TOKEN_A: TOKEN_A } });
    const v = verdicts(outcome);
    assert.equal(v['ANON-01'], 'PASS');
    assert.equal(v['ACC-01'], 'PASS');
    assert.equal(v['ACC-05'], 'SKIPPED');
    assert.equal(v['ISO-01'], 'SKIPPED');
  });

  it('dry run makes zero requests and prints no secrets', async () => {
    mock = await startMockGitHub();
    const outcome = await runSpike({
      mode: 'all',
      env: fullEnv(),
      dryRun: true,
      origin: mock.origin,
      allowedOrigins: [mock.origin],
    });
    assert.equal(mock.log.length, 0);
    const text = renderDryRun(outcome.plan, outcome.secrets);
    assert.ok(!text.includes(TOKEN_A) && !text.includes(TOKEN_B));
    assert.match(text, /DRY RUN/);
  });

  it('rejects wrong token types, identical tokens and malformed repo fixtures', async () => {
    const base = { mode: 'anonymous', dryRun: true };
    await assert.rejects(
      runSpike({ ...base, env: { GVU_SPIKE_TOKEN_A: `ghp_${'x'.repeat(36)}` } }),
      SafetyError,
    );
    await assert.rejects(
      runSpike({ ...base, env: { GVU_SPIKE_TOKEN_A: TOKEN_A, GVU_SPIKE_TOKEN_B: TOKEN_A } }),
      SafetyError,
    );
    await assert.rejects(
      runSpike({ ...base, env: { GVU_SPIKE_REPO_PRIV_GRANTED: '../../etc/passwd' } }),
      SafetyError,
    );
    await assert.rejects(runSpike({ ...base, mode: 'nope' }), SafetyError);
    await assert.rejects(runSpike({ ...base, only: ['NOPE-99'] }), SafetyError);
  });

  it('--only pulls in dependencies automatically', async () => {
    const outcome = await run({}, { only: ['ISO-02'] });
    assert.deepEqual(
      outcome.result.entries.map((e) => e.id),
      ['ACC-01', 'ISO-01', 'ISO-02'],
    );
    mock.log.length = 0;
    await mock.close();
    const second = await run({}, { only: ['ISO-04'] });
    assert.deepEqual(
      second.result.entries.map((e) => e.id),
      ['ACC-01', 'ACC-02', 'ISO-01', 'ISO-04'],
    );
  });
});

beforeEach(() => {
  mock = undefined;
});
