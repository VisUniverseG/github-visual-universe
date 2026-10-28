import react from '@vitejs/plugin-react';
import { loadEnv, type Plugin } from 'vite';
import { defineConfig } from 'vitest/config';
import { buildCsp } from './src/security/csp.ts';

const DEFAULT_API_BASE_URL = 'http://localhost:8787';

/**
 * Injects the CSP and a no-referrer policy into the built index.html. Build only: a meta CSP in
 * dev would block the inline scripts Vite's hot reload needs. `vite preview` serves the build, so
 * it is the place to check the policy locally.
 */
function securityHeadersPlugin(apiBaseUrl: string): Plugin {
  return {
    name: 'gvu-security-meta',
    apply: 'build',
    transformIndexHtml() {
      return [
        {
          tag: 'meta',
          attrs: {
            'http-equiv': 'Content-Security-Policy',
            content: buildCsp({ apiOrigin: apiBaseUrl }),
          },
          injectTo: 'head-prepend',
        },
        {
          tag: 'meta',
          attrs: { name: 'referrer', content: 'no-referrer' },
          injectTo: 'head-prepend',
        },
      ];
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  return {
    // "/" locally; "/github-visual-universe/" when built for GitHub Pages.
    base: env['VITE_BASE_PATH'] ?? '/',
    plugins: [react(), securityHeadersPlugin(env['VITE_API_BASE_URL'] ?? DEFAULT_API_BASE_URL)],
    server: { port: 5173, strictPort: true },
    preview: { port: 4173, strictPort: true },
    test: {
      environment: 'jsdom',
      include: ['src/**/*.test.{ts,tsx}'],
    },
  };
});
