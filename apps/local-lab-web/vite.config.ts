import { REACT_SINGLETON_DEDUPE } from '@repo/vite-config/dedupe';
import { DEV_PROXY_FORWARDING, devAllowedHosts, devBindHost } from '@repo/vite-config/dev-server';
import tailwindcss from '@tailwindcss/vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [tanstackRouter({ target: 'react', autoCodeSplitting: true }), react(), tailwindcss()],
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
    dedupe: REACT_SINGLETON_DEDUPE,
  },
  test: {
    // the heavier jsdom page specs run in about a second locally and past five on the shared ci runner
    testTimeout: 15_000,
  },
  server: {
    // Never default to all-interfaces — the proxied /api control surface is destructive.
    host: devBindHost('127.0.0.1'),
    allowedHosts: devAllowedHosts(),
    // The proxied /api control surface is destructive, so nothing may read this server cross-origin.
    cors: false,
    port: Number(process.env.LAB_WEB_PORT || process.env.PORT || 5175),
    strictPort: true,
    proxy: {
      '/api': {
        target: process.env.LOCAL_BROKKR_API_PROXY_TARGET || `http://127.0.0.1:${process.env.LAB_PORT || 3002}`,
        ...DEV_PROXY_FORWARDING,
        ws: true,
      },
    },
  },
});
