/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// En desarrollo, Vite sirve el frontend y reenvía /api y /mcp a `wrangler pages dev` (Pages Functions + D1 local).
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
