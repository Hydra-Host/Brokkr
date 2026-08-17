import { describe, expect, it, vi } from 'vitest';
import type { QualifyOrchestrationService } from '../../../lifecycle/qualify-orchestration.service';
import type { DiscoveryRunCompletedEvent, DiscoveryRunFailedEvent } from '../../discovery.events';
import { DiscoveryQualifyListener } from '../discovery-qualify.listener';


const fakeLogger: any = { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

const makeCompleted = (overrides: Partial<DiscoveryRunCompletedEvent> = {}): DiscoveryRunCompletedEvent => ({
  runId: 'run-1',
  deviceId: 'dev-uuid-1',
  zonePrefix: 'tenant-1-site-2-loc-3',
  jobId: 'job-1',
  storageLayouts: { configs: [] },
  rawBundle: {},
  collectorsApplied: [],
  collectorsSkipped: [],
  composersApplied: [],
  issueCount: 0,
  durationMs: 42,
  ...overrides,
});

const makeFailed = (overrides: Partial<DiscoveryRunFailedEvent> = {}): DiscoveryRunFailedEvent => ({
  runId: 'run-1',
  deviceId: 'dev-uuid-1',
  jobId: 'job-1',
  phase: 'handler',
  error: 'boom',
  ...overrides,
});

describe('DiscoveryQualifyListener', () => {
  it('forwards RunCompleted to handleDiscoveryCompleteForCommission with Device.id (UUID) + zonePrefix + jobId + storageLayouts', async () => {
    const qualify = {
      handleDiscoveryCompleteForCommission: vi.fn().mockResolvedValue(undefined),
      handleQualifyFailure: vi.fn().mockResolvedValue(undefined),
    } as unknown as QualifyOrchestrationService;
    const listener = new DiscoveryQualifyListener(qualify, fakeLogger);

    await listener.onRunCompleted(makeCompleted());

    expect(qualify.handleDiscoveryCompleteForCommission).toHaveBeenCalledWith(
      'dev-uuid-1',
      'tenant-1-site-2-loc-3',
      'job-1',
      { configs: [] },
    );
  });

  it('swallows qualify errors on RunCompleted (logs but does not throw)', async () => {
    const qualify = {
      handleDiscoveryCompleteForCommission: vi.fn().mockRejectedValue(new Error('db down')),
      handleQualifyFailure: vi.fn(),
    } as unknown as QualifyOrchestrationService;
    const listener = new DiscoveryQualifyListener(qualify, fakeLogger);

    await expect(listener.onRunCompleted(makeCompleted())).resolves.toBeUndefined();
    expect(fakeLogger.error).toHaveBeenCalled();
  });

  it('forwards RunFailed to handleDiscoveryRunFailure with Device.id (UUID) + phase + error', async () => {
    const qualify = {
      handleDiscoveryCompleteForCommission: vi.fn(),
      handleDiscoveryRunFailure: vi.fn().mockResolvedValue(undefined),
    } as unknown as QualifyOrchestrationService;
    const listener = new DiscoveryQualifyListener(qualify, fakeLogger);

    await listener.onRunFailed(makeFailed({ phase: 'commit', error: 'tx deadlock' }));

    expect(qualify.handleDiscoveryRunFailure).toHaveBeenCalledWith(
      'dev-uuid-1',
      expect.stringMatching(/phase=commit.*tx deadlock/),
    );
  });

  it('swallows handleDiscoveryRunFailure errors', async () => {
    const qualify = {
      handleDiscoveryCompleteForCommission: vi.fn(),
      handleDiscoveryRunFailure: vi.fn().mockRejectedValue(new Error('secondary')),
    } as unknown as QualifyOrchestrationService;
    const listener = new DiscoveryQualifyListener(qualify, fakeLogger);

    await expect(listener.onRunFailed(makeFailed())).resolves.toBeUndefined();
  });
});
