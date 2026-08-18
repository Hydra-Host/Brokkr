// Writes the Redoc API reference to apps/docs/public/api/ (gitignored) so /api works in
// `pnpm dev`. Builds api's workspace deps first (turbo-cached); the generator imports them.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const docsRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(docsRoot, '..', '..');
const apiOpenapi = resolve(repoRoot, 'apps', 'api', 'openapi');
const outDir = resolve(docsRoot, 'public', 'api');

// execFileSync (no shell) with fixed args: nothing here is user-supplied.
const run = (bin, args) => execFileSync(bin, args, { cwd: repoRoot, stdio: 'inherit' });

run('pnpm', ['turbo', 'run', 'build', '--filter=api^...']);
run('pnpm', ['--filter', 'api', 'exec', 'tsx', 'src/scripts/openapi/generate-openapi.ts', '--seed-script']);

mkdirSync(outDir, { recursive: true });
copyFileSync(resolve(apiOpenapi, 'index.html'), resolve(outDir, 'index.html'));
copyFileSync(resolve(apiOpenapi, 'public.json'), resolve(outDir, 'public.json'));
console.log(`API reference written to ${outDir}`);
