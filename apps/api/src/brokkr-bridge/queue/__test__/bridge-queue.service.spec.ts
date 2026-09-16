import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BridgeQueueService } from '../bridge-queue.service';

function makeService() {
  const redisConfig = { host: 'localhost', port: 6379 };
  const sealedEnvelope = {
    isZoneEnrolled: vi.fn().mockResolvedValue(false),
    sealHubToBridge: vi.fn().mockResolvedValue({ envelope_v: 1, aad: {}, eph_pub: '', ciphertext: '', tag: '' }),
  };
  const logger = { log: vi.fn(), error: vi.fn(), warn: vi.fn() };
  const jobLogWriter = { write: vi.fn() };
  const service = new BridgeQueueService(
    redisConfig as never,
    sealedEnvelope as never,
    logger as never,
    jobLogWriter as never,
  );
  return { service, sealedEnvelope, jobLogWriter };
}

function makeExistingJob(state: string, data: unknown = { plan_id: 'plan-1', saga_name: 'deprovision' }) {
  return {
    id: 'dev-deprovision-plan-1',
    data,
    getState: vi.fn().mockResolvedValue(state),
    remove: vi.fn().mockResolvedValue(undefined),
  };
}

function stubLifecycleQueue(service: BridgeQueueService) {
  const add = vi.fn().mockResolvedValue({ id: 'added-job' });
  const getJob = vi.fn();
  vi.spyOn(service, 'getLifecycleQueue').mockReturnValue({ getJob, add } as never);
  return { add, getJob };
}

describe('BridgeQueueService.enqueueSagaJob idempotency', () => {
  let service: BridgeQueueService;
  let sealedEnvelope: { isZoneEnrolled: ReturnType<typeof vi.fn>; sealHubToBridge: ReturnType<typeof vi.fn> };
  let add: ReturnType<typeof vi.fn>;
  let getJob: ReturnType<typeof vi.fn>;

  const enqueue = (opts?: { idempotent?: boolean }) =>
    service.enqueueSagaJob('zone-1', 'deprovision', 'plan-1', { device_id: 1 }, 'dev', opts);

  beforeEach(() => {
    ({ service, sealedEnvelope } = makeService());
    ({ add, getJob } = stubLifecycleQueue(service));
  });

  it('idempotent: returns an existing completed job without remove + re-add', async () => {
    const existing = makeExistingJob('completed');
    getJob.mockResolvedValue(existing);

    const result = await enqueue({ idempotent: true });

    expect(result).toBe(existing);
    expect(existing.remove).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
  });

  it('idempotent: returns an existing waiting job without remove + re-add', async () => {
    const existing = makeExistingJob('waiting');
    getJob.mockResolvedValue(existing);

    const result = await enqueue({ idempotent: true });

    expect(result).toBe(existing);
    expect(existing.remove).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
  });

  it('idempotent: re-adds a genuinely failed job (retry allowed)', async () => {
    const existing = makeExistingJob('failed');
    getJob.mockResolvedValue(existing);

    await enqueue({ idempotent: true });

    expect(existing.remove).toHaveBeenCalled();
    expect(add).toHaveBeenCalled();
  });

  it('default (non-idempotent): removes + re-adds a completed job', async () => {
    const existing = makeExistingJob('completed');
    getJob.mockResolvedValue(existing);

    await enqueue();

    expect(existing.remove).toHaveBeenCalled();
    expect(add).toHaveBeenCalled();
  });

  it('always skips when the existing job is active, regardless of idempotent', async () => {
    const existing = makeExistingJob('active');
    getJob.mockResolvedValue(existing);

    const result = await enqueue({ idempotent: true });

    expect(result).toBe(existing);
    expect(existing.remove).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
  });

  it('adds a fresh job when none exists', async () => {
    getJob.mockResolvedValue(undefined);

    await enqueue({ idempotent: true });

    expect(add).toHaveBeenCalled();
  });

  it('FAILS CLOSED for an enrolled zone when sealing throws (e.g. dormant hub key) — never enqueues plaintext', async () => {
    getJob.mockResolvedValue(undefined);
    sealedEnvelope.isZoneEnrolled.mockResolvedValue(true);
    sealedEnvelope.sealHubToBridge.mockRejectedValue(new Error('hub key dormant'));

    await expect(enqueue()).rejects.toThrow('hub key dormant');
    expect(add).not.toHaveBeenCalled();
  });

  it('does NOT remove the existing job when sealing throws — seal precedes remove, so the job survives for retry', async () => {
    const existing = makeExistingJob('failed');
    getJob.mockResolvedValue(existing);
    sealedEnvelope.isZoneEnrolled.mockResolvedValue(true);
    sealedEnvelope.sealHubToBridge.mockRejectedValue(new Error('hub key dormant'));

    await expect(enqueue({ idempotent: true })).rejects.toThrow('hub key dormant');
    expect(existing.remove).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
  });

  it('idempotent: re-seals a not-yet-started job whose format went stale (plaintext, zone now sealed)', async () => {
    const existing = makeExistingJob('waiting', { plan_id: 'plan-1', saga_name: 'deprovision' });
    getJob.mockResolvedValue(existing);
    sealedEnvelope.isZoneEnrolled.mockResolvedValue(true);

    await enqueue({ idempotent: true });

    expect(existing.remove).toHaveBeenCalled();
    expect(add).toHaveBeenCalled();
  });

  it('idempotent: leaves a COMPLETED job untouched even when format is stale (no duplicate work)', async () => {
    const existing = makeExistingJob('completed', { plan_id: 'plan-1', saga_name: 'deprovision' });
    getJob.mockResolvedValue(existing);
    sealedEnvelope.isZoneEnrolled.mockResolvedValue(true);

    const result = await enqueue({ idempotent: true });

    expect(result).toBe(existing);
    expect(existing.remove).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
  });

  it('idempotent: keeps a waiting job whose format already matches (sealed, zone sealed)', async () => {
    const existing = makeExistingJob('waiting', { envelope_v: 1, aad: {}, eph_pub: '', ciphertext: '', tag: '' });
    getJob.mockResolvedValue(existing);
    sealedEnvelope.isZoneEnrolled.mockResolvedValue(true);

    const result = await enqueue({ idempotent: true });

    expect(result).toBe(existing);
    expect(existing.remove).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
  });
});

describe('BridgeQueueService.hasActiveSagaJob', () => {
  let service: BridgeQueueService;
  let getJob: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    ({ service } = makeService());
    ({ getJob } = stubLifecycleQueue(service));
  });

  it('is true when the job is active', async () => {
    getJob.mockResolvedValue(makeExistingJob('active'));

    await expect(service.hasActiveSagaJob('zone-1', 'inventory-cron-dev')).resolves.toBe(true);
    expect(getJob).toHaveBeenCalledWith('inventory-cron-dev');
  });

  it('is false when the job exists but is not active', async () => {
    getJob.mockResolvedValue(makeExistingJob('waiting'));

    await expect(service.hasActiveSagaJob('zone-1', 'inventory-cron-dev')).resolves.toBe(false);
  });

  it('is false when the job is absent', async () => {
    getJob.mockResolvedValue(undefined);

    await expect(service.hasActiveSagaJob('zone-1', 'inventory-cron-dev')).resolves.toBe(false);
  });
});

describe('BridgeQueueService.enqueueSagaJobOrCoalesce', () => {
  let service: BridgeQueueService;
  let jobLogWriter: { write: ReturnType<typeof vi.fn> };
  let add: ReturnType<typeof vi.fn>;
  let getJob: ReturnType<typeof vi.fn>;

  const enqueue = (opts?: { idempotent?: boolean; coalesceKey?: string }) =>
    service.enqueueSagaJobOrCoalesce('zone-1', 'inventory_collection', 'plan-1', { device_id: 1 }, 'dev', opts);

  beforeEach(() => {
    ({ service, jobLogWriter } = makeService());
    ({ add, getJob } = stubLifecycleQueue(service));
  });

  it('reports coalesced when the existing job is active', async () => {
    const existing = makeExistingJob('active');
    getJob.mockResolvedValue(existing);

    const result = await enqueue({ coalesceKey: 'inventory-cron-dev' });

    expect(result).toEqual({ job: existing, coalesced: true });
    expect(getJob).toHaveBeenCalledWith('inventory-cron-dev');
    expect(add).not.toHaveBeenCalled();
  });

  it('reports coalesced when an idempotent enqueue returns the existing job', async () => {
    const existing = makeExistingJob('waiting');
    getJob.mockResolvedValue(existing);

    const result = await enqueue({ idempotent: true });

    expect(result).toEqual({ job: existing, coalesced: true });
    expect(add).not.toHaveBeenCalled();
  });

  it('reports a fresh enqueue as not coalesced', async () => {
    getJob.mockResolvedValue(undefined);

    const result = await enqueue({ coalesceKey: 'inventory-cron-dev' });

    expect(result).toEqual({ job: { id: 'added-job' }, coalesced: false });
    expect(add).toHaveBeenCalledOnce();
  });

  it('hands the saga name to the job-log writer so suppression can key on it', async () => {
    getJob.mockResolvedValue(undefined);

    await enqueue({ coalesceKey: 'inventory-cron-dev' });

    expect(jobLogWriter.write).toHaveBeenCalledExactlyOnceWith(
      'zone-1',
      'plan-1',
      'info',
      'Enqueued saga inventory_collection for device dev',
      'BridgeQueueService',
      'inventory_collection',
    );
  });

  it('replaces a waiting job under the coalesce key and reports it as not coalesced', async () => {
    const existing = makeExistingJob('waiting');
    getJob.mockResolvedValue(existing);

    const result = await enqueue({ coalesceKey: 'inventory-cron-dev' });

    expect(result).toEqual({ job: { id: 'added-job' }, coalesced: false });
    expect(existing.remove).toHaveBeenCalledOnce();
    expect(add).toHaveBeenCalledWith(
      expect.any(String),
      expect.anything(),
      expect.objectContaining({ jobId: 'inventory-cron-dev' }),
    );
  });
});
