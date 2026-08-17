import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../exec', () => ({ run: vi.fn().mockResolvedValue({ stdout: '', stderr: '', exit_code: 0 }) }));
vi.mock('../validateWipe', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../validateWipe')>();
  return {
    ...actual,
    writeValidationMarkers: vi.fn().mockResolvedValue([{ sector: 100, marker: 'ab'.repeat(256) }]),
    validateWipe: vi.fn().mockResolvedValue({
      method: 'sector_sampling',
      sample_count: 1000,
      sectors_checked: 1,
      sectors_zeroed: 1,
      sectors_failed: 0,
      sectors_unreadable: 0,
      result: 'pass',
    }),
  };
});
vi.mock('../teardownHolders', () => ({
  findWipeTargetsSharingPreservedStack: vi.fn().mockResolvedValue([]),
}));

import { clearOperationsForTests, getHandler, registerOperation } from '../../../dispatch/registry';
import { run as execRun } from '../../../exec';
import { validateWipe, writeValidationMarkers } from '../validateWipe';
import { registerWipeDisks } from '../wipeDisks';

const runMock = vi.mocked(execRun);
const reportProgress = vi.fn();

const ctx = {
  work_id: 'test',
  job_id: 'test',
  signal: new AbortController().signal,
  resultDelivered: Promise.resolve(),
  reportProgress,
  emit: () => Promise.resolve(),
};

interface Blockdev {
  name: string;
  size: number;
  ro: boolean;
  rota: boolean;
  type: string;
  model: string | null;
  serial: string | null;
  tran: string | null;
}

function disk(name: string, rota = false): Blockdev {
  return { name, size: 1_000_000_000, ro: false, rota, type: 'disk', model: null, serial: null, tran: null };
}

const ALL_DISKS = [disk('nvme0n1'), disk('nvme1n1'), disk('sdb', true)];

interface WireOpts {
  resolvedLayouts?: Array<{ disks: string[]; size_bytes: number; wipe: boolean }>;
  discovered?: Blockdev[];
}

function wireSubOps(opts: WireOpts = {}): ReturnType<typeof vi.fn> {
  const wipeDiskSpy = vi.fn().mockResolvedValue({ method_used: 'NVMe Sanitize Block Erase (Purge)' });
  const fixed: Array<[string, unknown]> = [
    [
      'storage.resolveDisks',
      { layouts: opts.resolvedLayouts ?? [{ disks: ['nvme0n1'], size_bytes: 1_000, wipe: true }] },
    ],
    ['storage.unmountDisks', { unmounted_paths: [] }],
    [
      'storage.teardownHolders',
      {
        crypt_closed: [],
        lvm_removed: [],
        vg_removed: [],
        raid_stopped: [],
        swap_deactivated: [],
        signatures_cleared: [],
        skipped_preserved: [],
      },
    ],
    ['storage.discoverDisks', { blockdevices: opts.discovered ?? ALL_DISKS }],
    ['storage.detectRaidControllers', { disk_raid_status: {}, controllers: [] }],
    ['storage.clearGpt', { success: true }],
  ];
  for (const [name, response] of fixed) {
    registerOperation(name as never, (async () => response) as never);
  }
  registerOperation('storage.wipeDisk' as never, wipeDiskSpy as never);
  return wipeDiskSpy;
}

beforeEach(() => {
  clearOperationsForTests();
  reportProgress.mockReset();
  runMock.mockReset();
  runMock.mockResolvedValue({ stdout: '', stderr: '', exit_code: 0 } as never);
  vi.mocked(writeValidationMarkers).mockReset();
  vi.mocked(writeValidationMarkers).mockResolvedValue([{ sector: 100, marker: 'ab'.repeat(256) }]);
  vi.mocked(validateWipe).mockReset();
  vi.mocked(validateWipe).mockResolvedValue({
    method: 'sector_sampling',
    sample_count: 1000,
    sectors_checked: 1,
    sectors_zeroed: 1,
    sectors_failed: 0,
    sectors_unreadable: 0,
    result: 'pass',
  });
});

function roDisk(name: string, rota = false): Blockdev {
  return { ...disk(name, rota), ro: true };
}

interface SanitizationReport {
  mode: string;
  overall_result: string;
  disks: Array<{ name: string; result: string; sanitization_technique: string }>;
  skipped_disks: Array<{ name: string; reason: string }>;
}

async function run(input: unknown): Promise<{ sanitization_report: SanitizationReport }> {
  registerWipeDisks();
  const entry = getHandler('storage.wipeDisks');
  if (!entry) throw new Error('wipeDisks not registered');
  return entry.handler(input, ctx as never) as never;
}

describe('storage.wipeDisks — progress heartbeats', () => {
  it('reports preparation, wipe, validation, and completion progress', async () => {
    vi.useFakeTimers();
    try {
      let resolveWipe = (_value: { method_used: string }): void => {};
      const wipePending = new Promise<{ method_used: string }>((resolve) => {
        resolveWipe = resolve;
      });
      let resolveValidation = (_value: Awaited<ReturnType<typeof validateWipe>>): void => {};
      const validationPending = new Promise<Awaited<ReturnType<typeof validateWipe>>>((resolve) => {
        resolveValidation = resolve;
      });
      const wipeDiskSpy = wireSubOps();
      wipeDiskSpy.mockImplementation(() => wipePending);
      vi.mocked(validateWipe).mockImplementation(() => validationPending);

      const operation = run({
        disk_layouts: [],
        environment: 'production',
        full_wipe: true,
        job_id: 'progress-1',
      });
      await vi.advanceTimersByTimeAsync(0);

      expect(reportProgress.mock.calls.slice(0, 7)).toEqual([
        [0, 'starting'],
        [0.01, 'discovery complete'],
        [0.02, 'unmount complete'],
        [0.03, 'teardown complete'],
        [0.04, 'rediscovery complete'],
        [0.05, 'validation markers complete'],
        [0.06, 'RAID controller detection complete'],
      ]);

      await vi.advanceTimersByTimeAsync(30_000);
      expect(reportProgress).toHaveBeenCalledWith(0, 'wipe in progress');

      resolveWipe({ method_used: 'NVMe Sanitize Block Erase (Purge)' });
      await vi.advanceTimersByTimeAsync(0);
      expect(validateWipe).toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(30_000);
      expect(reportProgress).toHaveBeenCalledWith(0.9, 'validation in progress');

      resolveValidation({
        method: 'sector_sampling',
        sample_count: 1000,
        sectors_checked: 1,
        sectors_zeroed: 1,
        sectors_failed: 0,
        sectors_unreadable: 0,
        result: 'pass',
      });
      await operation;

      expect(reportProgress).toHaveBeenLastCalledWith(1, 'validation complete');
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('clears the wipe heartbeat when a disk wipe throws', async () => {
    vi.useFakeTimers();
    try {
      const wipeDiskSpy = wireSubOps();
      wipeDiskSpy.mockRejectedValue(new Error('wipe failed'));

      await run({
        disk_layouts: [],
        environment: 'production',
        full_wipe: true,
        job_id: 'progress-wipe-failure',
      });

      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('clears the validation heartbeat when validation throws', async () => {
    vi.useFakeTimers();
    try {
      wireSubOps();
      vi.mocked(validateWipe).mockRejectedValueOnce(new Error('validation failed'));

      await run({
        disk_layouts: [],
        environment: 'production',
        full_wipe: true,
        job_id: 'progress-validation-failure',
      });

      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});

describe('storage.wipeDisks — PROVISION full wipe scope', () => {
  it('full_wipe wipes EVERY physical disk even when a selective single-disk layout is present', async () => {
    const wipeDiskSpy = wireSubOps();

    const report = await run({
      disk_layouts: [{ disk: '/dev/nvme0n1', wipe: true }],
      environment: 'production',
      full_wipe: true,
      job_id: 'prov-1',
    });

    expect(report.sanitization_report.mode).toBe('full');
    const wiped = wipeDiskSpy.mock.calls.map((c) => (c[0] as { disk_name: string }).disk_name).sort();
    expect(wiped).toEqual(['nvme0n1', 'nvme1n1', 'sdb']);
  });

  it('without full_wipe a selective layout wipes ONLY the layout-named disk (reprovision semantics preserved)', async () => {
    const wipeDiskSpy = wireSubOps();

    const report = await run({
      disk_layouts: [{ disk: '/dev/nvme0n1', wipe: true }],
      environment: 'production',
      full_wipe: false,
      job_id: 'reprov-1',
    });

    expect(report.sanitization_report.mode).toBe('selective');
    const wiped = wipeDiskSpy.mock.calls.map((c) => (c[0] as { disk_name: string }).disk_name);
    expect(wiped).toEqual(['nvme0n1']);
  });
});

describe('storage.wipeDisks — full-mode unvalidated wipe (fail-OPEN guard)', () => {
  it('FAILS overall_result when a production full wipe certifies disks that were never validated', async () => {
    vi.mocked(writeValidationMarkers).mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    wireSubOps();

    const report = await run({
      disk_layouts: [],
      environment: 'production',
      full_wipe: true,
      job_id: 'prov-unvalidated',
    });

    expect(report.sanitization_report.mode).toBe('full');
    expect(report.sanitization_report.overall_result).toBe('fail');
    for (const d of report.sanitization_report.disks) {
      expect(d.result).toBe('fail');
    }
  });
});

describe('storage.wipeDisks — full-mode read-only skipped disk', () => {
  it('FAILS overall_result when a full-mode wipe leaves a read-only physical disk un-sanitized', async () => {
    wireSubOps({ discovered: [disk('nvme0n1'), roDisk('sdb', true)] });

    const report = await run({
      disk_layouts: [],
      environment: 'production',
      full_wipe: true,
      job_id: 'prov-ro-1',
    });

    expect(report.sanitization_report.mode).toBe('full');
    expect(report.sanitization_report.overall_result).toBe('fail');
    expect(report.sanitization_report.skipped_disks).toContainEqual({ name: 'sdb', reason: 'read-only device' });
  });

  it('PASSES a full-mode wipe when no disk is read-only (no regression)', async () => {
    wireSubOps({ discovered: [disk('nvme0n1'), disk('sdb', true)] });

    const report = await run({
      disk_layouts: [],
      environment: 'production',
      full_wipe: true,
      job_id: 'prov-ro-2',
    });

    expect(report.sanitization_report.overall_result).toBe('pass');
    expect(report.sanitization_report.skipped_disks).toEqual([]);
  });
});

describe('storage.wipeDisks — full-mode multi-namespace NVMe', () => {
  it('PASSES with two namespaces on the same controller (one controller-wide sanitize, sibling inherits method)', async () => {
    const wipeDiskSpy = vi.fn().mockResolvedValue({ method_used: 'NVMe Sanitize Crypto Erase (Purge)' });
    const fixed: Array<[string, unknown]> = [
      ['storage.resolveDisks', { layouts: [] }],
      ['storage.unmountDisks', { unmounted_paths: [] }],
      [
        'storage.teardownHolders',
        {
          crypt_closed: [],
          lvm_removed: [],
          vg_removed: [],
          raid_stopped: [],
          swap_deactivated: [],
          signatures_cleared: [],
          skipped_preserved: [],
        },
      ],
      ['storage.discoverDisks', { blockdevices: [disk('nvme0n1'), disk('nvme0n2')] }],
      ['storage.detectRaidControllers', { disk_raid_status: {}, controllers: [] }],
      ['storage.clearGpt', { success: true }],
    ];
    for (const [name, response] of fixed) registerOperation(name as never, (async () => response) as never);
    registerOperation('storage.wipeDisk' as never, wipeDiskSpy as never);

    const report = await run({
      disk_layouts: [],
      environment: 'production',
      full_wipe: true,
      job_id: 'prov-mns-1',
    });

    expect(report.sanitization_report.overall_result).toBe('pass');
    const wiped = wipeDiskSpy.mock.calls.map((c) => (c[0] as { disk_name: string }).disk_name);
    expect(wiped).toEqual(['nvme0n1']);
    const byName = Object.fromEntries(report.sanitization_report.disks.map((d) => [d.name, d]));
    expect(byName['nvme0n1']?.result).toBe('pass');
    expect(byName['nvme0n2']?.result).toBe('pass');
    expect(byName['nvme0n2']?.sanitization_technique).toBe('NVMe Sanitize Crypto Erase (Purge)');
  });

  it('waits out the inherited siblings restricted-read window (waitForReadReady) before validating it', async () => {
    vi.useFakeTimers();
    try {
      let sibingProbeAttempts = 0;
      runMock.mockImplementation((async (cmd: string, args: readonly string[] = []) => {
        if (cmd === 'dd' && args.some((a) => String(a).includes('nvme0n2'))) {
          sibingProbeAttempts += 1;
          return { stdout: '', stderr: '', exit_code: sibingProbeAttempts >= 2 ? 0 : 1 };
        }
        return { stdout: '', stderr: '', exit_code: 0 };
      }) as never);

      const wipeDiskSpy = vi.fn().mockResolvedValue({ method_used: 'NVMe Sanitize Crypto Erase (Purge)' });
      const fixed: Array<[string, unknown]> = [
        ['storage.resolveDisks', { layouts: [] }],
        ['storage.unmountDisks', { unmounted_paths: [] }],
        [
          'storage.teardownHolders',
          {
            crypt_closed: [],
            lvm_removed: [],
            vg_removed: [],
            raid_stopped: [],
            swap_deactivated: [],
            signatures_cleared: [],
            skipped_preserved: [],
          },
        ],
        ['storage.discoverDisks', { blockdevices: [disk('nvme0n1'), disk('nvme0n2')] }],
        ['storage.detectRaidControllers', { disk_raid_status: {}, controllers: [] }],
        ['storage.clearGpt', { success: true }],
      ];
      for (const [name, response] of fixed) registerOperation(name as never, (async () => response) as never);
      registerOperation('storage.wipeDisk' as never, wipeDiskSpy as never);

      const promise = run({ disk_layouts: [], environment: 'production', full_wipe: true, job_id: 'prov-rr-1' });
      await vi.runAllTimersAsync();
      const report = await promise;

      expect(sibingProbeAttempts).toBeGreaterThanOrEqual(2);
      expect(report.sanitization_report.overall_result).toBe('pass');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('storage.wipeDisks — full-mode multi-namespace NVMe namespace-scoped fallback', () => {
  it('wipes the sibling DIRECTLY (no inherit) when the primary fell back to a namespace-scoped method', async () => {
    const wipeDiskSpy = vi.fn().mockResolvedValue({ method_used: 'NVMe Format SES=2 Crypto Erase (Purge)' });
    const fixed: Array<[string, unknown]> = [
      ['storage.resolveDisks', { layouts: [] }],
      ['storage.unmountDisks', { unmounted_paths: [] }],
      [
        'storage.teardownHolders',
        {
          crypt_closed: [],
          lvm_removed: [],
          vg_removed: [],
          raid_stopped: [],
          swap_deactivated: [],
          signatures_cleared: [],
          skipped_preserved: [],
        },
      ],
      ['storage.discoverDisks', { blockdevices: [disk('nvme0n1'), disk('nvme0n2')] }],
      ['storage.detectRaidControllers', { disk_raid_status: {}, controllers: [] }],
      ['storage.clearGpt', { success: true }],
    ];
    for (const [name, response] of fixed) registerOperation(name as never, (async () => response) as never);
    registerOperation('storage.wipeDisk' as never, wipeDiskSpy as never);

    const report = await run({
      disk_layouts: [],
      environment: 'production',
      full_wipe: true,
      job_id: 'prov-mns-scoped-1',
    });

    const wiped = wipeDiskSpy.mock.calls.map((c) => (c[0] as { disk_name: string }).disk_name).sort();
    expect(wiped).toEqual(['nvme0n1', 'nvme0n2']);
    const byName = Object.fromEntries(report.sanitization_report.disks.map((d) => [d.name, d]));
    expect(byName['nvme0n2']?.sanitization_technique).toBe('NVMe Format SES=2 Crypto Erase (Purge)');
    expect(report.sanitization_report.overall_result).toBe('pass');
  });
});

describe('storage.wipeDisks — selective multi-namespace NVMe', () => {
  function wireMultiNs(opts: {
    resolvedLayouts: Array<{ disks: string[]; size_bytes: number; wipe: boolean }>;
    discovered: Blockdev[];
    methodUsed?: string;
  }): ReturnType<typeof vi.fn> {
    const wipeDiskSpy = vi
      .fn()
      .mockResolvedValue({ method_used: opts.methodUsed ?? 'NVMe Sanitize Crypto Erase (Purge)' });
    const fixed: Array<[string, unknown]> = [
      ['storage.resolveDisks', { layouts: opts.resolvedLayouts }],
      ['storage.unmountDisks', { unmounted_paths: [] }],
      [
        'storage.teardownHolders',
        {
          crypt_closed: [],
          lvm_removed: [],
          vg_removed: [],
          raid_stopped: [],
          swap_deactivated: [],
          signatures_cleared: [],
          skipped_preserved: [],
        },
      ],
      ['storage.discoverDisks', { blockdevices: opts.discovered }],
      ['storage.detectRaidControllers', { disk_raid_status: {}, controllers: [] }],
      ['storage.clearGpt', { success: true }],
    ];
    for (const [name, response] of fixed) registerOperation(name as never, (async () => response) as never);
    registerOperation('storage.wipeDisk' as never, wipeDiskSpy as never);
    return wipeDiskSpy;
  }

  it('dedups two same-controller wipe targets to ONE controller-wide sanitize (no concurrent-sanitize false-fail)', async () => {
    const wipeDiskSpy = wireMultiNs({
      resolvedLayouts: [{ disks: ['nvme0n1', 'nvme0n2'], size_bytes: 1_000, wipe: true }],
      discovered: [disk('nvme0n1'), disk('nvme0n2')],
    });

    const report = await run({
      disk_layouts: [
        { disk: '/dev/nvme0n1', wipe: true },
        { disk: '/dev/nvme0n2', wipe: true },
      ],
      environment: 'production',
      full_wipe: false,
      job_id: 'reprov-mns-1',
    });

    expect(report.sanitization_report.mode).toBe('selective');
    const wiped = wipeDiskSpy.mock.calls.map((c) => (c[0] as { disk_name: string }).disk_name);
    expect(wiped).toEqual(['nvme0n1']);
    expect(report.sanitization_report.overall_result).toBe('pass');
    const byName = Object.fromEntries(report.sanitization_report.disks.map((d) => [d.name, d]));
    expect(byName['nvme0n1']?.result).toBe('pass');
    expect(byName['nvme0n2']?.result).toBe('pass');
  });

  it('spares a NON-enumerated sibling namespace from controller-wide Sanitize', async () => {
    const wipeDiskSpy = wireMultiNs({
      resolvedLayouts: [{ disks: ['nvme0n1'], size_bytes: 1_000, wipe: true }],
      discovered: [disk('nvme0n1'), disk('nvme0n2')],
    });

    const report = await run({
      disk_layouts: [{ disk: '/dev/nvme0n1', wipe: true }],
      environment: 'production',
      full_wipe: false,
      job_id: 'reprov-mns-2',
    });

    const calls = wipeDiskSpy.mock.calls.map(
      (c) => c[0] as { disk_name: string; controller_has_preserved_sibling: boolean },
    );
    const n1 = calls.find((c) => c.disk_name === 'nvme0n1');
    expect(n1?.controller_has_preserved_sibling).toBe(true);
    expect(calls.some((c) => c.disk_name === 'nvme0n2')).toBe(false);
    expect(report.sanitization_report.mode).toBe('selective');
  });
});

describe('storage.wipeDisks — NVMe controller-sibling preserve guard', () => {
  it('flags controller_has_preserved_sibling on a wipe target whose controller owns a preserved namespace', async () => {
    const wipeDiskSpy = wireSubOps({
      resolvedLayouts: [
        { disks: ['nvme0n1'], size_bytes: 1_000, wipe: true },
        { disks: ['nvme0n2'], size_bytes: 1_000, wipe: false },
      ],
      discovered: [disk('nvme0n1'), disk('nvme0n2'), disk('nvme1n1')],
    });

    await run({
      disk_layouts: [
        { disk: '/dev/nvme0n1', wipe: true },
        { disk: '/dev/nvme0n2', wipe: false },
      ],
      environment: 'production',
      full_wipe: false,
      job_id: 'reprov-2',
    });

    const calls = wipeDiskSpy.mock.calls.map(
      (c) => c[0] as { disk_name: string; controller_has_preserved_sibling: boolean },
    );
    const n1 = calls.find((c) => c.disk_name === 'nvme0n1');
    expect(n1?.controller_has_preserved_sibling).toBe(true);
    expect(calls.some((c) => c.disk_name === 'nvme0n2')).toBe(false);
  });

  it('does NOT flag a wipe target on a controller with no preserved sibling', async () => {
    const wipeDiskSpy = wireSubOps({
      resolvedLayouts: [
        { disks: ['nvme0n1'], size_bytes: 1_000, wipe: true },
        { disks: ['nvme1n1'], size_bytes: 1_000, wipe: false },
      ],
      discovered: [disk('nvme0n1'), disk('nvme1n1')],
    });

    await run({
      disk_layouts: [
        { disk: '/dev/nvme0n1', wipe: true },
        { disk: '/dev/nvme1n1', wipe: false },
      ],
      environment: 'production',
      full_wipe: false,
      job_id: 'reprov-3',
    });

    const n1 = wipeDiskSpy.mock.calls
      .map((c) => c[0] as { disk_name: string; controller_has_preserved_sibling: boolean })
      .find((c) => c.disk_name === 'nvme0n1');
    expect(n1?.controller_has_preserved_sibling).toBe(false);
  });
});
