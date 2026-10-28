#!/usr/bin/env node
// Local-only GitHub authorization spike harness (Phase 2 follow-up).
// See docs/spikes/github-auth-harness.md for the plan, runbook and safety model.

import { parseArgs } from 'node:util';
import { renderDryRun, renderJson, renderText } from './lib/report.mjs';
import { runSpike } from './lib/runner.mjs';
import { SafetyError } from './lib/safety.mjs';

const HELP = `Usage: node scripts/spikes/github-auth/run.mjs <mode> [options]

Modes:
  anonymous   No token needed. CORS preflight and header checks.
  account     Needs GVU_SPIKE_TOKEN_A (+ repo fixtures). Permission and intersection checks.
  isolation   Needs tokens A and B. Cross-account isolation checks (runs account deps first).
  all         anonymous + account + isolation. Checks without their inputs are SKIPPED.

Options:
  --dry-run             Print the request plan and what would be skipped. Makes NO requests.
  --only ID[,ID...]     Run specific checks (their dependencies are added automatically).
  --label TEXT          Free-text label echoed in the output (e.g. pre-install, post-install).
  --max-requests N      Hard request budget for the whole run (default 150).
  --json                Machine-readable output.
  -h, --help            This help.

Environment (read from the process environment only; never from files, never printed):
  GVU_SPIKE_TOKEN_A / GVU_SPIKE_TOKEN_B     GitHub App user access tokens (ghu_...)
  GVU_SPIKE_REPO_PRIV_GRANTED               owner/name: private repo the app IS installed on
  GVU_SPIKE_REPO_PRIV_NOT_GRANTED           owner/name: private repo the app is NOT installed on
  GVU_SPIKE_REPO_PUB_NOT_GRANTED            owner/name: public repo the app is NOT installed on
  GVU_SPIKE_REPO_SSO                        owner/name: optional repo in a SAML-protected org

Read-only by construction: only GET, HEAD, credential-free OPTIONS, and GraphQL queries
to api.github.com are possible. Redirects are never followed. A 401 or a rate-limit
response stops the run.
`;

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      'dry-run': { type: 'boolean', default: false },
      only: { type: 'string' },
      label: { type: 'string', default: 'run' },
      'max-requests': { type: 'string', default: '150' },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  if (values.help || positionals.length === 0) {
    process.stdout.write(HELP);
    return 0;
  }
  const maxRequests = Number.parseInt(values['max-requests'], 10);
  if (!Number.isInteger(maxRequests) || maxRequests < 1 || maxRequests > 500) {
    throw new SafetyError('--max-requests must be an integer between 1 and 500');
  }

  const outcome = await runSpike({
    mode: positionals[0],
    only: values.only ? values.only.split(',').map((id) => id.trim()) : [],
    env: process.env,
    label: values.label,
    maxRequests,
    dryRun: values['dry-run'],
  });

  if (outcome.dryRun) {
    process.stdout.write(`${renderDryRun(outcome.plan, outcome.secrets)}\n`);
    return 0;
  }
  const rendered = values.json
    ? renderJson(outcome.result, outcome.secrets)
    : renderText(outcome.result, outcome.secrets);
  process.stdout.write(`${rendered}\n`);
  return outcome.result.exitCode;
}

try {
  process.exitCode = await main();
} catch (error) {
  // Messages from SafetyError never contain secrets; anything else is reduced to its name.
  const message =
    error instanceof SafetyError ? error.message : `unexpected ${error?.name ?? 'error'}`;
  process.stderr.write(`error: ${message}\n`);
  process.exitCode = 2;
}
