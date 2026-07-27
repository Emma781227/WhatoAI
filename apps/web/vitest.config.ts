import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'], // e2e/ est réservé à Playwright
    setupFiles: ['./src/test/setup.ts'],
    env: {
      // env.ts est validé au premier import : URL complète AVEC /api.
      NEXT_PUBLIC_API_URL: 'http://localhost:4000/api',
    },
  },
});
