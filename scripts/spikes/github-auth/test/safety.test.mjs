import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  SafetyError,
  assertAllowedRequest,
  assertUserToken,
  fingerprint,
  redact,
} from '../lib/safety.mjs';

const ALLOWED = ['https://api.github.com'];
const goodToken = `ghu_${'x'.repeat(36)}`;
const check = (request) => () => assertAllowedRequest(request, ALLOWED);

describe('assertUserToken', () => {
  it('accepts a GitHub App user token', () => {
    assert.equal(assertUserToken(goodToken, 'T'), goodToken);
  });

  for (const [name, value] of [
    ['classic PAT', `ghp_${'x'.repeat(36)}`],
    ['fine-grained PAT', `github_pat_${'x'.repeat(40)}`],
    ['OAuth App token', `gho_${'x'.repeat(36)}`],
    ['installation token', `ghs_${'x'.repeat(36)}`],
    ['refresh token', `ghr_${'x'.repeat(36)}`],
    ['empty', ''],
    ['padded', ` ${goodToken}`],
    ['wrong shape', 'ghu_short'],
  ]) {
    it(`rejects ${name} without echoing it`, () => {
      assert.throws(
        () => assertUserToken(value, 'TOKEN'),
        (error) => {
          assert.ok(error instanceof SafetyError);
          assert.ok(!value || !error.message.includes(value.trim()));
          return true;
        },
      );
    });
  }
});

describe('assertAllowedRequest', () => {
  it('allows GET on the API origin', () => {
    check({ method: 'GET', url: 'https://api.github.com/user', hasCredentials: true })();
  });

  it('allows credential-free OPTIONS but not OPTIONS with credentials', () => {
    check({ method: 'OPTIONS', url: 'https://api.github.com/user', hasCredentials: false })();
    assert.throws(
      check({ method: 'OPTIONS', url: 'https://api.github.com/user', hasCredentials: true }),
      SafetyError,
    );
  });

  for (const method of ['PUT', 'PATCH', 'DELETE']) {
    it(`blocks ${method}`, () => {
      assert.throws(
        check({ method, url: 'https://api.github.com/repos/o/r', hasCredentials: true }),
        SafetyError,
      );
    });
  }

  it('blocks POST anywhere except /graphql', () => {
    assert.throws(
      check({ method: 'POST', url: 'https://api.github.com/repos/o/r/issues', body: '{}' }),
      SafetyError,
    );
  });

  it('allows a GraphQL query and blocks mutations in any casing or position', () => {
    const post = (query) => ({
      method: 'POST',
      url: 'https://api.github.com/graphql',
      body: JSON.stringify({ query }),
      hasCredentials: true,
    });
    check(post('query { viewer { login } }'))();
    check(post('{ viewer { login } }'))();
    for (const query of [
      'mutation { addStar(input: {starrableId: "x"}) { clientMutationId } }',
      'MUTATION { x }',
      'query { a } # mutation',
      'subscription { x }',
      'fragment F on User { login }',
    ]) {
      assert.throws(check(post(query)), SafetyError, query);
    }
    assert.throws(
      check({ method: 'POST', url: 'https://api.github.com/graphql', body: 'not json' }),
      SafetyError,
    );
  });

  it('blocks other origins, schemes, userinfo and sensitive paths', () => {
    for (const url of [
      'https://github.com/login/oauth/access_token',
      'http://api.github.com/user',
      'https://evil.example/user',
      'https://api.github.com.evil.example/user',
      'https://user:pass@api.github.com/user',
      'https://api.github.com/applications/abc/token',
      'not a url',
    ]) {
      assert.throws(check({ method: 'GET', url, hasCredentials: true }), SafetyError, url);
    }
  });
});

describe('redact and fingerprint', () => {
  it('removes known secrets and anything token-shaped', () => {
    const text = `a ${goodToken} b ghp_${'y'.repeat(30)} c github_pat_${'z'.repeat(30)} d`;
    const out = redact(text, [goodToken]);
    assert.ok(!out.includes(goodToken));
    assert.ok(!/ghp_|github_pat_|ghu_/.test(out));
  });

  it('fingerprints are short and do not contain the token', () => {
    const fp = fingerprint(goodToken);
    assert.equal(fp.length, 8);
    assert.ok(!goodToken.includes(fp));
  });
});
