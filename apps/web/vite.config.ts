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

const webRequire = createRequire(import.meta.url);
const pluginsConfigPkgPath = path.resolve(__dirname, '../../packages/plugins-config/package.json');
const pluginsConfigRequire = createRequire(pluginsConfigPkgPath);
const webImporter = path.resolve(__dirname, './src/main.tsx');

function isInjectedWorkspaceId(id: string): boolean {
  return id === '@repo/ui' || id.startsWith('@repo/ui/') || id === 'lucide-react' || id.startsWith('lucide-react/');
}

function resolveInjectedWorkspacePackages(): Plugin {
  return {
    name: 'resolve-injected-workspace-packages',
    enforce: 'pre',
    async resolveId(id, _importer, options) {
      if (!isInjectedWorkspaceId(id)) return undefined;
      const resolved = await this.resolve(id, webImporter, { ...options, skipSelf: true });
      return resolved ?? undefined;
    },
  };
}

function optionalPluginPackageIds(pkg: unknown): string[] {
  if (typeof pkg !== 'object' || pkg === null || !('optionalDependencies' in pkg)) return [];
  const deps = pkg.optionalDependencies;
  if (typeof deps !== 'object' || deps === null) return [];
  return Object.keys(deps).filter((id) => id.startsWith('@hydrahost/plugin-'));
}

// Owned by withheld plugins rather than by apps/web, so they are absent from the public mirror.
// Vite only warns on an unresolvable include, but a warning naming a nonexistent package misleads.
const optionalPrebundle = ['react-simple-maps'].filter((id) => {
  try {
    webRequire.resolve(id);
    return true;
  } catch {
    return false;
  }
});

const pluginsConfigPkg: unknown = JSON.parse(fs.readFileSync(pluginsConfigPkgPath, 'utf8'));

function readInstalledPluginPkg(id: string): unknown | undefined {
  try {
    let dir = path.dirname(pluginsConfigRequire.resolve(id));
    for (let i = 0; i < 8; i++) {
      const candidate = path.join(dir, 'package.json');
      if (fs.existsSync(candidate)) {
        const pkg: unknown = JSON.parse(fs.readFileSync(candidate, 'utf8'));
        if (typeof pkg === 'object' && pkg !== null && 'name' in pkg && pkg.name === id) {
          return pkg;
        }
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function exportEntry(exportsField: object, key: string): unknown {
  return Object.entries(exportsField).find(([entryKey]) => entryKey === key)?.[1];
}

function conditionImportPath(entry: unknown): string | undefined {
  if (typeof entry === 'string') return entry;
  if (typeof entry !== 'object' || entry === null) return undefined;
  const importPath = exportEntry(entry, 'import');
  return typeof importPath === 'string' ? importPath : undefined;
}

function pluginShipsEsmFrontend(pkg: unknown): boolean {
  if (typeof pkg !== 'object' || pkg === null) return false;
  if ('type' in pkg && pkg.type === 'module') return true;
  if (!('exports' in pkg) || typeof pkg.exports !== 'object' || pkg.exports === null) return false;
  const importPath =
    conditionImportPath(exportEntry(pkg.exports, './frontend-manifest')) ??
    conditionImportPath(exportEntry(pkg.exports, './frontend'));
  return typeof importPath === 'string' && importPath.includes('dist/esm/');
}

// CJS plugin manifests stay in the plugins-config prebundle for named-export interop.
// Plugins that already ship ESM frontend stay out so Vite loads the live module.
const esmFrontendPluginPackages = optionalPluginPackageIds(pluginsConfigPkg).flatMap((id) => {
  const pkg = readInstalledPluginPkg(id);
  return pkg !== undefined && pluginShipsEsmFrontend(pkg) ? [id] : [];
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
      resolveInjectedWorkspacePackages(),
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
        // Injected workspace copies resolve from the workspace root, not apps/web/node_modules.
        '@repo/ui',
        'lucide-react',
        'sonner',
        'react-hook-form',
        '@hookform/resolvers',
      ],
    },
    optimizeDeps: {
      include: [
        '@repo/database',
        '@hydrahost/plugin-sdk',
        // CJS plugin manifests only expose named exports after esbuild interop.
        '@hydrahost/plugins-config/frontend',
        '@tanstack/react-router',
        // Lazily loaded by the webvm-terminal plugin; pre-bundled so the first VM boot doesn't
        // hit a "new dependencies optimized" reload mid-initialization.
        '@xterm/xterm',
        '@xterm/addon-fit',
        ...optionalPrebundle,
      ],
      // Contract schemas must hot-reload with form changes; a pre-bundled copy can silently validate the old shape.
      exclude: ['@repo/api-client', '@repo/cli', ...esmFrontendPluginPackages],
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
