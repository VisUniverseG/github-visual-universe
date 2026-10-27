import react from '@vitejs/plugin-react';
import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  return {
    // "/" locally; "/github-visual-universe/" when built for GitHub Pages.
    base: env['VITE_BASE_PATH'] ?? '/',
    plugins: [react()],
    server: { port: 5173, strictPort: true },
    preview: { port: 4173, strictPort: true },
    test: {
      environment: 'jsdom',
      include: ['src/**/*.test.{ts,tsx}'],
    },
  };
});
