/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In dev, Vite serves the frontend and forwards /api and /mcp to `wrangler pages dev` (Pages Functions + local D1).
const API_ORIGIN = 'http://127.0.0.1:8788';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': API_ORIGIN,
      '/mcp': API_ORIGIN,
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
  test: {
    environment: 'node',
    include: ['shared/**/*.test.ts', 'server/**/*.test.ts', 'src/**/*.test.{ts,tsx}'],
  },
});
