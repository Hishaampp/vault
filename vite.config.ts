/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';

// `npm run build:single` produces one self-contained dist/index.html you can
// open by double-clicking, email, or run offline on demo day.
export default defineConfig(({ mode }) => ({
  plugins: [react(), ...(mode === 'single' ? [viteSingleFile()] : [])],
  server: {
    // during `npm run dev`, forward API and WebSocket traffic to the Node.js cluster
    proxy: {
      '/api': `http://localhost:${process.env.VAULT_PORT ?? 7070}`,
      '/ws': { target: `ws://localhost:${process.env.VAULT_PORT ?? 7070}`, ws: true },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/setupTests.ts'],
    testTimeout: 30_000,
    coverage: { include: ['src/engine/**', 'src/components/**', 'src/hooks/**'] },
  },
}));