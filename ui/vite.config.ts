import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// `npm run dev` proxies the API to a running inspector (go run . --no-open in the repository root).
// Open the URL the inspector prints once, so the browser has its session cookie, then use
// the dev server's URL. The proxy sends the inspector's own origin, which its API requires.
const inspector = process.env.A2A_INSPECTOR_URL ?? 'http://127.0.0.1:8080';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    host: '127.0.0.1',
    proxy: {
      '/api': { target: inspector, changeOrigin: true, headers: { origin: inspector } },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
  },
});
