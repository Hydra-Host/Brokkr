import { beforeEach, describe, expect, it, vi } from 'vitest';

const runMock = vi.fn();
vi.mock('../../../exec', () => ({ run: (...args: unknown[]) => runMock(...args) }));

const readFileMock = vi.fn();
vi.mock('node:fs/promises', () => ({
  access: vi.fn().mockResolvedValue(undefined),
  readdir: vi.fn().mockResolvedValue([]),
  readFile: (...args: unknown[]) => readFileMock(...args),
  stat: vi.fn(),
  writeFile: vi.fn().mockResolvedValue(undefined),
}));

import { removeLvm, type TeardownSummary } from '../teardownHolders';

function emptySummary(): TeardownSummary {
  return {
    crypt_closed: [],
    lvm_removed: [],
    vg_removed: [],
    raid_stopped: [],
    swap_deactivated: [],
    signatures_cleared: [],
    skipped_preserved: [],
  };
}

const jobLog = {
  info: vi.fn().mockResolvedValue(undefined),
  warn: vi.fn().mockResolvedValue(undefined),
  debug: vi.fn().mockResolvedValue(undefined),
};

function stubRun(pvsOutput: string, mdadmDetail = ''): void {
  runMock.mockImplementation((cmd: string, args: readonly string[]) => {
    if (cmd === 'dmsetup' && args[0] === 'splitname') {
      return Promise.resolve({ stdout: 'vgdata/lvroot\n', stderr: '', exit_code: 0, duration_ms: 1 });
    }
    if (cmd === 'pvs') {
      return Promise.resolve({ stdout: pvsOutput, stderr: '', exit_code: 0, duration_ms: 1 });
    }
    if (cmd === 'lvs') {
      return Promise.resolve({ stdout: '', stderr: '', exit_code: 0, duration_ms: 1 });
    }
    if (cmd === 'mdadm' && args[0] === '--detail') {
      return Promise.resolve({ stdout: mdadmDetail, stderr: '', exit_code: 0, duration_ms: 1 });
    }
    return Promise.resolve({ stdout: '', stderr: '', exit_code: 0, duration_ms: 1 });
  });
}

function commandsRun(): string[] {
  return runMock.mock.calls.map((c) => `${c[0]} ${(c[1] as string[]).join(' ')}`);
}

beforeEach(() => {
  runMock.mockReset();
  readFileMock.mockReset();
  jobLog.info.mockClear();
  readFileMock.mockResolvedValue('vgdata-lvroot\n');
});

describe('removeLvm — VG spanning a preserved disk (data-loss guard)', () => {
  it('aborts the entire LVM teardown (no lvremove/vgremove/pvremove) when a VG PV is on a preserved disk', async () => {
    stubRun('  /dev/sda1\n  /dev/sdb1\n');
    const summary = emptySummary();

    await removeLvm('dm-0', new Set(['sdb']), summary, jobLog);

    const cmds = commandsRun();
    expect(cmds.some((c) => c.startsWith('lvremove'))).toBe(false);
    expect(cmds.some((c) => c.startsWith('vgremove'))).toBe(false);
    expect(cmds.some((c) => c.startsWith('pvremove'))).toBe(false);
    expect(cmds.some((c) => c.startsWith('dmsetup remove'))).toBe(false);
    expect(summary.lvm_removed).toEqual([]);
    expect(summary.vg_removed).toEqual([]);
    expect(jobLog.info.mock.calls.some((c) => String(c[0]).includes('PRESERVE'))).toBe(true);
  });

  it('aborts when a VG PV is a RAID array whose members include a preserved disk (LVM-on-RAID)', async () => {
    stubRun(
      '  /dev/md0\n',
      [
        '/dev/md0:',
        '    Number   Major   Minor   RaidDevice State',
        '       0       8        0        0      active sync   /dev/sda',
        '       1       8       16        1      active sync   /dev/sdb',
      ].join('\n'),
    );
    const summary = emptySummary();

    await removeLvm('dm-0', new Set(['sda']), summary, jobLog);

    const cmds = commandsRun();
    expect(cmds.some((c) => c.startsWith('lvremove'))).toBe(false);
    expect(cmds.some((c) => c.startsWith('vgremove'))).toBe(false);
    expect(cmds.some((c) => c.startsWith('pvremove'))).toBe(false);
    expect(cmds.some((c) => c.startsWith('dmsetup remove'))).toBe(false);
    expect(summary.lvm_removed).toEqual([]);
    expect(jobLog.info.mock.calls.some((c) => String(c[0]).includes('PRESERVE'))).toBe(true);
  });

  it('proceeds when a RAID-backed PV has no preserved member', async () => {
    stubRun(
      '  /dev/md0\n',
      [
        '/dev/md0:',
        '       0       8       32        0      active sync   /dev/sdc',
        '       1       8       48        1      active sync   /dev/sdd',
      ].join('\n'),
    );
    const summary = emptySummary();

    await removeLvm('dm-0', new Set(['sda']), summary, jobLog);

    const cmds = commandsRun();
    expect(cmds.some((c) => c.startsWith('vgremove'))).toBe(true);
    expect(cmds).toContain('pvremove --force --force --yes /dev/md0');
  });

  it('proceeds to vgremove + pvremove when no PV touches a preserved disk', async () => {
    stubRun('  /dev/sda1\n  /dev/sdc1\n');
    const summary = emptySummary();

    await removeLvm('dm-0', new Set(['sdb']), summary, jobLog);

    const cmds = commandsRun();
    expect(cmds.some((c) => c.startsWith('lvremove'))).toBe(true);
    expect(cmds.some((c) => c.startsWith('vgremove'))).toBe(true);
    expect(cmds).toContain('pvremove --force --force --yes /dev/sda1');
    expect(cmds).toContain('pvremove --force --force --yes /dev/sdc1');
    expect(summary.vg_removed).toEqual(['vgdata']);
  });
});
