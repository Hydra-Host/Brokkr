import { describe, expect, it, vi } from 'vitest';
import type { BenchmarkService } from '../../../benchmarks/benchmarks.service';
import type { DiscoveryRunCompletedEvent } from '../../discovery.events';
import { DiscoveryBenchmarksListener } from '../discovery-benchmarks.listener';


const fakeLogger: any = { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

const makeCompleted = (overrides: Partial<DiscoveryRunCompletedEvent> = {}): DiscoveryRunCompletedEvent => ({
  runId: 'run-1',
  deviceId: 'dev-uuid-1',
  zonePrefix: 'tenant-1-site-2-loc-3',
  jobId: 'job-1',
  storageLayouts: null,
  rawBundle: {},
  collectorsApplied: [],
  collectorsSkipped: [],
  composersApplied: [],
  issueCount: 0,
  durationMs: 42,
  ...overrides,
});

describe('DiscoveryBenchmarksListener', () => {
  it('calls runBenchmarks with Device.id (UUID string, not netbox int)', async () => {
    const benchmarkService = {
      runBenchmarks: vi.fn().mockResolvedValue(undefined),
    } as unknown as BenchmarkService;
    const listener = new DiscoveryBenchmarksListener(benchmarkService, fakeLogger);

    await listener.onRunCompleted(makeCompleted());

    expect(benchmarkService.runBenchmarks).toHaveBeenCalledWith('dev-uuid-1');
  });

  it('swallows benchmark errors — discovery completion must not bubble up failures', async () => {
    const benchmarkService = {
      runBenchmarks: vi.fn().mockRejectedValue(new Error('bridge offline')),
    } as unknown as BenchmarkService;
    const listener = new DiscoveryBenchmarksListener(benchmarkService, fakeLogger);

    await expect(listener.onRunCompleted(makeCompleted())).resolves.toBeUndefined();
    expect(fakeLogger.error).toHaveBeenCalled();
  });
});
