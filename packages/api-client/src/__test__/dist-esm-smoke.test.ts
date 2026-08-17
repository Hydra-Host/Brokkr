import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';


const PKG_DIR = resolve(__dirname, '..', '..');

function requireBuilt(file: string): void {
  if (existsSync(resolve(PKG_DIR, 'dist', file))) return;
  throw new Error(
    `dist/${file} missing — build @repo/api-client first ` +
      `(run via \`pnpm test\`/turbo, or \`pnpm --filter @repo/api-client build\`).`,
  );
}

function importInPlainNode(subpath: string, expected: string[]): string[] {
  const script = `import('@repo/api-client/${subpath}').then((m) => { process.stdout.write(Object.keys(m).join(',')); });`;
  const out = execFileSync('node', ['--input-type=module', '-e', script], {
    cwd: PKG_DIR,
    encoding: 'utf8',
  });
  const keys = out.split(',');
  for (const name of expected) expect(keys).toContain(name);
  return keys;
}

describe('api-client dist ESM smoke (plain Node, no loader)', () => {
  it('imports ./client and ./core from dist', () => {
    requireBuilt('client.mjs');
    requireBuilt('core.mjs');
    importInPlainNode('client', ['createApiClient', 'createTsrReactQueryClient']);
    importInPlainNode('core', ['createApiClient']);
  }, 120_000);
});
