import { afterEach, describe, expect, it, vi } from 'vitest';
import { run } from '../../../exec';
import { runMethod, wipeStrategies } from '.././wipe';

vi.mock('../../../exec', () => ({ run: vi.fn() }));
const mockRun = vi.mocked(run);

const ok = { stdout: '', stderr: '', exit_code: 0, duration_ms: 0 };
const fail = { ...ok, exit_code: 1 };

const ataMethod = () => wipeStrategies('sda', 'rotational', false, 'production')[1]!;

function disableCalls() {
  return mockRun.mock.calls.filter(([, args]) => args?.includes('--security-disable'));
}

describe('wipeStrategies', () => {
  it('NVMe: sanitize crypto → sanitize block → format SES=2 → format SES=1 → blkdiscard', () => {
    const methods = wipeStrategies('nvme0n1', 'nvme', false, 'production');
    expect(methods.map((m) => m.name)).toEqual([
      'NVMe Sanitize Crypto Erase (Purge)',
      'NVMe Sanitize Block Erase (Purge)',
      'NVMe Format SES=2 Crypto Erase (Purge)',
      'NVMe Format SES=1 (user-data erase, Clear)',
      'blkdiscard (best-effort, not standards-classified)',
    ]);
    expect(methods[0]!.commands[0]).toEqual({
      cmd: 'nvme',
      args: ['sanitize', '/dev/nvme0', '--sanact=4', '--ause'],
    });
    expect(methods[1]!.commands[0]).toEqual({
      cmd: 'nvme',
      args: ['sanitize', '/dev/nvme0', '--sanact=2', '--ause'],
    });
    expect(methods[2]!.commands[0]!.args).toContain('/dev/nvme0n1');
  });

  it('NVMe: RAID + environment flags are ignored (NVMe never goes through RAID HBA)', () => {
    const prodNoRaid = wipeStrategies('nvme0n1', 'nvme', false, 'production');
    const devRaid = wipeStrategies('nvme0n1', 'nvme', true, 'development');
    expect(prodNoRaid.map((m) => m.name)).toEqual(devRaid.map((m) => m.name));
  });

  it('NVMe with a preserved controller-sibling: DROPS controller-wide Sanitize, keeps only namespace-scoped erasure', () => {
    const methods = wipeStrategies('nvme0n1', 'nvme', false, 'production', true);
    expect(methods.map((m) => m.name)).toEqual([
      'NVMe Format SES=2 Crypto Erase (Purge)',
      'NVMe Format SES=1 (user-data erase, Clear)',
      'blkdiscard (best-effort, not standards-classified)',
    ]);
    for (const m of methods) {
      for (const c of m.commands) {
        expect(c.args).not.toContain('/dev/nvme0');
      }
    }
  });

  it('NVMe without a preserved sibling keeps the controller-wide Sanitize strategies', () => {
    const guarded = wipeStrategies('nvme0n1', 'nvme', false, 'production', true);
    const unguarded = wipeStrategies('nvme0n1', 'nvme', false, 'production', false);
    expect(unguarded.map((m) => m.name)).toContain('NVMe Sanitize Crypto Erase (Purge)');
    expect(unguarded.map((m) => m.name)).toContain('NVMe Sanitize Block Erase (Purge)');
    expect(unguarded.length).toBe(guarded.length + 2);
  });

  it('SSD non-raid: ATA crypto scramble → block erase → secure erase enhanced → blkdiscard', () => {
    const methods = wipeStrategies('sda', 'ssd', false, 'production');
    expect(methods.map((m) => m.name)).toEqual([
      'ATA Sanitize Crypto Scramble (Purge)',
      'ATA Sanitize Block Erase (Purge)',
      'ATA Secure Erase Enhanced (Purge, legacy)',
      'blkdiscard (best-effort, not standards-classified)',
    ]);
    expect(methods[0]!.commands).toHaveLength(1);
    expect(methods[0]!.commands[0]!.args).toContain('--sanitize-crypto-scramble-ext');
    expect(methods[2]!.commands).toHaveLength(2);
    expect(methods[2]!.commands[1]!.args).toContain('--security-erase-enhanced');
  });

  it('SSD raid: blkdiscard only (ATA skipped to prevent HBA hang)', () => {
    const methods = wipeStrategies('sda', 'ssd', true, 'production');
    expect(methods.map((m) => m.name)).toEqual(['blkdiscard (best-effort, not standards-classified)']);
  });

  it('HDD prod non-raid: sanitize overwrite → secure erase enhanced → secure erase → dd urandom', () => {
    const methods = wipeStrategies('sda', 'rotational', false, 'production');
    expect(methods.map((m) => m.name)).toEqual([
      'ATA Sanitize Overwrite (Purge)',
      'ATA Secure Erase Enhanced (Purge, legacy)',
      'ATA Secure Erase (Clear, legacy)',
      'Random data overwrite (Clear)',
    ]);
    const ddMethod = methods[3]!;
    expect(ddMethod.commands[0]!.args).toContain('status=progress');
    expect(ddMethod.commands[0]!.trackProgress).toBe(true);
  });

  it('HDD prod raid: dd urandom only (ATA skipped)', () => {
    const methods = wipeStrategies('sda', 'rotational', true, 'production');
    expect(methods.map((m) => m.name)).toEqual(['Random data overwrite (Clear)']);
    expect(methods[0]!.commands[0]!.trackProgress).toBe(true);
  });

  it('HDD dev: partition table stamp only (count=1)', () => {
    const methods = wipeStrategies('sda', 'rotational', false, 'development');
    expect(methods.map((m) => m.name)).toEqual(['Partition table wipe (development mode)']);
    const cmd = methods[0]!.commands[0]!;
    expect(cmd.args).toEqual(['if=/dev/zero', 'of=/dev/sda', 'bs=1M', 'count=1']);
    expect(cmd.trackProgress).toBeFalsy();
  });

  it('HDD dev: same single-method regardless of RAID flag', () => {
    const noRaid = wipeStrategies('sda', 'rotational', false, 'development');
    const raid = wipeStrategies('sda', 'rotational', true, 'development');
    expect(noRaid.map((m) => m.name)).toEqual(raid.map((m) => m.name));
  });
});

describe('runMethod: ATA secure-erase security recovery', () => {
  afterEach(() => mockRun.mockReset());

  it('pre-clears leftover security before set-pass', async () => {
    mockRun.mockResolvedValue(ok);
    await runMethod(ataMethod(), '/dev/sda');
    expect(mockRun.mock.calls[0]![1]).toContain('--security-disable');
    expect(mockRun.mock.calls[1]![1]).toContain('--security-set-pass');
  });

  it('disables security when the erase step exits nonzero', async () => {
    mockRun.mockResolvedValueOnce(ok).mockResolvedValueOnce(ok).mockResolvedValueOnce(fail);
    const result = await runMethod(ataMethod(), '/dev/sda');
    expect(result).toBe(false);
    expect(disableCalls()).toHaveLength(2);
  });

  it('disables security then re-throws when the erase step times out', async () => {
    mockRun
      .mockResolvedValueOnce(ok)
      .mockResolvedValueOnce(ok)
      .mockRejectedValueOnce(new Error('command timed out'))
      .mockResolvedValueOnce(ok);
    await expect(runMethod(ataMethod(), '/dev/sda')).rejects.toThrow('timed out');
    expect(disableCalls()).toHaveLength(2);
  });

  it('gives the erase step the long timeout, set-pass the default', async () => {
    mockRun.mockResolvedValue(ok);
    await runMethod(ataMethod(), '/dev/sda');
    const setPass = mockRun.mock.calls.find(([, a]) => a?.includes('--security-set-pass'))!;
    const erase = mockRun.mock.calls.find(([, a]) => a?.includes('--security-erase-enhanced'))!;
    expect(setPass[2]!.timeout_ms).toBe(600_000);
    expect(erase[2]!.timeout_ms).toBe(8 * 3600 * 1000);
  });

  it('never touches security for non-ATA methods', async () => {
    mockRun.mockResolvedValue(fail);
    const blkdiscard = wipeStrategies('sda', 'ssd', true, 'production')[0]!;
    await runMethod(blkdiscard, '/dev/sda');
    expect(disableCalls()).toHaveLength(0);
  });
});
