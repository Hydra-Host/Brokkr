import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execFileMock = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => ({ stdout: '', stderr: '' })));

vi.mock('node:child_process', async (orig) => {
  const actual = await orig<typeof import('node:child_process')>();
  const { promisify } = await import('node:util');
  const execFile = (...args: unknown[]) => execFileMock(...args);
  Object.defineProperty(execFile, promisify.custom, { value: execFileMock, configurable: true });
  return { ...actual, execFile };
});

vi.mock('node:fs', async (orig) => ({
  ...(await orig<typeof import('node:fs')>()),
  readdirSync: () => [],
  readFileSync: () => '',
  statSync: () => ({ mtimeMs: 0 }),
}));

vi.mock('../common/build-info', () => ({
  ccBuildInfo: vi.fn(async () => ({ sha: 'aaa', builtAt: 1, headSha: 'bbb', stale: true })),
}));

import type { Status } from '../contract';
import { StatusService } from './status.service';

const makeService = (
  machines: () => Promise<unknown>,
  deps: {
    prober?: { probe: (target: string) => Promise<unknown> };
    runs?: { list: (filter: unknown) => unknown[] };
    initTasks?: { summary: () => unknown };
    labBridges?: () => { proc: string; zone: string; replica: number; port: number; grpc: number }[];
    devicesStatusByName?: () => Promise<Map<string, { lifecycleStatus: string; id: string; gpuModel: string | null }>>;
    fleetStatus?: { status: (machines?: unknown) => Promise<unknown> };
  } = {},
) =>
  new StatusService(
    { list: () => Promise.resolve([]) } as never,
    {
      stackSummary: () => ({ counts: {}, lifecycleWorkerConcurrency: 0 }),
      labBridges: deps.labBridges ?? (() => []),
    } as never,
    { repoPath: () => undefined } as never,
    { machines } as never,
    {
      probe: () => Promise.resolve(false),
      devicesStatusByName: deps.devicesStatusByName ?? (() => Promise.resolve(new Map())),
    } as never,
    { probe: () => Promise.resolve(false) } as never,
    (deps.prober ?? { probe: () => Promise.reject(new Error('probe unavailable')) }) as never,
    (deps.runs ?? { list: () => [] }) as never,
    (deps.initTasks ?? { summary: () => undefined }) as never,
    (deps.fleetStatus ?? { status: () => Promise.resolve(undefined) }) as never,
  );

const probeOk = { target: 'http://x', ok: true, statusCode: 200, latencyMs: 5, detail: null };

const ledgerRun = { runId: 'r1', section: 'test', opId: 'vitest', label: 'vitest e2e', status: 'passed' };

const stalenessProto = StatusService.prototype as unknown as {
  computeDistStaleness: () => Promise<{ distBuiltAt: number | null; stale: boolean }>;
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('StatusService.overview — fleet failure handling', () => {
  it('propagates a fleet-config-invalid error instead of rendering an empty fleet', async () => {
    const svc = makeService(() => Promise.reject(new Error("fleet config invalid: node 'gpu-1': data_mac: Required")));
    await expect(svc.overview()).rejects.toThrow(/fleet config invalid/);
  });

  it('degrades to an empty fleet for a transient machine-probe failure', async () => {
    const svc = makeService(() => Promise.reject(new Error('libvirt unreachable')));
    const result = await svc.overview();
    expect(result.fleet).toEqual([]);
  });
});

describe('StatusService.overview — fleet bring-up health', () => {
  const composed = {
    health: 'coming-up',
    phase: 'init',
    step: 'build-ipxe',
    label: 'building per-VM iPXE binary for cpu-3',
    node: 'cpu-3',
    index: 3,
    total: 4,
    stepOrdinal: 4,
    stepCount: 9,
    elapsedSec: 72,
    machinesExpected: 4,
    machinesRunning: 0,
    detail: 'building per-VM iPXE binary for cpu-3',
  };

  it('carries the composed fleet status on fleetHealth', async () => {
    const svc = makeService(() => Promise.resolve([]), {
      fleetStatus: { status: () => Promise.resolve(composed) },
    });

    expect((await svc.overview()).fleetHealth).toEqual(composed);
  });

  it('omits fleetHealth when the composition fails rather than failing the poll', async () => {
    const svc = makeService(() => Promise.resolve([]), {
      fleetStatus: { status: () => Promise.reject(new Error('process-compose socket gone')) },
    });

    const result = await svc.overview();

    expect(result.fleetHealth).toBeUndefined();
    expect(result.fleet).toEqual([]);
  });

  it('probes libvirt once and hands that snapshot to the fleet status composer', async () => {
    const machines = [{ name: 'cpu-1', power: 'on', configured: true, deviceId: null }];
    let probes = 0;
    const seen: unknown[] = [];
    const svc = makeService(
      () => {
        probes += 1;
        return Promise.resolve(machines);
      },
      {
        fleetStatus: {
          status: (passed?: unknown) => {
            seen.push(passed);
            return Promise.resolve(composed);
          },
        },
      },
    );

    await svc.overview();

    expect(probes).toBe(1);
    expect(seen).toEqual([machines]);
  });
});

describe('StatusService.overview — dist staleness caching', () => {
  it('walks the src tree once per TTL across repeated overview() calls', async () => {
    const load = vi.spyOn(stalenessProto, 'computeDistStaleness').mockResolvedValue({ distBuiltAt: 123, stale: true });
    const svc = makeService(() => Promise.resolve([]));
    const first = await svc.overview();
    const second = await svc.overview();
    expect(load).toHaveBeenCalledTimes(1);
    expect(first.app).toMatchObject({ distBuiltAt: 123, stale: true });
    expect(second.app).toMatchObject({ distBuiltAt: 123, stale: true });
  });

  it('degrades a failed staleness load to fresh', async () => {
    vi.spyOn(stalenessProto, 'computeDistStaleness').mockRejectedValue(new Error('dist missing'));
    const svc = makeService(() => Promise.resolve([]));
    const result = await svc.overview();
    expect(result.app.distBuiltAt).toBeNull();
    expect(result.app.stale).toBe(false);
  });

  it('carries the ccBuild skew state on the app section', async () => {
    const svc = makeService(() => Promise.resolve([]));
    const status = await svc.overview();
    expect(status.app.ccBuild).toEqual({ sha: 'aaa', builtAt: 1, headSha: 'bbb', stale: true });
  });
});

describe('StatusService.overview — dashboard snapshot fields', () => {
  it('rolls the fleet up into fleetSummary', async () => {
    const svc = makeService(
      () =>
        Promise.resolve([
          { name: 'n1', power: 'on' },
          { name: 'n2', power: 'off' },
          { name: 'n3', power: 'unknown' },
        ]),
      {
        devicesStatusByName: () =>
          Promise.resolve(new Map([['n1', { lifecycleStatus: 'provisioning', id: 'd1', gpuModel: null }]])),
      },
    );

    const status = await svc.overview();

    expect(status.fleetSummary).toEqual({ total: 3, on: 1, off: 1, unknown: 1, byLifecycle: { provisioning: 1 } });
  });

  it('carries the hub and per-bridge spoke probe results', async () => {
    const svc = makeService(() => Promise.resolve([]), {
      prober: { probe: (target: string) => Promise.resolve({ ...probeOk, target }) },
      labBridges: () => [
        { proc: 'spoke', zone: 'z1', replica: 0, port: 8000, grpc: 9082 },
        { proc: 'spoke-2', zone: 'z2', replica: 1, port: 8001, grpc: 9083 },
      ],
    });

    const status = await svc.overview();

    expect(status.hubHealth).toMatchObject({ ok: true, target: expect.stringContaining('/healthcheck') });
    expect(status.spokeHealth?.map((p) => p.target)).toEqual([
      'http://127.0.0.1:8000/api/health',
      'http://127.0.0.1:8001/api/health',
    ]);
  });

  it('omits the probe fields when the probe batch fails', async () => {
    const svc = makeService(() => Promise.resolve([]), {
      prober: { probe: () => Promise.reject(new Error('socket hang up')) },
    });

    const status = await svc.overview();

    expect(status.hubHealth).toBeUndefined();
    expect(status.spokeHealth).toBeUndefined();
  });

  it('carries the recent runs and the newest test run from the ledger', async () => {
    const svc = makeService(() => Promise.resolve([]), {
      runs: {
        list: (filter: unknown) => {
          const f = filter as { section?: string };
          return f.section === 'test' ? [ledgerRun] : [ledgerRun, { ...ledgerRun, runId: 'r2', section: 'stack' }];
        },
      },
    });

    const status = await svc.overview();

    expect(status.recentRuns).toHaveLength(2);
    expect(status.lastTestRun).toMatchObject({ runId: 'r1' });
  });

  it('omits the run fields when the ledger read throws', async () => {
    const svc = makeService(() => Promise.resolve([]), {
      runs: {
        list: () => {
          throw new Error('sqlite locked');
        },
      },
    });

    const status = await svc.overview();

    expect(status.recentRuns).toBeUndefined();
    expect(status.lastTestRun).toBeUndefined();
  });

  it('carries the init summary and omits it when the roster read throws', async () => {
    const summary = { state: 'running', total: 10, completed: 4, failed: 0, current: 'Sim seed' };
    const ok = makeService(() => Promise.resolve([]), { initTasks: { summary: () => summary } });
    const bad = makeService(() => Promise.resolve([]), {
      initTasks: {
        summary: () => {
          throw new Error('log dir gone');
        },
      },
    });

    expect((await ok.overview()).initStatus).toEqual(summary);
    expect((await bad.overview()).initStatus).toBeUndefined();
  });
});

describe('StatusService.overview — probe hysteresis', () => {
  const PROBE_TTL_MS = 10_000;

  const proberYielding = (oks: boolean[]) => {
    let round = 0;
    return {
      probe: (target: string) => {
        const ok = oks[Math.min(round, oks.length - 1)];
        round += 1;
        return Promise.resolve({ ...probeOk, target, ok, latencyMs: ok ? 5 : null, detail: ok ? null : 'timeout' });
      },
    };
  };

  const overviewsOverTime = async (oks: boolean[]) => {
    const svc = makeService(() => Promise.resolve([]), { prober: proberYielding(oks) });
    const statuses: Status[] = [];
    for (let i = 0; i < oks.length; i += 1) {
      vi.setSystemTime(Date.now() + PROBE_TTL_MS + 1);
      statuses.push(await svc.overview());
    }
    return statuses;
  };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps the last good round when a single round fails', async () => {
    const [first, second] = await overviewsOverTime([true, false]);

    expect(first.hubHealth).toMatchObject({ ok: true, latencyMs: 5 });
    expect(second.hubHealth).toMatchObject({ ok: true, latencyMs: 5 });
  });

  it('reports down once two consecutive rounds fail', async () => {
    const [, , third] = await overviewsOverTime([true, false, false]);

    expect(third.hubHealth).toMatchObject({ ok: false, detail: 'timeout' });
  });

  it('resets the failure streak on a successful round', async () => {
    const statuses = await overviewsOverTime([true, false, true, false]);

    expect(statuses.map((s) => s.hubHealth?.ok)).toEqual([true, true, true, true]);
  });

  it('reports down on the first round when there is no last good result', async () => {
    const [first] = await overviewsOverTime([false]);

    expect(first.hubHealth).toMatchObject({ ok: false });
  });
});
