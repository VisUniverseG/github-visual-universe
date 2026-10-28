import { CHECKS, FIXTURE_ENV, MODES, TOKEN_ENV } from '../checks/index.mjs';
import { parseRepo } from '../checks/helpers.mjs';
import { BudgetError, HaltError, createBudget, createClient } from './client.mjs';
import { buildResult } from './report.mjs';
import { API_ORIGIN, SafetyError, assertUserToken, fingerprint, redact } from './safety.mjs';

const byId = (id) => CHECKS.find((check) => check.id === id);

/** Picks the checks for a mode (or an explicit --only list) plus all their dependencies. */
export function selectChecks(mode, only = []) {
  let selected;
  if (only.length > 0) {
    for (const id of only) {
      if (!byId(id)) throw new SafetyError(`unknown check id: ${id}`);
    }
    selected = CHECKS.filter((check) => only.includes(check.id));
  } else {
    const groups = MODES[mode];
    if (!groups) throw new SafetyError(`unknown mode: ${mode}`);
    selected = CHECKS.filter((check) => groups.includes(check.group));
  }
  const ids = new Set(selected.map((check) => check.id));
  const addDependencies = (check) => {
    for (const dependency of check.dependsOn ?? []) {
      if (!ids.has(dependency)) {
        ids.add(dependency);
        addDependencies(byId(dependency));
      }
    }
  };
  selected.forEach(addDependencies);
  return CHECKS.filter((check) => ids.has(check.id));
}

function readTokens(env) {
  const tokens = {};
  for (const [key, envName] of Object.entries(TOKEN_ENV)) {
    const value = env[envName];
    if (value === undefined || value === '') {
      tokens[key] = null;
    } else {
      tokens[key] = assertUserToken(value, envName);
    }
  }
  if (tokens.A !== null && tokens.A === tokens.B) {
    throw new SafetyError(`${TOKEN_ENV.A} and ${TOKEN_ENV.B} are identical`);
  }
  return tokens;
}

function readFixtures(env) {
  const fixtures = {};
  for (const [key, envName] of Object.entries(FIXTURE_ENV)) {
    const value = env[envName];
    fixtures[key] = value === undefined || value === '' ? null : parseRepo(value, envName);
  }
  return fixtures;
}

function missingFor(check, ctx) {
  const missing = [];
  for (const token of check.requires?.tokens ?? []) {
    if (!ctx.tokens[token]) missing.push(TOKEN_ENV[token]);
  }
  for (const fixture of check.requires?.fixtures ?? []) {
    if (!ctx.fixtures[fixture]) missing.push(FIXTURE_ENV[fixture]);
  }
  return missing;
}

function invalidFor(check, ctx) {
  const keys = [
    ...(check.requires?.fixtures ?? []),
    ...(check.requires?.tokens ?? []).map((token) => `token${token}`),
  ];
  return keys.filter((key) => ctx.state.badFixtures.has(key));
}

/**
 * Runs (or, with dryRun, only plans) a set of checks.
 *
 * `origin` and `allowedOrigins` exist solely so tests can point the harness at a loopback
 * mock server. The CLI never exposes them, and the environment cannot change them.
 */
export async function runSpike({
  mode = 'anonymous',
  only = [],
  env = {},
  label = 'run',
  maxRequests = 150,
  delayMs = 250,
  dryRun = false,
  origin = API_ORIGIN,
  allowedOrigins = [API_ORIGIN],
  fetchImpl,
  sleep,
}) {
  const tokens = readTokens(env);
  const fixtures = readFixtures(env);
  const secrets = Object.values(tokens).filter(Boolean);
  const fingerprints = {
    A: tokens.A ? fingerprint(tokens.A) : null,
    B: tokens.B ? fingerprint(tokens.B) : null,
  };
  const selected = selectChecks(mode, only);
  const ctx = {
    tokens,
    fixtures,
    state: { badFixtures: new Set(), completed: new Set() },
  };

  if (dryRun) {
    return {
      dryRun: true,
      secrets,
      plan: {
        tokens: fingerprints,
        fixtures: Object.fromEntries(Object.entries(fixtures).map(([k, v]) => [k, v !== null])),
        maxRequests,
        checks: selected.map((check) => ({
          id: check.id,
          title: check.title,
          maxRequests: check.maxRequests,
          plan: check.plan,
          missing: missingFor(check, ctx),
        })),
      },
    };
  }

  const budget = createBudget(maxRequests);
  const clientOptions = { origin, allowedOrigins, budget, delayMs, fetchImpl, sleep };
  ctx.anon = createClient({ ...clientOptions, token: null });
  ctx.a = tokens.A ? createClient({ ...clientOptions, token: tokens.A }) : null;
  ctx.b = tokens.B ? createClient({ ...clientOptions, token: tokens.B }) : null;

  const entries = [];
  const byCheck = {};
  let abortReason = null;

  for (const check of selected) {
    const base = { id: check.id, group: check.group, title: check.title, resolves: check.resolves };

    if (abortReason) {
      entries.push({ ...base, verdict: 'ABORTED', observed: {}, note: abortReason });
      continue;
    }
    const missing = missingFor(check, ctx);
    if (missing.length > 0) {
      entries.push({
        ...base,
        verdict: 'SKIPPED',
        observed: {},
        note: `missing: ${missing.join(', ')}`,
      });
      continue;
    }
    const invalid = invalidFor(check, ctx);
    if (invalid.length > 0) {
      entries.push({
        ...base,
        verdict: 'SKIPPED',
        observed: {},
        note: `fixture or token judged invalid by an earlier check: ${invalid.join(', ')}`,
      });
      continue;
    }
    const unmet = (check.dependsOn ?? []).filter((id) => !ctx.state.completed.has(id));
    if (unmet.length > 0) {
      entries.push({
        ...base,
        verdict: 'SKIPPED',
        observed: {},
        note: `depends on: ${unmet.join(', ')}`,
      });
      continue;
    }

    const before = budget.used;
    try {
      const outcome = await check.run(ctx);
      const halted = [ctx.anon, ctx.a, ctx.b].find((client) => client?.haltReason);
      if (halted) {
        // A 401 or rate-limit response means this check's observations are not trustworthy.
        abortReason = redact(`stopped: ${halted.haltReason}`, secrets);
        entries.push({
          ...base,
          verdict: 'ABORTED',
          observed: {},
          note: `${abortReason}. This check's result is discarded.`,
        });
      } else {
        entries.push({ ...base, ...outcome });
        if (outcome.verdict !== 'SKIPPED') ctx.state.completed.add(check.id);
      }
    } catch (error) {
      if (error instanceof HaltError || error instanceof BudgetError) {
        abortReason = redact(error.message, secrets);
        entries.push({ ...base, verdict: 'ABORTED', observed: {}, note: abortReason });
      } else if (error instanceof SafetyError) {
        throw error;
      } else {
        entries.push({
          ...base,
          verdict: 'ERROR',
          observed: {},
          note: redact(error?.message ?? 'unknown error', secrets),
        });
      }
    }
    byCheck[check.id] = budget.used - before;
  }

  const result = buildResult({
    label,
    tokens: fingerprints,
    entries,
    requests: { total: budget.used, byCheck },
  });
  return { dryRun: false, secrets, result };
}
