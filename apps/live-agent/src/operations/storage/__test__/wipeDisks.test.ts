import { describe, expect, it } from 'vitest';
import {
  buildSanitizationReport,
  classifyDiskType,
  classifyMethod,
  diskMediaType,
  sizeHuman,
  updateOptimalOsDisk,
  wipePhaseProgress,
} from '.././wipeDisks';

describe('classifyMethod', () => {
  it('picks purge for any technique containing "Purge"', () => {
    expect(classifyMethod('NVMe Sanitize Block Erase (Purge)')).toBe('purge');
    expect(classifyMethod('ATA Secure Erase Enhanced (Purge, legacy)')).toBe('purge');
    expect(classifyMethod('ATA Sanitize Overwrite (Purge)')).toBe('purge');
  });

  it('picks clear for any technique containing "Clear"', () => {
    expect(classifyMethod('NVMe Format SES=1 (user-data erase, Clear)')).toBe('clear');
    expect(classifyMethod('ATA Secure Erase (Clear, legacy)')).toBe('clear');
    expect(classifyMethod('Random data overwrite (Clear)')).toBe('clear');
  });

  it('picks best-effort for blkdiscard-style techniques', () => {
    expect(classifyMethod('blkdiscard (best-effort, not standards-classified)')).toBe('best-effort');
  });

  it('picks none for dev-mode', () => {
    expect(classifyMethod('Partition table wipe (development mode)')).toBe('none');
  });

  it('returns unknown on empty / unfamiliar strings', () => {
    expect(classifyMethod('unknown')).toBe('unknown');
    expect(classifyMethod('')).toBe('unknown');
    expect(classifyMethod('whatever')).toBe('unknown');
  });

  it('prefers the first matching keyword (Purge beats Clear in ambiguous strings)', () => {
    expect(classifyMethod('Custom Purge Clear mix')).toBe('purge');
  });
});

describe('diskMediaType', () => {
  const base = {
    type: 'disk',
    size: 1000,
    ro: false,
    model: null,
    serial: null,
    wwn: undefined,
    tran: null,
  };

  it('NVMe for any device with nvme in the name', () => {
    expect(diskMediaType({ ...base, name: 'nvme0n1', rota: false })).toBe('NVMe');
    expect(diskMediaType({ ...base, name: 'nvme1n1', rota: false })).toBe('NVMe');
  });

  it('SSD for non-rotational non-NVMe', () => {
    expect(diskMediaType({ ...base, name: 'sda', rota: false })).toBe('SSD');
  });

  it('HDD for rotational disks', () => {
    expect(diskMediaType({ ...base, name: 'sda', rota: true })).toBe('HDD');
  });
});

describe('classifyDiskType', () => {
  it('nvme beats rota flag when name starts with nvme', () => {
    expect(classifyDiskType('nvme0n1', true)).toBe('nvme');
    expect(classifyDiskType('nvme0n1', false)).toBe('nvme');
  });

  it('ssd when not rotational and not NVMe', () => {
    expect(classifyDiskType('sda', false)).toBe('ssd');
  });

  it('rotational when the rota flag is set', () => {
    expect(classifyDiskType('sda', true)).toBe('rotational');
  });
});

describe('sizeHuman', () => {
  it('formats to 1 decimal place of GB', () => {
    expect(sizeHuman(0)).toBe('0.0GB');
    expect(sizeHuman(1024 ** 3)).toBe('1.0GB');
    expect(sizeHuman(500 * 1024 ** 3)).toBe('500.0GB');
    expect(sizeHuman(512 * 1024 ** 3)).toBe('512.0GB');
  });
});

describe('wipePhaseProgress', () => {
  it('scales completed wipe targets from zero to 0.9', () => {
    expect(wipePhaseProgress(0, 4)).toBe(0);
    expect(wipePhaseProgress(1, 4)).toBe(0.225);
    expect(wipePhaseProgress(4, 4)).toBe(0.9);
    expect(wipePhaseProgress(0, 0)).toBe(0.9);
  });
});

describe('updateOptimalOsDisk', () => {
  const make = (name: string, rota: boolean, size: number) => ({
    name,
    rota,
    type: 'disk',
    size,
    ro: false,
    model: null,
    serial: null,
    wwn: undefined,
    tran: null,
  });

  it('first HDD becomes the pick', () => {
    const pick = updateOptimalOsDisk(null, make('sda', true, 1_000_000));
    expect(pick).toEqual({ name: 'sda', size: 1_000_000, type: 'hdd' });
  });

  it('SSD upgrades over HDD', () => {
    const start = updateOptimalOsDisk(null, make('sda', true, 10_000_000));
    const upgraded = updateOptimalOsDisk(start, make('sdb', false, 1_000_000));
    expect(upgraded).toEqual({ name: 'sdb', size: 1_000_000, type: 'ssd' });
  });

  it('NVMe upgrades over SSD and HDD', () => {
    const hddPick = updateOptimalOsDisk(null, make('sda', true, 10_000_000));
    const nvmePick = updateOptimalOsDisk(hddPick, make('nvme0n1', false, 500));
    expect(nvmePick?.type).toBe('nvme');
    expect(nvmePick?.name).toBe('nvme0n1');
  });

  it('within NVMe, keeps the largest', () => {
    const small = updateOptimalOsDisk(null, make('nvme0n1', false, 1000));
    const larger = updateOptimalOsDisk(small, make('nvme1n1', false, 2000));
    expect(larger?.name).toBe('nvme1n1');
    const sameSmall = updateOptimalOsDisk(larger, make('nvme2n1', false, 100));
    expect(sameSmall?.name).toBe('nvme1n1');
  });

  it('SSD does not replace NVMe even when bigger', () => {
    const nvme = updateOptimalOsDisk(null, make('nvme0n1', false, 100));
    const ssdPick = updateOptimalOsDisk(nvme, make('sda', false, 999_999));
    expect(ssdPick?.name).toBe('nvme0n1');
  });

  it('HDD does not replace anything once something exists', () => {
    const ssd = updateOptimalOsDisk(null, make('sda', false, 100));
    const withHdd = updateOptimalOsDisk(ssd, make('sdb', true, 1_000_000));
    expect(withHdd?.name).toBe('sda');
  });
});

describe('buildSanitizationReport', () => {
  const emptyTeardown = {
    crypt_closed: [],
    lvm_removed: [],
    vg_removed: [],
    raid_stopped: [],
    swap_deactivated: [],
    signatures_cleared: [],
    skipped_preserved: [],
  };
  const startedAt = new Date('2026-04-21T17:00:00.000Z');
  const completedAt = new Date('2026-04-21T17:05:30.000Z');

  const nvmeDisk = {
    name: 'nvme0n1',
    rota: false,
    type: 'disk',
    size: 1_000_000_000_000,
    ro: false,
    model: 'Samsung PM983',
    serial: 'S4YMNE0M111111',
    wwn: 'eui.0025385c91b4aaaa',
    tran: 'nvme',
  };

  it('single NVMe pass — full report shape', () => {
    const report = buildSanitizationReport({
      mode: 'selective',
      startedAt,
      completedAt,
      durationSeconds: 330,
      teardownResult: emptyTeardown,
      disksToWipe: [nvmeDisk],
      preservedDiskInfo: [],
      skippedDisks: [],
      requestedWipeCount: 1,
      validationResults: {
        nvme0n1: {
          method: 'sector_sampling',
          sample_count: 1000,
          sectors_checked: 1000,
          sectors_zeroed: 1000,
          sectors_failed: 0,
          sectors_unreadable: 0,
          result: 'pass',
        },
      },
      wipeMethods: { nvme0n1: 'NVMe Sanitize Block Erase (Purge)' },
      jobId: 'test-job-123',
      toolVersion: '1.2.3',
    });

    expect(report.version).toBe('1.0');
    expect(report.standards_reference).toEqual([
      'NIST SP 800-88r2 (September 2025)',
      'IEEE 2883 (2022)',
      'ISO/IEC 27040 (2024)',
    ]);
    expect(report.job_id).toBe('test-job-123');
    expect(report.mode).toBe('selective');
    expect(report.started_at).toBe('2026-04-21T17:00:00.000Z');
    expect(report.completed_at).toBe('2026-04-21T17:05:30.000Z');
    expect(report.duration_seconds).toBe(330);
    expect(report.overall_result).toBe('pass');
    expect(report.tool).toEqual({ name: 'brokkr-bridge', version: '1.2.3' });
    expect(report.disks).toHaveLength(1);
    expect(report.disks[0]).toMatchObject({
      name: 'nvme0n1',
      device_path: '/dev/nvme0n1',
      media_type: 'NVMe',
      model: 'Samsung PM983',
      serial: 'S4YMNE0M111111',
      wwn: 'eui.0025385c91b4aaaa',
      transport: 'nvme',
      size_bytes: 1_000_000_000_000,
      rotational: false,
      sanitization_method: 'purge',
      sanitization_technique: 'NVMe Sanitize Block Erase (Purge)',
      result: 'pass',
    });
  });

  it('crypto-erase fail still passes overall (pass_crypto_erase)', () => {
    const report = buildSanitizationReport({
      mode: 'full',
      startedAt,
      completedAt,
      durationSeconds: 100,
      teardownResult: emptyTeardown,
      disksToWipe: [nvmeDisk],
      preservedDiskInfo: [],
      skippedDisks: [],
      requestedWipeCount: 1,
      validationResults: {
        nvme0n1: {
          method: 'sector_sampling',
          sample_count: 1000,
          sectors_checked: 1000,
          sectors_zeroed: 997,
          sectors_failed: 3,
          sectors_unreadable: 0,
          result: 'pass_crypto_erase',
          note: 'stale ciphertext expected',
        },
      },
      wipeMethods: { nvme0n1: 'NVMe Sanitize Crypto Erase (Purge)' },
      jobId: '',
      toolVersion: '1.0.0',
    });

    expect(report.overall_result).toBe('pass');
    expect(report.disks[0]!.result).toBe('pass_crypto_erase');
  });

  it('overwrite method with non-zero residue fails overall', () => {
    const hddDisk = { ...nvmeDisk, name: 'sda', rota: true, tran: 'sata' };
    const report = buildSanitizationReport({
      mode: 'full',
      startedAt,
      completedAt,
      durationSeconds: 100,
      teardownResult: emptyTeardown,
      disksToWipe: [hddDisk],
      preservedDiskInfo: [],
      skippedDisks: [],
      requestedWipeCount: 1,
      validationResults: {
        sda: {
          method: 'sector_sampling',
          sample_count: 1000,
          sectors_checked: 1000,
          sectors_zeroed: 995,
          sectors_failed: 5,
          sectors_unreadable: 0,
          result: 'fail',
        },
      },
      wipeMethods: { sda: 'Random data overwrite (Clear)' },
      jobId: 'job',
      toolVersion: 'v',
    });

    expect(report.overall_result).toBe('fail');
    expect(report.disks[0]!.result).toBe('fail');
  });

  it('technique=unknown fails even without a validation record', () => {
    const report = buildSanitizationReport({
      mode: 'full',
      startedAt,
      completedAt,
      durationSeconds: 10,
      teardownResult: emptyTeardown,
      disksToWipe: [nvmeDisk],
      preservedDiskInfo: [],
      skippedDisks: [],
      requestedWipeCount: 1,
      validationResults: {},
      wipeMethods: {},
      jobId: '',
      toolVersion: 'v',
    });

    expect(report.overall_result).toBe('fail');
    expect(report.disks[0]!.sanitization_technique).toBe('unknown');
    expect(report.disks[0]!.result).toBe('fail');
    expect(report.disks[0]!.verification).toEqual({ result: 'not_validated' });
  });

  it('preserved / skipped sections surface correctly', () => {
    const preserved = { ...nvmeDisk, name: 'sdb', rota: true };
    const report = buildSanitizationReport({
      mode: 'selective',
      startedAt,
      completedAt,
      durationSeconds: 1,
      teardownResult: emptyTeardown,
      disksToWipe: [],
      preservedDiskInfo: [preserved],
      skippedDisks: [{ name: 'sdc', reason: 'read-only device' }],
      requestedWipeCount: 0,
      validationResults: {},
      wipeMethods: {},
      jobId: '',
      toolVersion: 'v',
    });

    expect(report.preserved_disks).toHaveLength(1);
    expect(report.preserved_disks[0]).toMatchObject({
      name: 'sdb',
      device_path: '/dev/sdb',
      media_type: 'HDD',
      reason: 'wipe=false in disk_layouts',
    });
    expect(report.skipped_disks).toEqual([{ name: 'sdc', reason: 'read-only device' }]);
    expect(report.overall_result).toBe('pass');
  });

  it('full-mode wipe that discovers zero disks fails closed (never NIST pass)', () => {
    const report = buildSanitizationReport({
      mode: 'full',
      startedAt,
      completedAt,
      durationSeconds: 1,
      teardownResult: emptyTeardown,
      disksToWipe: [],
      preservedDiskInfo: [],
      skippedDisks: [],
      requestedWipeCount: 0,
      validationResults: {},
      wipeMethods: {},
      jobId: '',
      toolVersion: 'v',
    });

    expect(report.disks).toHaveLength(0);
    expect(report.overall_result).toBe('fail');
  });

  it('full-mode wipe fails closed when a pre-teardown disk vanishes from post-teardown discovery', () => {
    const wiped = { ...nvmeDisk, name: 'nvme0n1' };
    const report = buildSanitizationReport({
      mode: 'full',
      startedAt,
      completedAt,
      durationSeconds: 120,
      teardownResult: emptyTeardown,
      disksToWipe: [wiped],
      preservedDiskInfo: [],
      skippedDisks: [],
      requestedWipeCount: 2,
      allDiskNames: ['nvme0n1', 'sdb'],
      postTeardownDiskNames: ['nvme0n1'],
      validationResults: {
        nvme0n1: {
          method: 'sector_sampling',
          sample_count: 1000,
          sectors_checked: 1000,
          sectors_zeroed: 1000,
          sectors_failed: 0,
          sectors_unreadable: 0,
          result: 'pass',
        },
      },
      wipeMethods: { nvme0n1: 'NVMe Sanitize Block Erase (Purge)' },
      jobId: 'deprovision-vanish',
      toolVersion: 'v',
    });

    expect(report.disks).toHaveLength(1);
    expect(report.disks[0]!.name).toBe('nvme0n1');
    expect(report.overall_result).toBe('fail');
    expect(report.skipped_disks).toContainEqual({
      name: 'sdb',
      reason: 'disappeared after teardown — not sanitized, not re-discovered',
    });
  });

  it('full-mode wipe fails closed when a physical disk is skipped read-only (never sanitized)', () => {
    const wiped = { ...nvmeDisk, name: 'nvme0n1' };
    const report = buildSanitizationReport({
      mode: 'full',
      startedAt,
      completedAt,
      durationSeconds: 120,
      teardownResult: emptyTeardown,
      disksToWipe: [wiped],
      preservedDiskInfo: [],
      skippedDisks: [{ name: 'sdb', reason: 'read-only device' }],
      requestedWipeCount: 2,
      allDiskNames: ['nvme0n1', 'sdb'],
      postTeardownDiskNames: ['nvme0n1', 'sdb'],
      validationResults: {
        nvme0n1: {
          method: 'sector_sampling',
          sample_count: 1000,
          sectors_checked: 1000,
          sectors_zeroed: 1000,
          sectors_failed: 0,
          sectors_unreadable: 0,
          result: 'pass',
        },
      },
      wipeMethods: { nvme0n1: 'NVMe Sanitize Block Erase (Purge)' },
      jobId: 'deprovision-ro',
      toolVersion: 'v',
    });

    expect(report.overall_result).toBe('fail');
    expect(report.skipped_disks).toEqual([{ name: 'sdb', reason: 'read-only device' }]);
  });

  it('full-mode wipe with all pre-teardown disks wiped stays pass (no false reconciliation failure)', () => {
    const wiped = { ...nvmeDisk, name: 'nvme0n1' };
    const wiped2 = { ...nvmeDisk, name: 'sdb', rota: true };
    const report = buildSanitizationReport({
      mode: 'full',
      startedAt,
      completedAt,
      durationSeconds: 120,
      teardownResult: emptyTeardown,
      disksToWipe: [wiped, wiped2],
      preservedDiskInfo: [],
      skippedDisks: [],
      requestedWipeCount: 2,
      allDiskNames: ['nvme0n1', 'sdb'],
      postTeardownDiskNames: ['nvme0n1', 'sdb'],
      validationResults: {
        nvme0n1: {
          method: 'sector_sampling',
          sample_count: 1000,
          sectors_checked: 1000,
          sectors_zeroed: 1000,
          sectors_failed: 0,
          sectors_unreadable: 0,
          result: 'pass',
        },
        sdb: {
          method: 'sector_sampling',
          sample_count: 1000,
          sectors_checked: 1000,
          sectors_zeroed: 5,
          sectors_failed: 0,
          sectors_unreadable: 0,
          result: 'pass',
        },
      },
      wipeMethods: {
        nvme0n1: 'NVMe Sanitize Block Erase (Purge)',
        sdb: 'ATA Sanitize Overwrite (Purge)',
      },
      jobId: 'deprovision-ok',
      toolVersion: 'v',
    });

    expect(report.overall_result).toBe('pass');
    expect(report.skipped_disks).toEqual([]);
  });

  it('full-mode wipe fails closed when a wiped disk was never validated (fail-OPEN guard)', () => {
    const report = buildSanitizationReport({
      mode: 'full',
      environment: 'production',
      startedAt,
      completedAt,
      durationSeconds: 100,
      teardownResult: emptyTeardown,
      disksToWipe: [nvmeDisk],
      preservedDiskInfo: [],
      skippedDisks: [],
      requestedWipeCount: 1,
      allDiskNames: ['nvme0n1'],
      postTeardownDiskNames: ['nvme0n1'],
      validationResults: {},
      wipeMethods: { nvme0n1: 'NVMe Sanitize Block Erase (Purge)' },
      jobId: 'deprovision-unvalidated',
      toolVersion: 'v',
    });

    expect(report.disks[0]!.sanitization_technique).toBe('NVMe Sanitize Block Erase (Purge)');
    expect(report.disks[0]!.verification).toEqual({ result: 'not_validated' });
    expect(report.disks[0]!.result).toBe('fail');
    expect(report.overall_result).toBe('fail');
  });

  it('full-mode dev rotational skip stays pass when not_validated (dev path not regressed)', () => {
    const hddDisk = { ...nvmeDisk, name: 'sda', rota: true, tran: 'sata' };
    const report = buildSanitizationReport({
      mode: 'full',
      environment: 'development',
      startedAt,
      completedAt,
      durationSeconds: 100,
      teardownResult: emptyTeardown,
      disksToWipe: [hddDisk],
      preservedDiskInfo: [],
      skippedDisks: [],
      requestedWipeCount: 1,
      allDiskNames: ['sda'],
      postTeardownDiskNames: ['sda'],
      validationResults: {},
      wipeMethods: { sda: 'development zero-fill (first 1MB)' },
      jobId: 'dev-rota',
      toolVersion: 'v',
    });

    expect(report.disks[0]!.verification).toEqual({ result: 'not_validated' });
    expect(report.disks[0]!.result).toBe('pass');
    expect(report.overall_result).toBe('pass');
  });

  it('SELECTIVE-mode wipe fails closed when a wiped disk was never validated (verdict no longer diverges by mode)', () => {
    const report = buildSanitizationReport({
      mode: 'selective',
      environment: 'production',
      startedAt,
      completedAt,
      durationSeconds: 100,
      teardownResult: emptyTeardown,
      disksToWipe: [nvmeDisk],
      preservedDiskInfo: [],
      skippedDisks: [],
      requestedWipeCount: 1,
      validationResults: {},
      wipeMethods: { nvme0n1: 'NVMe Sanitize Block Erase (Purge)' },
      jobId: 'reprov-unvalidated',
      toolVersion: 'v',
    });

    expect(report.disks[0]!.sanitization_technique).toBe('NVMe Sanitize Block Erase (Purge)');
    expect(report.disks[0]!.verification).toEqual({ result: 'not_validated' });
    expect(report.disks[0]!.result).toBe('fail');
    expect(report.overall_result).toBe('fail');
  });

  it('SELECTIVE-mode dev rotational skip stays pass when not_validated (dev path not regressed)', () => {
    const hddDisk = { ...nvmeDisk, name: 'sda', rota: true, tran: 'sata' };
    const report = buildSanitizationReport({
      mode: 'selective',
      environment: 'development',
      startedAt,
      completedAt,
      durationSeconds: 100,
      teardownResult: emptyTeardown,
      disksToWipe: [hddDisk],
      preservedDiskInfo: [],
      skippedDisks: [],
      requestedWipeCount: 1,
      validationResults: {},
      wipeMethods: { sda: 'development zero-fill (first 1MB)' },
      jobId: 'dev-rota-selective',
      toolVersion: 'v',
    });

    expect(report.disks[0]!.verification).toEqual({ result: 'not_validated' });
    expect(report.disks[0]!.result).toBe('pass');
    expect(report.overall_result).toBe('pass');
  });

  it('full-mode wipe fails closed when a disk appears ONLY after teardown (never sanitized)', () => {
    const wiped = { ...nvmeDisk, name: 'nvme0n1' };
    const report = buildSanitizationReport({
      mode: 'full',
      environment: 'production',
      startedAt,
      completedAt,
      durationSeconds: 120,
      teardownResult: emptyTeardown,
      disksToWipe: [wiped],
      preservedDiskInfo: [],
      skippedDisks: [],
      requestedWipeCount: 1,
      allDiskNames: ['nvme0n1'],
      postTeardownDiskNames: ['nvme0n1', 'sdb'],
      validationResults: {
        nvme0n1: {
          method: 'sector_sampling',
          sample_count: 1000,
          sectors_checked: 1000,
          sectors_zeroed: 1000,
          sectors_failed: 0,
          sectors_unreadable: 0,
          result: 'pass',
        },
      },
      wipeMethods: { nvme0n1: 'NVMe Sanitize Block Erase (Purge)' },
      jobId: 'deprovision-appeared',
      toolVersion: 'v',
    });

    expect(report.disks).toHaveLength(1);
    expect(report.disks[0]!.name).toBe('nvme0n1');
    expect(report.overall_result).toBe('fail');
    expect(report.skipped_disks).toContainEqual({
      name: 'sdb',
      reason: 'appeared after teardown — not in pre-teardown enumeration, not sanitized',
    });
  });

  it('selective wipe with every target excluded for a shared preserved stack fails closed', () => {
    const report = buildSanitizationReport({
      mode: 'selective',
      startedAt,
      completedAt,
      durationSeconds: 1,
      teardownResult: emptyTeardown,
      disksToWipe: [],
      preservedDiskInfo: [],
      skippedDisks: [{ name: 'sdb', reason: 'shares a RAID/VG stack with a preserved disk' }],
      requestedWipeCount: 1,
      validationResults: {},
      wipeMethods: {},
      jobId: '',
      toolVersion: 'v',
    });

    expect(report.disks).toHaveLength(0);
    expect(report.overall_result).toBe('fail');
  });

  it('selective wipe fails closed when the requested target vanished from discovery (no skip reason)', () => {
    const report = buildSanitizationReport({
      mode: 'selective',
      startedAt,
      completedAt,
      durationSeconds: 1,
      teardownResult: emptyTeardown,
      disksToWipe: [],
      preservedDiskInfo: [],
      skippedDisks: [],
      requestedWipeCount: 1,
      validationResults: {},
      wipeMethods: {},
      jobId: '',
      toolVersion: 'v',
    });

    expect(report.disks).toHaveLength(0);
    expect(report.overall_result).toBe('fail');
  });

  it('selective wipe fails closed when ONE requested target vanished while another was wiped', () => {
    const report = buildSanitizationReport({
      mode: 'selective',
      startedAt,
      completedAt,
      durationSeconds: 60,
      teardownResult: emptyTeardown,
      disksToWipe: [nvmeDisk],
      preservedDiskInfo: [],
      skippedDisks: [],
      requestedWipeCount: 2,
      allDiskNames: ['nvme0n1', 'sdb'],
      postTeardownDiskNames: ['nvme0n1'],
      validationResults: {
        nvme0n1: {
          method: 'sector_sampling',
          sample_count: 1000,
          sectors_checked: 1000,
          sectors_zeroed: 1000,
          sectors_failed: 0,
          sectors_unreadable: 0,
          result: 'pass',
        },
      },
      wipeMethods: { nvme0n1: 'NVMe Sanitize Block Erase (Purge)' },
      jobId: 'reprovision-partial-vanish',
      toolVersion: 'v',
    });

    expect(report.disks).toHaveLength(1);
    expect(report.disks[0]?.result).toBe('pass');
    expect(report.overall_result).toBe('fail');
    expect(report.skipped_disks).toContainEqual({
      name: 'sdb',
      reason: 'requested wipe target absent from post-teardown discovery — not sanitized',
    });
  });

  it('selective wipe stays pass when a preserved disk is absent from the wipe set (no false reconciliation)', () => {
    const report = buildSanitizationReport({
      mode: 'selective',
      startedAt,
      completedAt,
      durationSeconds: 60,
      teardownResult: emptyTeardown,
      disksToWipe: [nvmeDisk],
      preservedDiskInfo: [],
      skippedDisks: [],
      requestedWipeCount: 1,
      allDiskNames: ['nvme0n1', 'sdb'],
      postTeardownDiskNames: ['nvme0n1', 'sdb'],
      preserveDiskNames: ['sdb'],
      validationResults: {
        nvme0n1: {
          method: 'sector_sampling',
          sample_count: 1000,
          sectors_checked: 1000,
          sectors_zeroed: 1000,
          sectors_failed: 0,
          sectors_unreadable: 0,
          result: 'pass',
        },
      },
      wipeMethods: { nvme0n1: 'NVMe Sanitize Block Erase (Purge)' },
      jobId: 'reprovision-preserve',
      toolVersion: 'v',
    });

    expect(report.overall_result).toBe('pass');
    expect(report.skipped_disks).toEqual([]);
  });

  it('wipeErrors entries land on DiskReport.wipe_error', () => {
    const report = buildSanitizationReport({
      mode: 'full',
      startedAt,
      completedAt,
      durationSeconds: 5,
      teardownResult: emptyTeardown,
      disksToWipe: [nvmeDisk],
      preservedDiskInfo: [],
      skippedDisks: [],
      requestedWipeCount: 1,
      validationResults: {},
      wipeMethods: {},
      wipeErrors: {
        nvme0n1: {
          message: 'NVMe Sanitize command rejected by controller',
          stderr: 'nvme-cli: format: SANITIZE: Invalid Field in Command',
        },
      },
      jobId: 'fail-test',
      toolVersion: 'v',
    });

    expect(report.disks).toHaveLength(1);
    expect(report.disks[0]).toMatchObject({
      name: 'nvme0n1',
      sanitization_technique: 'unknown',
      result: 'fail',
      wipe_error: {
        message: 'NVMe Sanitize command rejected by controller',
        stderr: 'nvme-cli: format: SANITIZE: Invalid Field in Command',
      },
    });
    expect(report.overall_result).toBe('fail');
  });

  it('successful wipes carry wipe_error: null', () => {
    const report = buildSanitizationReport({
      mode: 'selective',
      startedAt,
      completedAt,
      durationSeconds: 60,
      teardownResult: emptyTeardown,
      disksToWipe: [nvmeDisk],
      preservedDiskInfo: [],
      skippedDisks: [],
      requestedWipeCount: 1,
      validationResults: {
        nvme0n1: {
          method: 'sector_sampling',
          sample_count: 1000,
          sectors_checked: 1000,
          sectors_zeroed: 1000,
          sectors_failed: 0,
          sectors_unreadable: 0,
          result: 'pass',
        },
      },
      wipeMethods: { nvme0n1: 'NVMe Sanitize Block Erase (Purge)' },
      jobId: 'pass-test',
      toolVersion: 'v',
    });

    expect(report.disks[0]?.wipe_error).toBeNull();
  });
});
