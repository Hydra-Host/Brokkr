import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const docsContent = readFileSync('LLM_CLI_REFERENCE.md', 'utf-8');
const { version } = JSON.parse(readFileSync('package.json', 'utf-8'));

const bridgeSwapPlugin = {
  name: 'bridge-swap',
  setup(b) {
    b.onResolve({ filter: /bridge-transport\.js$/ }, (_args) => ({
      path: path.resolve('src/core/bridge-transport.browser.ts'),
    }));
  },
};

await build({
  entryPoints: ['src/browser-entry.ts'],
  bundle: true,
  outfile: 'dist/brokkr-browser.mjs',
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  minify: false,
  sourcemap: true,
  jsx: 'automatic',
  jsxImportSource: 'react',
  // @hydrahost/admin-cli is proprietary and must never ship in the public bundle; the runtime
  // dynamic import in src/admin/load-admin.ts resolves it only when it's actually installed.
  external: ['@hydrahost/admin-cli'],
  inject: ['src/shims/globals.ts'],
  define: {
    'process.env.NODE_ENV': '"production"',
    'process.env.DEV': '""',
    'process.env.BROKKR_BRIDGE': '"1"',
    BROWSER_DOCS_CONTENT: JSON.stringify(docsContent),
    BROKKR_CLI_VERSION: JSON.stringify(version),
  },
  alias: {
    'node:fs': './src/shims/node-fs.ts',
    'node:os': './src/shims/node-os.ts',
    'node:path': './src/shims/node-path.ts',
    'node:events': './src/shims/node-events.ts',
    'node:process': './src/shims/node-process.ts',
    'node:child_process': './src/shims/node-child-process.ts',
    'node:stream': './src/shims/node-stream.ts',
    'node:buffer': './src/shims/node-buffer.ts',
    'node:tty': './src/shims/node-tty.ts',
    'node:url': './src/shims/node-url.ts',
    'node:readline': './src/shims/node-readline.ts',
    'node:util': './src/shims/node-util.ts',
    assert: './src/shims/assert.ts',
    module: './src/shims/module.ts',
    ora: './src/shims/ora.ts',
    'react-devtools-core': './src/shims/react-devtools-core.ts',
  },
  plugins: [bridgeSwapPlugin],
});

console.log('Browser bundle built: dist/brokkr-browser.mjs');
