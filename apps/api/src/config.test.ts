import { describe, expect, it } from 'vitest';
import { loadConfig, parseAllowedOrigins } from './config.js';

describe('loadConfig', () => {
  it('uses safe local defaults', () => {
    const config = loadConfig({});
    expect(config.port).toBe(8787);
    expect(config.host).toBe('127.0.0.1');
    expect(config.allowedOrigins).toEqual(['http://localhost:5173', 'http://127.0.0.1:5173']);
  });

  it('reads PORT and HOST', () => {
    const config = loadConfig({ PORT: '10000', HOST: '0.0.0.0' });
    expect(config.port).toBe(10000);
    expect(config.host).toBe('0.0.0.0');
  });

  it('rejects an invalid PORT', () => {
    expect(() => loadConfig({ PORT: 'abc' })).toThrow(/Invalid PORT/);
    expect(() => loadConfig({ PORT: '70000' })).toThrow(/Invalid PORT/);
  });
});

describe('parseAllowedOrigins', () => {
  it('accepts exact origins and trims whitespace', () => {
    expect(parseAllowedOrigins(' https://a.example , http://localhost:5173 ')).toEqual([
      'https://a.example',
      'http://localhost:5173',
    ]);
  });

  it('rejects wildcards', () => {
    expect(() => parseAllowedOrigins('*')).toThrow(/wildcards/);
    expect(() => parseAllowedOrigins('https://*.example.com')).toThrow(/wildcards/);
  });

  it('rejects origins with paths or trailing slashes', () => {
    expect(() => parseAllowedOrigins('https://a.example/')).toThrow(/bare origins/);
    expect(() => parseAllowedOrigins('https://a.example/app')).toThrow(/bare origins/);
  });

  it('rejects non-http(s) and malformed values', () => {
    expect(() => parseAllowedOrigins('ftp://a.example')).toThrow(/http\(s\)/);
    expect(() => parseAllowedOrigins('not a url')).toThrow(/invalid origin/);
  });
});
