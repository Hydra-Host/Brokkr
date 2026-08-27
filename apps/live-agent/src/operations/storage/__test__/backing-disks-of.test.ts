import { beforeEach, describe, expect, it, vi } from 'vitest';

const runMock = vi.fn();
vi.mock('../../../exec', () => ({ run: (...args: unknown[]) => runMock(...args) }));

const readFileMock = vi.fn();
const readdirMock = vi.fn();
vi.mock('node:fs/promises', () => ({
  access: vi.fn().mockResolvedValue(undefined),
  readdir: (...args: unknown[]) => readdirMock(...args),
  readFile: (...args: unknown[]) => readFileMock(...args),
  stat: vi.fn(),
  writeFile: vi.fn().mockResolvedValue(undefined),
}));

import { backingDisksOf, probeMdadmMembers, type HolderNode } from '../teardown-holders';

beforeEach(() => {
  runMock.mockReset();
  readFileMock.mockReset();
  readdirMock.mockReset();
});

function ok(stdout: string) {
  return Promise.resolve({ stdout, stderr: '', exit_code: 0, duration_ms: 1 });
}

describe('backingDisksOf — LVM VG completeness (data-loss guard)', () => {
  it('returns every PV disk in the VG, not just the LV-mapped slave', async () => {
    readFileMock.mockImplementation((p: string) => {
      if (String(p).includes('/dm/name')) return Promise.resolve('vgdata-lvroot\n');
      return Promise.reject(new Error('no such file'));
    });
    readdirMock.mockResolvedValue(['sda1']);
    runMock.mockImplementation((cmd: string, args: readonly string[]) => {
      if (cmd === 'dmsetup' && args[0] === 'splitname') return ok('vgdata\n');
      if (cmd === 'pvs') return ok('  /dev/sda1\n  /dev/sdb1\n');
      return ok('');
    });

    const node: HolderNode = { name: 'dm-0', layer_type: 'lvm', depth: 1, holders: [] };
    const { disks } = await backingDisksOf(node);

    expect(disks.has('sda')).toBe(true);
    expect(disks.has('sdb')).toBe(true);
  });

  it('resolves an md-backed VG PV to its array members (LVM-on-RAID)', async () => {
    readFileMock.mockImplementation((p: string) => {
      if (String(p).includes('/dm/name')) return Promise.resolve('vgdata-lvroot\n');
      return Promise.reject(new Error('no such file'));
    });
    readdirMock.mockResolvedValue([]);
    runMock.mockImplementation((cmd: string, args: readonly string[]) => {
      if (cmd === 'dmsetup' && args[0] === 'splitname') return ok('vgdata\n');
      if (cmd === 'pvs') return ok('  /dev/md0\n');
      if (cmd === 'mdadm' && args[0] === '--detail') {
        return ok('/dev/md0:\n   0  8  17  0  active sync  /dev/sdc1\n   1  8  33  1  active sync  /dev/sdd1\n');
      }
      return ok('');
    });

    const node: HolderNode = { name: 'dm-1', layer_type: 'lvm', depth: 1, holders: [] };
    const { disks } = await backingDisksOf(node);

    expect(disks.has('sdc')).toBe(true);
    expect(disks.has('sdd')).toBe(true);
  });

  it('flags indeterminate when mdadm --detail fails on a raid node (fail closed)', async () => {
    runMock.mockImplementation((cmd: string, args: readonly string[]) => {
      if (cmd === 'mdadm' && args[0] === '--detail') {
        return Promise.resolve({ stdout: '', stderr: 'mdadm: cannot open', exit_code: 1, duration_ms: 1 });
      }
      return ok('');
    });

    const node: HolderNode = { name: 'md0', layer_type: 'raid', depth: 1, holders: [] };
    const { disks, indeterminate } = await backingDisksOf(node);

    expect(indeterminate).toBe(true);
    expect(disks.size).toBe(0);
  });
});

describe('probeMdadmMembers', () => {
  it('returns ok with parsed members on a clean exit', async () => {
    runMock.mockImplementation(() =>
      ok('/dev/md0:\n   0  8  17  0  active sync  /dev/sdc1\n   1  8  33  1  active sync  /dev/sdd1\n'),
    );

    const probe = await probeMdadmMembers('/dev/md0');

    expect(probe.ok).toBe(true);
    if (probe.ok) expect(probe.members).toEqual(['/dev/sdc1', '/dev/sdd1']);
  });

  it('returns not-ok on a nonzero exit (no member enumeration)', async () => {
    runMock.mockResolvedValue({ stdout: '', stderr: 'fail', exit_code: 2, duration_ms: 1 });

    expect(await probeMdadmMembers('/dev/md0')).toEqual({ ok: false });
  });

  it('returns not-ok when run throws (timeout/abort/spawn failure)', async () => {
    runMock.mockRejectedValue(new Error('CommandTimeout'));

    expect(await probeMdadmMembers('/dev/md0')).toEqual({ ok: false });
  });

  it('returns not-ok when --detail exits 0 but enumerates no members (indeterminate, not definitively empty)', async () => {
    runMock.mockImplementation(() => ok('/dev/md0:\n   Raid Level : raid1\n   State : clean, degraded\n'));

    expect(await probeMdadmMembers('/dev/md0')).toEqual({ ok: false });
  });
});
