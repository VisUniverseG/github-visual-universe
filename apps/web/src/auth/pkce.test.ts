import { describe, expect, it } from 'vitest';
import {
  base64UrlEncode,
  computeCodeChallenge,
  generateCodeVerifier,
  generateState,
} from './pkce.ts';

describe('PKCE', () => {
  it('matches the RFC 7636 Appendix B test vector (S256)', async () => {
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    expect(await computeCodeChallenge(verifier)).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });

  it('generates verifiers of the minimum valid length from the unreserved alphabet', () => {
    for (let i = 0; i < 20; i += 1) {
      const verifier = generateCodeVerifier();
      expect(verifier).toHaveLength(43);
      expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    }
  });

  it('generates distinct verifiers and states', () => {
    const verifiers = new Set(Array.from({ length: 50 }, () => generateCodeVerifier()));
    const states = new Set(Array.from({ length: 50 }, () => generateState()));
    expect(verifiers.size).toBe(50);
    expect(states.size).toBe(50);
  });

  it('generates a state that is long enough to be unguessable and URL-safe', () => {
    expect(generateState()).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('produces a challenge that differs from the verifier and is 43 URL-safe characters', async () => {
    const verifier = generateCodeVerifier();
    const challenge = await computeCodeChallenge(verifier);
    expect(challenge).not.toBe(verifier);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('base64url-encodes without padding or unsafe characters', () => {
    expect(base64UrlEncode(new Uint8Array([251, 255, 254]))).toBe('-__-');
    expect(base64UrlEncode(new Uint8Array([1]))).toBe('AQ');
  });
});
