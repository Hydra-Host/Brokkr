import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI_DIR = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(CLI_DIR, 'npm-package');

// Runtime deps that ship as real dependencies of the published package (a subset of
// build-node.mjs's external list — @hydrahost/admin-cli is stripped below, not promoted here).
const EXTERNALS = ['ink', 'react', '@modelcontextprotocol/sdk'];

const sourcePkg = JSON.parse(await readFile(join(CLI_DIR, 'package.json'), 'utf-8'));

const dependencies = {};
for (const name of EXTERNALS) {
  const version = sourcePkg.dependencies?.[name] ?? sourcePkg.devDependencies?.[name];
  if (!version) {
    throw new Error(`Refusing to publish: external "${name}" has no declared version in apps/cli/package.json`);
  }
  if (version.startsWith('workspace:')) {
    throw new Error(`Refusing to publish: workspace-protocol dep "${name}=${version}" cannot ship to npm`);
  }
  dependencies[name] = version;
}

// Never ship the proprietary admin-cli optional dep to the public npm package.
const optionalDependencies = { ...sourcePkg.optionalDependencies };
delete optionalDependencies['@hydrahost/admin-cli'];
const hasOptionalDependencies = Object.keys(optionalDependencies).length > 0;

const publishedPkg = {
  name: '@hydrahost/brokkr-cli',
  version: sourcePkg.version,
  description: 'The Brokkr CLI and MCP server for managing Hydrahost infrastructure.',
  license: 'Apache-2.0',
  author: 'Hydrahost, Inc.',
  homepage: 'https://brokkr.hydrahost.com',
  repository: {
    type: 'git',
    url: process.env.BROKKR_CLI_REPOSITORY_URL ?? 'https://github.com/Hydra-Host/boss.git',
  },
  bugs: {
    url: process.env.BROKKR_CLI_BUGS_URL ?? 'https://github.com/Hydra-Host/boss/issues',
  },
  keywords: ['brokkr', 'hydrahost', 'cli', 'mcp', 'infrastructure', 'baremetal', 'gpu'],
  type: 'module',
  bin: {
    brokkr: './index.js',
    'brokkr-mcp': './mcp/index.js',
  },
  files: ['index.js', 'index.js.map', 'mcp/', 'postinstall.mjs', 'README.md', 'LICENSE'],
  scripts: {
    postinstall: 'node postinstall.mjs',
  },
  engines: {
    node: '>=18',
  },
  dependencies,
  ...(hasOptionalDependencies ? { optionalDependencies } : {}),
  // Pin the registry: without it a publish follows the machine's default, which on a dev box may be
  // a mirror rather than npmjs — the CLI would then never reach the registry operators install from.
  publishConfig: {
    access: 'public',
    registry: 'https://registry.npmjs.org/',
  },
};

await mkdir(OUT_DIR, { recursive: true });
await writeFile(join(OUT_DIR, 'package.json'), JSON.stringify(publishedPkg, null, 2) + '\n', 'utf-8');
await copyFile(join(CLI_DIR, 'README.npm.md'), join(OUT_DIR, 'README.md'));
await copyFile(join(CLI_DIR, 'LICENSE'), join(OUT_DIR, 'LICENSE'));

console.log(`Publish manifest generated: ${OUT_DIR}/package.json`);
