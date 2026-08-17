import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const DEVENV_NIX = join(__dirname, '..', '..', '..', '..', '..', 'devenv.nix');
const SPOKE_PATHS_NIX = join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  '..',
  'devenv',
  'modules',
  'spoke-paths.nix',
);
const SCRIPT_KEY = 'scripts.stack-wipe-images = {';
const SPOKE_STORAGE_BINDING =
  'spokeStorage = ((import ./devenv/modules/spoke-paths.nix).forSlot config.stack.slot).storage;';

function wipeImagesScriptSource(): string {
  const src = readFileSync(DEVENV_NIX, 'utf8');
  const start = src.indexOf(SCRIPT_KEY);
  if (start === -1) throw new Error(`${SCRIPT_KEY} not found in ${DEVENV_NIX}`);
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`unterminated ${SCRIPT_KEY} block`);
}

describe('stack-wipe-images wipes only the claimed slot', () => {
  it('rm -rf s the spoke-paths storage derivation, never a hard-coded path', () => {
    const block = wipeImagesScriptSource();
    expect(block).toContain('rm -rf "${spokeStorage}"');
    expect(block).not.toContain('/tmp/brokkr-dev');
  });

  it('binds spokeStorage from spoke-paths.nix for this stack slot', () => {
    expect(readFileSync(DEVENV_NIX, 'utf8')).toContain(SPOKE_STORAGE_BINDING);
  });

  it('keeps spoke-paths.nix the single source of the per-slot storage root', () => {
    const src = readFileSync(SPOKE_PATHS_NIX, 'utf8');
    expect(src).toContain('storage = if slot == 0 then "/tmp/brokkr-dev"');
    expect(src).toContain('"/tmp/brokkr-dev-s${toString slot}"');
  });
});
