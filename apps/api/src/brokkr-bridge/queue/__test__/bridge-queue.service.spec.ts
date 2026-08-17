import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BridgeQueueService } from '../bridge-queue.service';

function makeService() {
  const redisConfig = { host: 'localhost', port: 6379 };
  const sealedEnvelope = {
    isZoneEnrolled: vi.fn().mockResolvedValue(false),
    sealHubToBridge: vi.fn().mockResolvedValue({ envelope_v: 1, aad: {}, eph_pub: '', ciphertext: '', tag: '' }),
  };
  const logger = { log: vi.fn(), error: vi.fn(), warn: vi.fn() };
  const service = new BridgeQueueService(redisConfig as never, sealedEnvelope as never, logger as never);
  return { service, sealedEnvelope };
}

function makeExistingJob(state: string, data: unknown = { plan_id: 'plan-1', saga_name: 'deprovision' }) {
  return {
    id: 'dev-deprovision-plan-1',
    data,
    getState: vi.fn().mockResolvedValue(state),
    remove: vi.fn().mockResolvedValue(undefined),
  };
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
    add = vi.fn().mockResolvedValue({ id: 'added-job' });
    getJob = vi.fn();
    vi.spyOn(service, 'getLifecycleQueue').mockReturnValue({ getJob, add } as never);
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
