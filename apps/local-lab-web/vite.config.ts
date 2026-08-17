import tailwindcss from '@tailwindcss/vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [tanstackRouter({ target: 'react', autoCodeSplitting: true }), react(), tailwindcss()],
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
    dedupe: ['react', 'react-dom', '@tanstack/react-router', '@tanstack/react-query', '@ts-rest/react-query'],
  },
  server: {
    // Never default to all-interfaces — the proxied /api control surface is destructive.
    host: process.env.HOST || '127.0.0.1',
    allowedHosts: process.env.HOST === '0.0.0.0' ? true : undefined,
    port: Number(process.env.LAB_WEB_PORT || process.env.PORT || 5175),
    strictPort: true,
    proxy: {
      '/api': {
        target: process.env.LOCAL_BROKKR_API_PROXY_TARGET || `http://127.0.0.1:${process.env.LAB_PORT || 3002}`,
        changeOrigin: true,
        xfwd: true,
        ws: true,
      },
    },
  },
});
