import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SPOKE_NIX = join(__dirname, '..', '..', '..', '..', '..', 'devenv', 'modules', 'spoke.nix');
const TASK_KEY = '"zone-crypto:seed-bmc" = {';
const MODE_FREE_INTERPOLATIONS = ['cdRepo "HUB_REPO_PATH"', 'exportSimTaskEnv', 'config.devenv.root'];

function seedBmcTaskSource(): string {
  const src = readFileSync(SPOKE_NIX, 'utf8');
  const start = src.indexOf(TASK_KEY);
  if (start === -1) throw new Error(`${TASK_KEY} not found in ${SPOKE_NIX}`);
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`unterminated ${TASK_KEY} block`);
}

function execBody(): string {
  const task = seedBmcTaskSource();
  const open = task.indexOf("exec = ''");
  const close = task.indexOf("'';", open);
  if (open === -1 || close === -1) throw new Error('seed-bmc exec body not found');
  return task.slice(open, close);
}

function interpolationsInExecBody(): string[] {
  return [...execBody().matchAll(/\$\{([^}]*)\}/g)].map((m) => m[1].trim());
}

describe('zone-crypto:seed-bmc must stay fleet-mode-invariant at eval time', () => {
  it('interpolates only mode-free helpers into its script body', () => {
    for (const interpolation of interpolationsInExecBody()) {
      expect(MODE_FREE_INTERPOLATIONS).toContain(interpolation);
    }
  });

  it('does not reference the fleet mode anywhere in the task', () => {
    const code = seedBmcTaskSource()
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n');
    expect(code).not.toContain('config.fleet.mode');
    expect(code).not.toContain('lib.optionalString');
  });

  it('invokes both seals unconditionally so each can self-skip on the wrong mode', () => {
    const body = execBody();
    expect(body).toContain('seed:sim-bmc');
    expect(body).toContain('seed:baremetal-bmc');
  });
});
