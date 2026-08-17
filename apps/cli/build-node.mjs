import { build } from 'esbuild';
import { chmod, copyFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const stripShebangPlugin = {
  name: 'strip-shebang',
  setup(b) {
    b.onLoad({ filter: /\/src\/(index|mcp\/index)\.ts$/ }, async (args) => {
      const source = await readFile(args.path, 'utf8');
      return { contents: source.replace(/^#!.*\r?\n/, ''), loader: 'ts' };
    });
  },
};

const BANNER = `#!/usr/bin/env node
import { createRequire as __brokkrCreateRequire } from 'node:module';
const require = __brokkrCreateRequire(import.meta.url);`;

const docsContent = await readFile('LLM_CLI_REFERENCE.md', 'utf-8');
const { version } = JSON.parse(await readFile('package.json', 'utf-8'));

const OUT_DIR = 'npm-package';

// Bundling breaks ink/react (WASM layout engine, dynamic devtools) and the MCP SDK (complex subpath exports) — leave them external.
// @hydrahost/admin-cli is proprietary and must never ship in the public bundle.
const EXTERNAL = ['ink', 'react', '@modelcontextprotocol/sdk', '@modelcontextprotocol/sdk/*', '@hydrahost/admin-cli'];

const SHARED_OPTIONS = {
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node18',
  sourcemap: true,
  minify: false,
  jsx: 'automatic',
  jsxImportSource: 'react',
  external: EXTERNAL,
  plugins: [stripShebangPlugin],
  banner: { js: BANNER },
  define: {
    'process.env.NODE_ENV': '"production"',
    'process.env.BROKKR_DEFAULT_ENV': '"brokkr"',
    BROWSER_DOCS_CONTENT: JSON.stringify(docsContent),
    BROKKR_CLI_VERSION: JSON.stringify(version),
  },
};

await mkdir(path.join(OUT_DIR, 'mcp'), { recursive: true });

await Promise.all([
  build({
    ...SHARED_OPTIONS,
    entryPoints: ['src/index.ts'],
    outfile: path.join(OUT_DIR, 'index.js'),
  }),
  build({
    ...SHARED_OPTIONS,
    entryPoints: ['src/mcp/index.ts'],
    outfile: path.join(OUT_DIR, 'mcp', 'index.js'),
  }),
]);

await chmod(path.join(OUT_DIR, 'index.js'), 0o755);
await chmod(path.join(OUT_DIR, 'mcp', 'index.js'), 0o755);

await copyFile('postinstall.mjs', path.join(OUT_DIR, 'postinstall.mjs'));

console.log(`Node bundle built: ${OUT_DIR}/index.js, ${OUT_DIR}/mcp/index.js`);
