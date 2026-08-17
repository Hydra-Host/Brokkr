import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installCompletion, rcPath, uninstallCompletion } from '../install.js';

describe('completion install/uninstall (bash/zsh)', () => {
  let home: string;
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'brokkr-completion-'));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
  });

  it('install is idempotent: a second install is a no-op', () => {
    const path = rcPath('bash');
    const original = 'export FOO=1\n';
    writeFileSync(path, original);

    const first = installCompletion('bash');
    expect(first.action).toBe('installed');
    const afterFirst = readFileSync(path, 'utf-8');

    const second = installCompletion('bash');
    expect(second.action).toBe('already-installed');
    expect(readFileSync(path, 'utf-8')).toBe(afterFirst);
  });

  it('install adds a self-contained managed block delimited by markers', () => {
    const path = rcPath('bash');
    writeFileSync(path, 'export FOO=1\n');

    installCompletion('bash');
    const content = readFileSync(path, 'utf-8');
    expect(content).toContain('# >>> brokkr completion >>>');
    expect(content).toContain('# <<< brokkr completion <<<');
    expect(content).toContain('export FOO=1');
  });

  it('install -> install -> uninstall leaves the rc file byte-identical to the original', () => {
    const path = rcPath('bash');
    const original = 'export FOO=1\nalias ll="ls -la"\n';
    writeFileSync(path, original);

    installCompletion('bash');
    installCompletion('bash');
    const result = uninstallCompletion('bash');

    expect(result.action).toBe('uninstalled');
    expect(readFileSync(path, 'utf-8')).toBe(original);
  });

  it('round-trips cleanly for zsh as well (block includes the compinit guard)', () => {
    const path = rcPath('zsh');
    const original = 'setopt AUTO_CD\n';
    writeFileSync(path, original);

    installCompletion('zsh');
    const installed = readFileSync(path, 'utf-8');
    expect(installed).toContain('compinit');

    uninstallCompletion('zsh');
    expect(readFileSync(path, 'utf-8')).toBe(original);
  });

  it('uninstall on a file with no managed block reports not-found and leaves it untouched', () => {
    const path = rcPath('bash');
    const original = 'export FOO=1\n';
    writeFileSync(path, original);

    const result = uninstallCompletion('bash');
    expect(result.action).toBe('not-found');
    expect(readFileSync(path, 'utf-8')).toBe(original);
  });

  it('uninstall on a missing rc file reports not-found without creating it', () => {
    const result = uninstallCompletion('bash');
    expect(result.action).toBe('not-found');
  });

  it('installs into an rc file that has no trailing newline, then uninstalls cleanly', () => {
    const path = rcPath('bash');
    const original = 'export FOO=1';
    writeFileSync(path, original);

    expect(installCompletion('bash').action).toBe('installed');
    const installed = readFileSync(path, 'utf-8');
    expect(installed).toContain('export FOO=1\n');
    expect(installed).toContain('# >>> brokkr completion >>>');

    expect(uninstallCompletion('bash').action).toBe('uninstalled');
    const restored = readFileSync(path, 'utf-8');
    expect(restored).not.toContain('brokkr completion');
    expect(restored.replace(/\n+$/, '')).toBe('export FOO=1');
  });
});

describe('completion install/uninstall (fish)', () => {
  let home: string;
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'brokkr-completion-fish-'));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
  });

  it('install -> already-installed -> uninstall -> not-found round-trip', () => {
    const path = rcPath('fish');
    expect(existsSync(path)).toBe(false);

    const first = installCompletion('fish');
    expect(first.action).toBe('installed');
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, 'utf-8')).toContain('complete -c brokkr');

    const second = installCompletion('fish');
    expect(second.action).toBe('already-installed');

    const removed = uninstallCompletion('fish');
    expect(removed.action).toBe('uninstalled');
    expect(existsSync(path)).toBe(false);

    expect(uninstallCompletion('fish').action).toBe('not-found');
  });
});
