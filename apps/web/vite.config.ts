import {
  isWebvmTerminalPath,
  WEBVM_TERMINAL_HTML,
  WEBVM_TERMINAL_ISOLATION_HEADERS,
} from '@hydrahost/plugin-webvm-terminal/server';
import tailwindcss from '@tailwindcss/vite';
import { devtools } from '@tanstack/devtools-vite';
import tanstackRouter from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import fs from 'fs';
import { createRequire } from 'node:module';
import path from 'path';
import { defineConfig, loadEnv, type Plugin, type ResolvedConfig } from 'vite';

const DEFAULT_BRAND_NAME = 'BoSS';
const MANIFEST_PUBLIC_PATH = '/site.webmanifest';

// Owned by withheld plugins rather than by apps/web, so they are absent from the public mirror.
// Vite only warns on an unresolvable include, but a warning naming a nonexistent package misleads.
const optionalPrebundle = ['react-simple-maps'].filter((id) => {
  try {
    createRequire(import.meta.url).resolve(id);
    return true;
  } catch {
    return false;
  }
});

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function brandingPlugin(brandName: string): Plugin {
  const applyBrand = (manifestJson: string): string => {
    const manifest: Record<string, unknown> = JSON.parse(manifestJson);
    manifest.name = brandName;
    manifest.short_name = brandName;
    return `${JSON.stringify(manifest, null, 2)}\n`;
  };

  let resolved: ResolvedConfig;
  return {
    name: 'brokkr-branding',
    configResolved(config) {
      resolved = config;
    },
    transformIndexHtml(html) {
      return html.replace(/<title>[^<]*<\/title>/, `<title>${escapeHtml(brandName)}</title>`);
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.split('?')[0] !== MANIFEST_PUBLIC_PATH) return next();
        const source = path.resolve(__dirname, 'public/site.webmanifest');
        res.setHeader('Content-Type', 'application/manifest+json');
        res.end(applyBrand(fs.readFileSync(source, 'utf-8')));
      });
    },
    closeBundle() {
      if (!resolved) return;
      const output = path.resolve(resolved.root, resolved.build.outDir, 'site.webmanifest');
      if (fs.existsSync(output)) {
        fs.writeFileSync(output, applyBrand(fs.readFileSync(output, 'utf-8')));
      }
    },
  };
}

// Serves `/webvm-terminal` as its own cross-origin-isolated popup document (SharedArrayBuffer for
// CheerpX); the main app deliberately carries no COOP/COEP — isolation breaks third-party iframes.
function webvmTerminalHeaders(): Plugin {
  return {
    name: 'webvm-terminal-headers',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        // Fast path: most requests (HMR pings, /src/*, assets) skip the work.
        const url = req.url ?? '';
        if (!url.startsWith('/webvm-terminal')) return next();
        const pathname = url.split('?')[0];
        if (isWebvmTerminalPath(pathname)) {
          for (const [name, value] of Object.entries(WEBVM_TERMINAL_ISOLATION_HEADERS)) {
            res.setHeader(name, value);
          }
          if (pathname !== WEBVM_TERMINAL_HTML) {
            req.url = WEBVM_TERMINAL_HTML + url.slice(pathname.length);
          }
        }
        next();
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const brandName = (process.env.VITE_BRAND_NAME ?? env.VITE_BRAND_NAME)?.trim() || DEFAULT_BRAND_NAME;

  return {
    plugins: [
      brandingPlugin(brandName),
      devtools(),
      tanstackRouter({ target: 'react', autoCodeSplitting: true }),
      react(),
      tailwindcss(),
      webvmTerminalHeaders(),
    ],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
        '~': path.resolve(__dirname, './src'),
      },
      dedupe: [
        'react',
        'react-dom',
        // Context-bearing packages must resolve to ONE module instance across plugin chunks and the main bundle, or the plugin's <Link> fails context lookup.
        '@tanstack/react-router',
        '@tanstack/react-query',
        '@ts-rest/react-query',
      ],
    },
    optimizeDeps: {
      include: [
        '@repo/database',
        '@hydrahost/plugin-sdk',
        '@hydrahost/plugins-config/frontend',
        '@tanstack/react-router',
        // Lazily loaded by the webvm-terminal plugin; pre-bundled so the first VM boot doesn't
        // hit a "new dependencies optimized" reload mid-initialization.
        '@xterm/xterm',
        '@xterm/addon-fit',
        ...optionalPrebundle,
      ],
      // Contract schemas must hot-reload with form changes; a pre-bundled copy can silently validate the old shape.
      exclude: ['@repo/api-client', '@repo/cli'],
    },
    build: {
      commonjsOptions: {
        include: [
          /node_modules/,
          /packages[\\/]database/,
          /packages[\\/]api-client/,
          /packages[\\/]plugin-sdk/,
          /packages[\\/]plugins-config/,
          /packages[\\/]plugins[\\/]hello-world/,
          /packages[\\/]plugins[\\/]google-maps-geocoding/,
          /packages[\\/]plugins[\\/]operator-hub/,
          /packages[\\/]plugins[\\/]radar-geocoding/,
          /packages[\\/]plugins[\\/]webvm-terminal/,
        ],
      },
      rollupOptions: {
        input: {
          main: path.resolve(__dirname, 'index.html'),
          // The cross-origin-isolated popup document (see webvmTerminalHeaders).
          webvmTerminal: path.resolve(__dirname, 'webvm-terminal.html'),
        },
      },
    },
    server: {
      host: process.env.HOST || undefined,
      allowedHosts: process.env.HOST === '0.0.0.0' ? true : undefined,
      port: Number(process.env.PORT || 5173),
      strictPort: process.env.VITE_STRICT_PORT === 'true' || !process.env.PORT,
      // COOP/COEP are NOT set globally — cross-origin isolation breaks embedded third-party
      // iframes (e.g. Stripe Elements); `webvmTerminalHeaders` sets them per-document instead.
      proxy: {
        '/api': {
          target: process.env.API_PROXY_TARGET || 'http://localhost:3000',
          changeOrigin: true,
        },
      },
    },
  };
});
