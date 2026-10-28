import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.tsx';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('App', () => {
  it('shows the API version when /health succeeds', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          Response.json({ status: 'ok', service: 'gvu-api', version: '9.9.9' }, { status: 200 }),
        ),
      ),
    );
    render(<App />);
    expect(await screen.findByText('API online (v9.9.9)')).toBeTruthy();
  });

  it('shows a friendly message when the API is unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('network'))),
    );
    render(<App />);
    expect(await screen.findByText(/API unreachable/)).toBeTruthy();
  });

  it('rejects a payload that violates the shared contract', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(Response.json({ status: 'nope' }, { status: 200 }))),
    );
    render(<App />);
    expect(await screen.findByText(/API unreachable/)).toBeTruthy();
  });
});
