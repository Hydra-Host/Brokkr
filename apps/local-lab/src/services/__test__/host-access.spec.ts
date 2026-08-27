import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { hostAccessPath, readHostAccess } from '../host-access';

let stateDir: string;

const marker = {
  checkedAt: 1756137600,
  hadTty: false,
  blocked: 1,
  warned: 2,
  findings: [
    { probe: 'groups', severity: 'block', title: "'kvm' membership is not active in this session", fix: 'log out' },
    { probe: 'kvm', severity: 'warn', title: '/dev/kvm is absent', fix: 'enable nested virtualization' },
  ],
};

const write = (body: unknown) =>
  writeFileSync(join(stateDir, 'host-access.json'), typeof body === 'string' ? body : JSON.stringify(body));

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'lab-host-access-'));
  vi.stubEnv('DEVENV_STATE', stateDir);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(stateDir, { recursive: true, force: true });
});

describe('readHostAccess', () => {
  it('returns the marker the host-access check wrote', () => {
    write(marker);

    expect(readHostAccess()).toEqual({ ...marker, checkedAt: marker.checkedAt * 1000 });
  });

  it('returns a clean marker with no findings', () => {
    write({ checkedAt: 1756137600, hadTty: true, blocked: 0, warned: 0, findings: [] });

    expect(readHostAccess()?.findings).toEqual([]);
  });

  it('converts the shell writer seconds to the unix ms every other status field uses', () => {
    write({ checkedAt: 1756137600, hadTty: true, blocked: 0, warned: 0, findings: [] });

    expect(readHostAccess()?.checkedAt).toBe(1756137600000);
  });

  it('returns undefined when no marker has been written', () => {
    expect(readHostAccess()).toBeUndefined();
  });

  it('returns undefined when the marker is not valid json', () => {
    write('{"checkedAt": 1756137600,');

    expect(readHostAccess()).toBeUndefined();
  });

  it('returns undefined when the marker fails schema validation', () => {
    write({ ...marker, blocked: 'one' });

    expect(readHostAccess()).toBeUndefined();
  });

  it('returns undefined when a finding carries an unknown probe', () => {
    write({ ...marker, findings: [{ probe: 'selinux', severity: 'warn', title: 't', fix: 'f' }] });

    expect(readHostAccess()).toBeUndefined();
  });

  it('returns undefined when DEVENV_STATE is unset', () => {
    write(marker);
    vi.stubEnv('DEVENV_STATE', '');

    expect(readHostAccess()).toBeUndefined();
  });

  it('resolves the marker path inside DEVENV_STATE', () => {
    expect(hostAccessPath()).toBe(join(stateDir, 'host-access.json'));
  });

  it('resolves no marker path without DEVENV_STATE', () => {
    vi.stubEnv('DEVENV_STATE', '');

    expect(hostAccessPath()).toBeNull();
  });
});
