import { ACCOUNT_CHECKS } from './account.mjs';
import { ANONYMOUS_CHECKS } from './anonymous.mjs';
import { ISOLATION_CHECKS } from './isolation.mjs';

// Execution order matters: dependencies come first.
export const CHECKS = [...ANONYMOUS_CHECKS, ...ACCOUNT_CHECKS, ...ISOLATION_CHECKS];

export const TOKEN_ENV = {
  A: 'GVU_SPIKE_TOKEN_A',
  B: 'GVU_SPIKE_TOKEN_B',
};

export const FIXTURE_ENV = {
  privGranted: 'GVU_SPIKE_REPO_PRIV_GRANTED',
  privNotGranted: 'GVU_SPIKE_REPO_PRIV_NOT_GRANTED',
  pubNotGranted: 'GVU_SPIKE_REPO_PUB_NOT_GRANTED',
  ssoRepo: 'GVU_SPIKE_REPO_SSO',
};

export const MODES = {
  anonymous: ['anonymous'],
  account: ['account'],
  isolation: ['isolation'],
  all: ['anonymous', 'account', 'isolation'],
};

export const NOT_TESTABLE_HERE = [
  'U4  wildcard callback matching (an app-settings UI check)',
  'U5  loopback 127.0.0.1 callback with a variable port (needs a real authorize flow)',
  'U6  web-flow token endpoint response format and errors (needs the client secret: Phase 3 broker tests)',
  'U9  per-user token minting limits (deliberately not probed; would mean minting many tokens)',
  'U10 authorization code lifetime for GitHub Apps (needs a real authorize flow)',
  'U11 GitHub Pages hostname and query preservation (needs Pages enabled)',
  'Refresh-token rotation and token revocation (need the client secret: Phase 3 broker tests)',
  'Real browser CORS enforcement (ANON-01/02 inspect headers only)',
];
