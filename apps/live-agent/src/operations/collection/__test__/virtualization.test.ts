import { beforeEach, describe, expect, it, vi } from 'vitest';

const { run, readFile, readdir, CommandAborted } = vi.hoisted(() => {
  class CommandAborted extends Error {}
  return { run: vi.fn(), readFile: vi.fn(), readdir: vi.fn(), CommandAborted };
});

vi.mock('../../../exec', () => ({ run, CommandAborted }));
vi.mock('node:fs/promises', () => ({ readFile, readdir }));

import { collectVirtualization } from '.././virtualization';

beforeEach(() => {
  run.mockReset();
  readFile.mockReset();
  readdir.mockReset();
});

describe('collectVirtualization', () => {
  it('returns detected booleans when all probes succeed', async () => {
    readFile.mockResolvedValue('flags : fpu vme vmx');
    readdir.mockResolvedValue(['0', '1']);
    run.mockResolvedValue({ stdout: 'SR-IOV enabled', stderr: '', exit_code: 0 });

    const { virtualization } = await collectVirtualization();

    expect(virtualization).toEqual({
      hypervisor_enabled: true,
      iommu_groups_enabled: true,
      sriov_bios_enabled: true,
    });
  });

  it('surfaces a restricted dmesg as null sriov rather than a definitive false', async () => {
    readFile.mockResolvedValue('flags : fpu vme');
    readdir.mockResolvedValue([]);
    run.mockResolvedValue({ stdout: '', stderr: 'read kernel buffer failed: Operation not permitted', exit_code: 1 });

    const { virtualization } = await collectVirtualization();

    expect(virtualization).toEqual({
      hypervisor_enabled: false,
      iommu_groups_enabled: false,
      sriov_bios_enabled: null,
    });
  });

  it('throws a collector failure when every probe fails', async () => {
    readFile.mockRejectedValue(new Error('EACCES'));
    readdir.mockRejectedValue(new Error('EACCES'));
    run.mockRejectedValue(new Error('spawn dmesg ENOENT'));

    await expect(collectVirtualization()).rejects.toThrow(/virtualization detection failed/);
  });

  it('propagates CommandAborted from dmesg instead of masking it as false', async () => {
    readFile.mockResolvedValue('flags : vmx');
    readdir.mockResolvedValue(['0']);
    run.mockRejectedValue(new CommandAborted('aborted'));

    await expect(collectVirtualization()).rejects.toBeInstanceOf(CommandAborted);
  });
});
