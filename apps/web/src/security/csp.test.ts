import { describe, expect, it } from 'vitest';
import { buildCsp } from './csp.ts';

function directives(csp: string): Map<string, string> {
  return new Map(
    csp.split('; ').map((part) => {
      const [name = '', ...values] = part.split(' ');
      return [name, values.join(' ')];
    }),
  );
}

describe('buildCsp', () => {
  const csp = buildCsp({ apiOrigin: 'https://api.example.com' });
  const parsed = directives(csp);

  it('allows network access only to our API and api.github.com', () => {
    expect(parsed.get('connect-src')).toBe('https://api.example.com https://api.github.com');
  });

  it('normalizes the API URL to a bare origin', () => {
    const withPath = buildCsp({ apiOrigin: 'http://localhost:8787/some/path?x=1' });
    expect(directives(withPath).get('connect-src')).toBe(
      'http://localhost:8787 https://api.github.com',
    );
  });

  it('forbids inline and third-party scripts, eval and styles', () => {
    expect(parsed.get('script-src')).toBe("'self'");
    expect(parsed.get('style-src')).toBe("'self'");
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('unsafe-eval');
  });

  it('denies everything not explicitly allowed', () => {
    expect(parsed.get('default-src')).toBe("'none'");
    expect(parsed.get('object-src')).toBe("'none'");
    expect(parsed.get('form-action')).toBe("'none'");
    expect(parsed.get('base-uri')).toBe("'self'");
  });

  it('has no wildcard source and omits directives that are ignored in a meta tag', () => {
    expect(csp).not.toMatch(/(^|\s)\*(\s|;|$)/);
    expect(parsed.has('frame-ancestors')).toBe(false);
  });

  it('rejects an API URL that is not a URL', () => {
    expect(() => buildCsp({ apiOrigin: 'not a url' })).toThrow();
  });
});
