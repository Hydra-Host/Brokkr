import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { QueueRef } from '../../contract';

const h = vi.hoisted(() => {
  const holder = {
    redis: null as unknown as ScriptedRedis,
    queue: null as unknown as ScriptedQueue,
  };
  const RedisCtor = vi.fn(function () {
    return holder.redis;
  });
  const QueueCtor = vi.fn(function () {
    return holder.queue;
  });
  return { holder, RedisCtor, QueueCtor };
});

vi.mock('ioredis', () => ({ default: h.RedisCtor }));
vi.mock('bullmq', async (importOriginal) => ({
  ...(await importOriginal<typeof import('bullmq')>()),
  Queue: h.QueueCtor,
}));

import { RedisConnectionsService } from '../../datastore/redis-connections.service';
import { QueueJobsService } from '../queue-jobs.service';
import { QueueReaderService } from '../queue-reader.service';

class ScriptedRedis {
  on = vi.fn();
  disconnect = vi.fn();
  scan = vi.fn();
  exists = vi.fn(() => Promise.resolve(1));
  scard = vi.fn();
  keys = vi.fn();
}

class ScriptedQueue {
  getJobs = vi.fn();
  getJob = vi.fn();
  close = vi.fn(() => Promise.resolve());
}

const DEVICE = '11111111-2222-3333-4444-555555555555';
const PLAN = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const ZONE = '77777777-6666-5555-4444-333333333333';
const JOB_ID = `${DEVICE}-provision-${PLAN}`;

const sagaRef: QueueRef = { prefix: 'zone-a', name: 'lifecycle', kind: 'saga' };
const resultsRef: QueueRef = { prefix: 'results', name: 'inbox', kind: 'results' };

const DEPLOYMENT_OS_TOKEN = 'brokkr_dos_notarealtokenvalue';
const CIPHERTEXT = 'bm90LWEtcmVhbC1jaXBoZXJ0ZXh0';

function scriptedJob(over: Record<string, unknown> = {}) {
  return {
    id: JOB_ID,
    name: 'saga.run',
    data: { saga_name: 'provision', device_id: DEVICE },
    attemptsMade: 0,
    timestamp: 1_700_000_000_000,
    processedOn: undefined,
    finishedOn: undefined,
    delay: 0,
    failedReason: '',
    stacktrace: [],
    getState: vi.fn(() => Promise.resolve('waiting')),
    ...over,
  };
}

function sealedJob(over: Record<string, unknown> = {}) {
  return scriptedJob({
    data: {
      envelope_v: 1,
      aad: {
        aad_v: 1,
        zone_id: 'zone-sealed',
        queue_name: 'lifecycle',
        direction: 'hub_to_bridge',
        job_id: JOB_ID,
        created_at: 1_700_000_000_001,
      },
      eph_pub: 'ZXBoLXB1Yg==',
      ciphertext: CIPHERTEXT,
      tag: 'dGFn',
    },
    ...over,
  });
}

function makeService(ref: QueueRef | null) {
  const reader = new QueueReaderService(
    { listZoneIds: vi.fn(() => Promise.resolve([])) } as never,
    new RedisConnectionsService(),
  );
  const registry = { resolve: vi.fn(() => Promise.resolve(ref)) };
  return { service: new QueueJobsService(registry as never, reader), registry };
}

const listOptions = { states: [], limit: 50, offset: 0, deviceId: null };

beforeEach(() => {
  h.holder.redis = new ScriptedRedis();
  h.holder.queue = new ScriptedQueue();
  h.RedisCtor.mockClear();
  h.QueueCtor.mockClear();
});

describe('QueueJobsService — allowlist gate', () => {
  it('returns null for a ref the registry does not resolve and constructs no Queue', async () => {
    const { service, registry } = makeService(null);

    await expect(service.list('bogus', 'lifecycle', listOptions)).resolves.toBeNull();
    await expect(service.get('bogus', 'lifecycle', JOB_ID)).resolves.toBeNull();
    expect(registry.resolve).toHaveBeenCalledWith('bogus', 'lifecycle');
    expect(h.QueueCtor).not.toHaveBeenCalled();
  });

  it('returns null when the ref resolves but the queue vanished before the read', async () => {
    h.holder.redis.exists.mockResolvedValue(0);
    const { service } = makeService(sagaRef);

    await expect(service.list('zone-a', 'lifecycle', listOptions)).resolves.toBeNull();
    expect(h.QueueCtor).not.toHaveBeenCalled();
  });

  it('returns null for an absent job id', async () => {
    h.holder.queue.getJob.mockResolvedValue(null);
    const { service } = makeService(sagaRef);

    await expect(service.get('zone-a', 'lifecycle', JOB_ID)).resolves.toBeNull();
    expect(h.holder.queue.getJob).toHaveBeenCalledWith(JOB_ID);
  });
});

describe('QueueJobsService — reserved job ids', () => {
  it('refuses the meta hash rather than reading the queue metadata back as a job', async () => {
    h.holder.queue.getJob.mockResolvedValue(scriptedJob({ id: 'meta' }));
    const { service } = makeService(sagaRef);

    await expect(service.get('zone-a', 'lifecycle', 'meta')).resolves.toBeNull();
    expect(h.holder.queue.getJob).not.toHaveBeenCalled();
  });

  it('refuses a state list, a state zset, and the stalled set', async () => {
    const { service } = makeService(sagaRef);

    for (const jobId of ['wait', 'active', 'paused', 'delayed', 'completed', 'failed', 'prioritized', 'stalled']) {
      await expect(service.get('zone-a', 'lifecycle', jobId), jobId).resolves.toBeNull();
    }
    expect(h.holder.queue.getJob).not.toHaveBeenCalled();
  });

  it('refuses the remaining bullmq bookkeeping keys', async () => {
    const { service } = makeService(sagaRef);

    for (const jobId of ['id', 'events', 'marker', 'pc', 'de', 'limiter', 'repeat', 'stalled-check']) {
      await expect(service.get('zone-a', 'lifecycle', jobId), jobId).resolves.toBeNull();
    }
    expect(h.holder.queue.getJob).not.toHaveBeenCalled();
  });

  it('refuses an empty id and one that reaches a per-job side key', async () => {
    const { service } = makeService(sagaRef);

    for (const jobId of ['', `${JOB_ID}:logs`, `${JOB_ID}:dependencies`, 'meta:x']) {
      await expect(service.get('zone-a', 'lifecycle', jobId), jobId).resolves.toBeNull();
    }
    expect(h.holder.queue.getJob).not.toHaveBeenCalled();
  });

  it('refuses the per-job side keys that are hashes and would fabricate a job', async () => {
    const { service } = makeService(sagaRef);

    for (const jobId of [`${JOB_ID}:processed`, `${JOB_ID}:failed`, `${JOB_ID}:unsuccessful`, `${JOB_ID}:lock`]) {
      await expect(service.get('zone-a', 'lifecycle', jobId), jobId).resolves.toBeNull();
    }
    expect(h.holder.queue.getJob).not.toHaveBeenCalled();
  });

  it('refuses a job scheduler hash and the queue metrics hashes', async () => {
    const { service } = makeService(sagaRef);

    for (const jobId of ['repeat:device-data-reconcile-sweep', 'metrics:completed', 'metrics:failed', 'de:dedup-key']) {
      await expect(service.get('zone-a', 'lifecycle', jobId), jobId).resolves.toBeNull();
    }
    expect(h.holder.queue.getJob).not.toHaveBeenCalled();
  });

  it('serves a repeatable job, whose bullmq id carries key separators and a dotted repeat key', async () => {
    const { service } = makeService(sagaRef);
    h.holder.queue.getJob.mockImplementation((id: string) => Promise.resolve(scriptedJob({ id })));

    for (const jobId of [
      'repeat:device-data-reconcile-sweep:1785955080000',
      'repeat:lifecycle-stuck-sweep.sweep:1785955200000',
    ]) {
      await expect(service.get('bull', 'lifecycle-stuck-sweep', jobId), jobId).resolves.toMatchObject({ id: jobId });
      expect(h.holder.queue.getJob).toHaveBeenCalledWith(jobId);
    }
  });

  it('refuses a repeatable job side key rather than the repeatable job itself', async () => {
    const { service } = makeService(sagaRef);

    await expect(service.get('zone-a', 'lifecycle', 'repeat:sweep:1785955080000:logs')).resolves.toBeNull();
    expect(h.holder.queue.getJob).not.toHaveBeenCalled();
  });

  it('still serves a job id that merely contains a reserved word', async () => {
    h.holder.queue.getJob.mockResolvedValue(scriptedJob({ id: 'metadata-collect' }));
    const { service } = makeService(sagaRef);

    await expect(service.get('zone-a', 'lifecycle', 'metadata-collect')).resolves.toMatchObject({
      id: 'metadata-collect',
    });
  });
});

describe('QueueJobsService — job projection', () => {
  it('derives device, saga, and plan from the job id and normalizes waiting to wait', async () => {
    h.holder.queue.getJobs.mockResolvedValueOnce([scriptedJob()]).mockResolvedValue([]);
    const { service } = makeService(sagaRef);
    const page = await service.list('zone-a', 'lifecycle', listOptions);

    expect(page?.jobs[0]).toMatchObject({
      id: JOB_ID,
      name: 'saga.run',
      state: 'wait',
      deviceId: DEVICE,
      sagaName: 'provision',
      planId: PLAN,
      sealed: false,
    });
  });

  it('projects timing, attempts, and failure detail with absent fields as null', async () => {
    h.holder.queue.getJobs
      .mockResolvedValueOnce([
        scriptedJob({
          attemptsMade: 3,
          processedOn: 1_700_000_000_500,
          finishedOn: 1_700_000_001_000,
          failedReason: 'ipmi timeout',
          delay: 0,
        }),
      ])
      .mockResolvedValue([]);
    const { service } = makeService(sagaRef);
    const page = await service.list('zone-a', 'lifecycle', { ...listOptions, states: ['failed'] });

    expect(page?.jobs[0]).toMatchObject({
      state: 'failed',
      attemptsMade: 3,
      timestamp: 1_700_000_000_000,
      processedOn: 1_700_000_000_500,
      finishedOn: 1_700_000_001_000,
      failedReason: 'ipmi timeout',
    });
  });

  it('keeps a re-delayed job at its unchanged attempt count', async () => {
    h.holder.queue.getJobs.mockResolvedValueOnce([scriptedJob({ attemptsMade: 0, delay: 30_000 })]);
    const { service } = makeService(sagaRef);
    const page = await service.list('zone-a', 'lifecycle', { ...listOptions, states: ['delayed'] });

    expect(page?.jobs[0]).toMatchObject({ state: 'delayed', attemptsMade: 0, delay: 30_000, failedReason: null });
  });

  it('reports a non-saga job id without inventing a device', async () => {
    h.holder.queue.getJobs
      .mockResolvedValueOnce([scriptedJob({ id: 'device-status-effects-42' })])
      .mockResolvedValue([]);
    const { service } = makeService(sagaRef);
    const page = await service.list('zone-a', 'lifecycle', listOptions);

    expect(page?.jobs[0]).toMatchObject({ deviceId: null, sagaName: null, planId: null });
  });

  it('reports no device for a zone-scoped saga whose leading uuid is the queue prefix', async () => {
    const zoneRef: QueueRef = { prefix: ZONE, name: 'lifecycle', kind: 'saga' };
    h.holder.queue.getJob.mockResolvedValue(scriptedJob({ id: `${ZONE}-network_scan-${PLAN}` }));
    const { service } = makeService(zoneRef);

    await expect(service.get(ZONE, 'lifecycle', `${ZONE}-network_scan-${PLAN}`)).resolves.toMatchObject({
      deviceId: null,
      sagaName: 'network_scan',
      planId: PLAN,
    });
  });

  it('keeps the device for an id whose leading uuid is not the queue prefix', async () => {
    const zoneRef: QueueRef = { prefix: ZONE, name: 'lifecycle', kind: 'saga' };
    h.holder.queue.getJob.mockResolvedValue(scriptedJob());
    const { service } = makeService(zoneRef);

    await expect(service.get(ZONE, 'lifecycle', JOB_ID)).resolves.toMatchObject({ deviceId: DEVICE });
  });

  it('marks a state bullmq cannot place as unknown rather than guessing', async () => {
    h.holder.queue.getJob.mockResolvedValue(scriptedJob({ getState: vi.fn(() => Promise.resolve('stuck')) }));
    const { service } = makeService(sagaRef);

    await expect(service.get('zone-a', 'lifecycle', JOB_ID)).resolves.toMatchObject({ state: 'unknown' });
  });
});

describe('QueueJobsService — sealed envelopes', () => {
  it('still identifies device, saga, and plan for a sealed job', async () => {
    h.holder.queue.getJob.mockResolvedValue(sealedJob());
    const { service } = makeService(sagaRef);
    const detail = await service.get('zone-a', 'lifecycle', JOB_ID);

    expect(detail).toMatchObject({ sealed: true, deviceId: DEVICE, sagaName: 'provision', planId: PLAN });
  });

  it('exposes the cleartext aad and never the ciphertext, tag, or ephemeral key', async () => {
    h.holder.queue.getJob.mockResolvedValue(sealedJob());
    const { service } = makeService(sagaRef);
    const detail = await service.get('zone-a', 'lifecycle', JOB_ID);
    const serialized = JSON.stringify(detail);

    expect(detail?.aad).toEqual({
      aad_v: 1,
      zone_id: 'zone-sealed',
      queue_name: 'lifecycle',
      direction: 'hub_to_bridge',
      job_id: JOB_ID,
      created_at: 1_700_000_000_001,
    });
    expect(serialized).not.toContain(CIPHERTEXT);
    expect(serialized).not.toContain('eph_pub');
    expect(serialized).not.toContain('dGFn');
  });

  it('reports sealed with a null aad when the header is absent', async () => {
    h.holder.queue.getJob.mockResolvedValue(sealedJob({ data: { envelope_v: 1, ciphertext: CIPHERTEXT } }));
    const { service } = makeService(sagaRef);
    const detail = await service.get('zone-a', 'lifecycle', JOB_ID);

    expect(detail).toMatchObject({ sealed: true, aad: null });
    expect(JSON.stringify(detail)).not.toContain(CIPHERTEXT);
  });

  it('rejects a header missing a frozen field rather than exposing a partial one', async () => {
    h.holder.queue.getJob.mockResolvedValue(
      sealedJob({ data: { envelope_v: 1, aad: { aad_v: 1, zone_id: 'zone-sealed' }, ciphertext: CIPHERTEXT } }),
    );
    const { service } = makeService(sagaRef);

    await expect(service.get('zone-a', 'lifecycle', JOB_ID)).resolves.toMatchObject({ sealed: true, aad: null });
  });

  it('drops a key smuggled into the aad beyond the six frozen fields', async () => {
    h.holder.queue.getJob.mockResolvedValue(
      sealedJob({
        data: {
          envelope_v: 1,
          aad: {
            aad_v: 1,
            zone_id: 'zone-sealed',
            queue_name: 'lifecycle',
            direction: 'hub_to_bridge',
            job_id: JOB_ID,
            created_at: 1_700_000_000_001,
            deployment_os_token: DEPLOYMENT_OS_TOKEN,
          },
          ciphertext: CIPHERTEXT,
        },
      }),
    );
    const { service } = makeService(sagaRef);
    const detail = await service.get('zone-a', 'lifecycle', JOB_ID);

    expect(detail?.aad).not.toHaveProperty('deployment_os_token');
    expect(JSON.stringify(detail)).not.toContain(DEPLOYMENT_OS_TOKEN);
  });

  it('reports a null aad for an unsealed job', async () => {
    h.holder.queue.getJob.mockResolvedValue(scriptedJob());
    const { service } = makeService(sagaRef);

    await expect(service.get('zone-a', 'lifecycle', JOB_ID)).resolves.toMatchObject({ sealed: false, aad: null });
  });
});

describe('QueueJobsService — payload projection', () => {
  it('projects the payload with every secret masked and carries the stacktrace', async () => {
    h.holder.queue.getJob.mockResolvedValue(
      scriptedJob({
        stacktrace: ['Error: boom', '    at step'],
        data: {
          saga_name: 'provision',
          lifecycle_data: {
            os: 'ubuntu-24.04',
            user_data: '#cloud-config',
            pubkeys: ['ssh-ed25519 AAAA', 'ssh-ed25519 BBBB'],
            password_hash: '$6$notarealhash',
            server_token: { deployment_os_token: DEPLOYMENT_OS_TOKEN },
          },
        },
      }),
    );
    const { service } = makeService(sagaRef);
    const detail = await service.get('zone-a', 'lifecycle', JOB_ID);

    expect(detail?.payload).toEqual({
      saga_name: 'provision',
      lifecycle_data: {
        os: 'ubuntu-24.04',
        user_data: '***',
        pubkeys: '<redacted: 2 items>',
        password_hash: '***',
        server_token: '***',
      },
    });
    expect(JSON.stringify(detail)).not.toContain(DEPLOYMENT_OS_TOKEN);
    expect(JSON.stringify(detail)).not.toContain('#cloud-config');
    expect(detail?.payloadTruncated).toBe(false);
    expect(detail?.stacktrace).toEqual(['Error: boom', '    at step']);
  });

  it('masks a dsn credential riding in a payload value', async () => {
    h.holder.queue.getJob.mockResolvedValue(
      scriptedJob({ data: { hub: { DATABASE_URL: 'postgres://brokkr:s3cret@db.internal:5432/brokkr' } } }),
    );
    const { service } = makeService(sagaRef);
    const detail = await service.get('zone-a', 'lifecycle', JOB_ID);

    expect(detail?.payload).toEqual({ hub: { DATABASE_URL: 'postgres://***@db.internal:5432/brokkr' } });
    expect(JSON.stringify(detail)).not.toContain('s3cret');
  });

  it('flags a payload the size cap cut short', async () => {
    h.holder.queue.getJob.mockResolvedValue(scriptedJob({ data: { dmi: 'x'.repeat(20_000) } }));
    const { service } = makeService(sagaRef);
    const detail = await service.get('zone-a', 'lifecycle', JOB_ID);

    expect(detail?.payloadTruncated).toBe(true);
    expect(JSON.stringify(detail?.payload).length).toBeLessThan(20_000);
  });

  it('returns a null payload for a sealed job, whose readable part is the aad header', async () => {
    h.holder.queue.getJob.mockResolvedValue(sealedJob());
    const { service } = makeService(sagaRef);
    const detail = await service.get('zone-a', 'lifecycle', JOB_ID);

    expect(detail).toMatchObject({ sealed: true, payload: null, payloadTruncated: false });
    expect(detail?.aad).toMatchObject({ zone_id: 'zone-sealed' });
    expect(JSON.stringify(detail)).not.toContain(CIPHERTEXT);
  });

  it('returns a null payload when the job data is not a JSON object', async () => {
    h.holder.queue.getJob.mockResolvedValue(scriptedJob({ data: 'just-a-string' }));
    const { service } = makeService(sagaRef);
    const detail = await service.get('zone-a', 'lifecycle', JOB_ID);

    expect(detail).toMatchObject({ sealed: false, aad: null, payload: null, payloadTruncated: false });
  });

  it('carries the stacktrace bullmq retained', async () => {
    h.holder.queue.getJob.mockResolvedValue(scriptedJob({ stacktrace: ['Error: boom', '    at step'] }));
    const { service } = makeService(sagaRef);

    await expect(service.get('zone-a', 'lifecycle', JOB_ID)).resolves.toMatchObject({
      stacktrace: ['Error: boom', '    at step'],
    });
  });
});

describe('QueueJobsService — saga queue zone attribution', () => {
  it('falls back to the queue prefix for a plaintext saga payload that carries no zone', async () => {
    const zoneRef: QueueRef = { prefix: ZONE, name: 'lifecycle', kind: 'saga' };
    h.holder.queue.getJob.mockResolvedValue(scriptedJob());
    const { service } = makeService(zoneRef);

    await expect(service.get(ZONE, 'lifecycle', JOB_ID)).resolves.toMatchObject({ sealed: false, zoneId: ZONE });
  });

  it('reports the sealed aad zone as found rather than correcting it to the prefix', async () => {
    const zoneRef: QueueRef = { prefix: ZONE, name: 'lifecycle', kind: 'saga' };
    h.holder.queue.getJob.mockResolvedValue(sealedJob());
    const { service } = makeService(zoneRef);

    await expect(service.get(ZONE, 'lifecycle', JOB_ID)).resolves.toMatchObject({
      sealed: true,
      zoneId: 'zone-sealed',
    });
  });

  it('keeps a hub queue job zoneless, since its prefix names no zone', async () => {
    const hubRef: QueueRef = { prefix: 'bull', name: 'device-status-effects', kind: 'hub' };
    h.holder.queue.getJob.mockResolvedValue(scriptedJob({ data: { deviceId: DEVICE } }));
    const { service } = makeService(hubRef);

    await expect(service.get('bull', 'device-status-effects', JOB_ID)).resolves.toMatchObject({ zoneId: null });
  });
});

describe('QueueJobsService — results inbox zone attribution', () => {
  it('attributes the zone from zone_prefix', async () => {
    h.holder.queue.getJobs.mockResolvedValueOnce([scriptedJob({ data: { zone_prefix: 'zone-from-prefix' } })]);
    const { service } = makeService(resultsRef);
    const page = await service.list('results', 'inbox', { ...listOptions, states: ['completed'] });

    expect(page?.jobs[0]?.zoneId).toBe('zone-from-prefix');
  });

  it('attributes the zone from zone_id for a render request', async () => {
    h.holder.queue.getJobs.mockResolvedValueOnce([
      scriptedJob({ name: 'render.request', data: { zone_id: 'zone-from-id' } }),
    ]);
    const { service } = makeService(resultsRef);
    const page = await service.list('results', 'inbox', { ...listOptions, states: ['completed'] });

    expect(page?.jobs[0]?.zoneId).toBe('zone-from-id');
  });

  it('attributes the zone from the sealed aad', async () => {
    h.holder.queue.getJobs.mockResolvedValueOnce([sealedJob()]);
    const { service } = makeService(resultsRef);
    const page = await service.list('results', 'inbox', { ...listOptions, states: ['completed'] });

    expect(page?.jobs[0]).toMatchObject({ sealed: true, zoneId: 'zone-sealed' });
  });

  it('reports a null zone for a payload that carries none', async () => {
    h.holder.queue.getJobs.mockResolvedValueOnce([scriptedJob({ data: { status: 'ok' } })]);
    const { service } = makeService(resultsRef);
    const page = await service.list('results', 'inbox', { ...listOptions, states: ['completed'] });

    expect(page?.jobs[0]?.zoneId).toBeNull();
  });
});

describe('QueueJobsService — state window path', () => {
  it('reads one index range per requested state and echoes the resolved filter', async () => {
    h.holder.queue.getJobs.mockResolvedValue([]);
    const { service } = makeService(sagaRef);
    const page = await service.list('zone-a', 'lifecycle', { ...listOptions, states: ['failed', 'delayed'] });

    expect(h.holder.queue.getJobs).toHaveBeenNthCalledWith(1, ['failed'], 0, 49);
    expect(h.holder.queue.getJobs).toHaveBeenNthCalledWith(2, ['delayed'], 0, 49);
    expect(page).toMatchObject({ queue: sagaRef, states: ['failed', 'delayed'], limit: 50, offset: 0, cap: 200 });
  });

  it('reads every state when the filter is empty', async () => {
    h.holder.queue.getJobs.mockResolvedValue([]);
    const { service } = makeService(sagaRef);
    const page = await service.list('zone-a', 'lifecycle', listOptions);

    expect(h.holder.queue.getJobs).toHaveBeenCalledTimes(8);
    expect(page?.states).toEqual([
      'wait',
      'active',
      'paused',
      'delayed',
      'completed',
      'failed',
      'waiting-children',
      'prioritized',
    ]);
  });

  it('honours the offset as an index into the state list, not a cursor', async () => {
    h.holder.queue.getJobs.mockResolvedValue([]);
    const { service } = makeService(sagaRef);
    await service.list('zone-a', 'lifecycle', { ...listOptions, states: ['failed'], limit: 10, offset: 40 });

    expect(h.holder.queue.getJobs).toHaveBeenCalledWith(['failed'], 40, 49);
  });

  it('hard-caps the read at 200 jobs however large the requested limit is', async () => {
    h.holder.queue.getJobs.mockResolvedValue([]);
    const { service } = makeService(sagaRef);
    await service.list('zone-a', 'lifecycle', { ...listOptions, states: ['failed'], limit: 5_000 });

    expect(h.holder.queue.getJobs).toHaveBeenCalledWith(['failed'], 0, 199);
  });

  it('stops reading further states once the cap is spent and reports it truncated', async () => {
    const filled = Array.from({ length: 200 }, (_, i) => scriptedJob({ id: `${DEVICE}-provision-plan${i}` }));
    h.holder.queue.getJobs.mockResolvedValueOnce(filled).mockResolvedValue([]);
    const { service } = makeService(sagaRef);
    const page = await service.list('zone-a', 'lifecycle', {
      ...listOptions,
      states: ['failed', 'delayed'],
      limit: 200,
    });

    expect(h.holder.queue.getJobs).toHaveBeenCalledTimes(1);
    expect(page?.jobs).toHaveLength(200);
    expect(page?.truncated).toBe(true);
  });

  it('reports a full window as truncated and a short one as complete', async () => {
    h.holder.queue.getJobs.mockResolvedValueOnce([scriptedJob(), scriptedJob({ id: `${DEVICE}-collect` })]);
    const { service } = makeService(sagaRef);
    const full = await service.list('zone-a', 'lifecycle', { ...listOptions, states: ['failed'], limit: 2 });

    h.holder.queue.getJobs.mockResolvedValueOnce([scriptedJob()]);
    const short = await service.list('zone-a', 'lifecycle', { ...listOptions, states: ['failed'], limit: 2 });

    expect(full?.truncated).toBe(true);
    expect(short?.truncated).toBe(false);
  });

  it('never repeats a job that appears in two state ranges', async () => {
    h.holder.queue.getJobs.mockResolvedValueOnce([scriptedJob()]).mockResolvedValueOnce([scriptedJob()]);
    const { service } = makeService(sagaRef);
    const page = await service.list('zone-a', 'lifecycle', { ...listOptions, states: ['wait', 'paused'] });

    expect(page?.jobs).toHaveLength(1);
  });
});

describe('QueueJobsService — device filter path', () => {
  it('discovers the device job ids by SCAN and loops the cursor until it returns "0"', async () => {
    h.holder.redis.scan
      .mockResolvedValueOnce(['7', [`zone-a:lifecycle:${DEVICE}-provision-${PLAN}`]])
      .mockResolvedValueOnce(['0', [`zone-a:lifecycle:${DEVICE}-collect`]]);
    h.holder.queue.getJob.mockImplementation((id: string) => Promise.resolve(scriptedJob({ id })));
    const { service } = makeService(sagaRef);
    const page = await service.list('zone-a', 'lifecycle', { ...listOptions, deviceId: DEVICE });

    expect(h.holder.redis.scan).toHaveBeenNthCalledWith(1, '0', 'MATCH', `zone-a:lifecycle:*${DEVICE}*`, 'COUNT', 200);
    expect(h.holder.redis.scan).toHaveBeenNthCalledWith(2, '7', 'MATCH', `zone-a:lifecycle:*${DEVICE}*`, 'COUNT', 200);
    expect(page?.deviceId).toBe(DEVICE);
    expect(page?.jobs.map((job) => job.id)).toEqual([`${DEVICE}-provision-${PLAN}`, `${DEVICE}-collect`]);
  });

  it('matches a hub-local id that carries the device uuid after a literal prefix', async () => {
    const hubRef: QueueRef = { prefix: 'bull', name: 'device-status-effects', kind: 'hub' };
    const jobId = `device-${DEVICE}-provisioned-1700000000000`;
    h.holder.redis.scan.mockResolvedValue(['0', [`bull:device-status-effects:${jobId}`]]);
    h.holder.queue.getJob.mockImplementation((id: string) => Promise.resolve(scriptedJob({ id })));
    const { service } = makeService(hubRef);
    const page = await service.list('bull', 'device-status-effects', { ...listOptions, deviceId: DEVICE });

    expect(h.holder.redis.scan).toHaveBeenCalledWith(
      '0',
      'MATCH',
      `bull:device-status-effects:*${DEVICE}*`,
      'COUNT',
      200,
    );
    expect(page?.jobs.map((job) => job.id)).toEqual([jobId]);
    expect(page?.deviceFilterSupported).toBe(true);
  });

  it('reports the results inbox as unfilterable by device rather than answering an empty list', async () => {
    const { service } = makeService(resultsRef);
    const page = await service.list('results', 'inbox', { ...listOptions, deviceId: DEVICE });

    expect(page).toMatchObject({ deviceId: DEVICE, deviceFilterSupported: false, jobs: [], truncated: false });
    expect(h.holder.redis.scan).not.toHaveBeenCalled();
    expect(h.holder.queue.getJob).not.toHaveBeenCalled();
  });

  it('reports the filter as supported on a saga queue read without a device', async () => {
    h.holder.queue.getJobs.mockResolvedValue([]);
    const { service } = makeService(sagaRef);

    await expect(service.list('zone-a', 'lifecycle', listOptions)).resolves.toMatchObject({
      deviceFilterSupported: true,
    });
  });

  it('drops a match whose own attribution is a different device', async () => {
    const other = '99999999-8888-7777-6666-555555555555';
    h.holder.redis.scan.mockResolvedValue([
      '0',
      [`zone-a:lifecycle:${DEVICE}-provision-${PLAN}`, `zone-a:lifecycle:${other}-provision-${DEVICE}`],
    ]);
    h.holder.queue.getJob.mockImplementation((id: string) => Promise.resolve(scriptedJob({ id })));
    const { service } = makeService(sagaRef);
    const page = await service.list('zone-a', 'lifecycle', { ...listOptions, deviceId: DEVICE });

    expect(page?.jobs.map((job) => job.id)).toEqual([`${DEVICE}-provision-${PLAN}`]);
  });

  it('never matches a zone-scoped saga when the filter uuid is the queue prefix', async () => {
    const zoneRef: QueueRef = { prefix: ZONE, name: 'lifecycle', kind: 'saga' };
    h.holder.redis.scan.mockResolvedValue(['0', [`${ZONE}:lifecycle:${ZONE}-network_scan-${PLAN}`]]);
    h.holder.queue.getJob.mockImplementation((id: string) => Promise.resolve(scriptedJob({ id })));
    const { service } = makeService(zoneRef);
    const page = await service.list(ZONE, 'lifecycle', { ...listOptions, deviceId: ZONE });

    expect(page?.jobs).toEqual([]);
    expect(h.holder.queue.getJob).not.toHaveBeenCalled();
  });

  it('keeps a match no parser can attribute, since the id still carries the uuid', async () => {
    h.holder.redis.scan.mockResolvedValue(['0', [`zone-a:lifecycle:coalesce_${DEVICE}`]]);
    h.holder.queue.getJob.mockImplementation((id: string) => Promise.resolve(scriptedJob({ id })));
    const { service } = makeService(sagaRef);
    const page = await service.list('zone-a', 'lifecycle', { ...listOptions, deviceId: DEVICE });

    expect(page?.jobs).toHaveLength(1);
    expect(page?.jobs[0]?.deviceId).toBeNull();
  });

  it('never windows the queue state lists on the device path', async () => {
    h.holder.redis.scan.mockResolvedValue(['0', []]);
    const { service } = makeService(sagaRef);
    await service.list('zone-a', 'lifecycle', { ...listOptions, deviceId: DEVICE });

    expect(h.holder.queue.getJobs).not.toHaveBeenCalled();
  });

  it('reports an empty result for a device with no job keys at all', async () => {
    h.holder.redis.scan.mockResolvedValue(['0', []]);
    const { service } = makeService(sagaRef);
    const page = await service.list('zone-a', 'lifecycle', { ...listOptions, deviceId: DEVICE });

    expect(page).toMatchObject({ jobs: [], truncated: false, deviceId: DEVICE });
  });

  it('skips the per-job side keys a job hash scan also matches', async () => {
    h.holder.redis.scan.mockResolvedValue([
      '0',
      [
        `zone-a:lifecycle:${DEVICE}-provision-${PLAN}`,
        `zone-a:lifecycle:${DEVICE}-provision-${PLAN}:logs`,
        `zone-a:lifecycle:${DEVICE}-provision-${PLAN}:dependencies`,
      ],
    ]);
    h.holder.queue.getJob.mockImplementation((id: string) => Promise.resolve(scriptedJob({ id })));
    const { service } = makeService(sagaRef);
    await service.list('zone-a', 'lifecycle', { ...listOptions, deviceId: DEVICE });

    expect(h.holder.queue.getJob).toHaveBeenCalledTimes(1);
    expect(h.holder.queue.getJob).toHaveBeenCalledWith(`${DEVICE}-provision-${PLAN}`);
  });

  it('keeps a repeatable job the scan matches, and drops its side key', async () => {
    const jobId = `repeat:sweep-${DEVICE}:1785955080000`;
    h.holder.redis.scan.mockResolvedValue([
      '0',
      [`zone-a:lifecycle:${jobId}`, `zone-a:lifecycle:${jobId}:logs`, `zone-a:lifecycle:repeat:sweep-${DEVICE}`],
    ]);
    h.holder.queue.getJob.mockImplementation((id: string) => Promise.resolve(scriptedJob({ id })));
    const { service } = makeService(sagaRef);
    const page = await service.list('zone-a', 'lifecycle', { ...listOptions, deviceId: DEVICE });

    expect(page?.jobs.map((job) => job.id)).toEqual([jobId]);
    expect(h.holder.queue.getJob).toHaveBeenCalledTimes(1);
  });

  it('caps the id discovery and reports the listing truncated', async () => {
    const keys = Array.from({ length: 250 }, (_, i) => `zone-a:lifecycle:${DEVICE}-provision-plan${i}`);
    h.holder.redis.scan.mockResolvedValue(['0', keys]);
    h.holder.queue.getJob.mockImplementation((id: string) => Promise.resolve(scriptedJob({ id })));
    const { service } = makeService(sagaRef);
    const page = await service.list('zone-a', 'lifecycle', { ...listOptions, deviceId: DEVICE, limit: 200 });

    expect(h.holder.queue.getJob).toHaveBeenCalledTimes(200);
    expect(page?.truncated).toBe(true);
  });

  it('declares the capped remainder unreachable rather than implying a further page', async () => {
    const keys = Array.from({ length: 250 }, (_, i) => `zone-a:lifecycle:${DEVICE}-provision-plan${i}`);
    h.holder.redis.scan.mockResolvedValue(['0', keys]);
    h.holder.queue.getJob.mockImplementation((id: string) => Promise.resolve(scriptedJob({ id })));
    const { service } = makeService(sagaRef);
    const page = await service.list('zone-a', 'lifecycle', { ...listOptions, deviceId: DEVICE, limit: 200 });

    expect(page).toMatchObject({ truncated: true, discoveryCapped: true });
  });

  it('reports an uncapped discovery as reachable however the window falls', async () => {
    h.holder.redis.scan.mockResolvedValue([
      '0',
      [`zone-a:lifecycle:${DEVICE}-a`, `zone-a:lifecycle:${DEVICE}-b`, `zone-a:lifecycle:${DEVICE}-c`],
    ]);
    h.holder.queue.getJob.mockImplementation((id: string) => Promise.resolve(scriptedJob({ id })));
    const { service } = makeService(sagaRef);
    const windowed = await service.list('zone-a', 'lifecycle', { ...listOptions, deviceId: DEVICE, limit: 2 });
    const whole = await service.list('zone-a', 'lifecycle', { ...listOptions, deviceId: DEVICE, limit: 50 });

    expect(windowed).toMatchObject({ truncated: true, discoveryCapped: false });
    expect(whole).toMatchObject({ truncated: false, discoveryCapped: false });
  });

  it('never reports a capped discovery on the state window path', async () => {
    const filled = Array.from({ length: 200 }, (_, i) => scriptedJob({ id: `${DEVICE}-provision-plan${i}` }));
    h.holder.queue.getJobs.mockResolvedValueOnce(filled).mockResolvedValue([]);
    const { service } = makeService(sagaRef);
    const page = await service.list('zone-a', 'lifecycle', { ...listOptions, limit: 200 });

    expect(page).toMatchObject({ truncated: true, discoveryCapped: false });
  });

  it('orders the device jobs newest first and windows the complete set', async () => {
    h.holder.redis.scan.mockResolvedValue([
      '0',
      [`zone-a:lifecycle:${DEVICE}-a`, `zone-a:lifecycle:${DEVICE}-b`, `zone-a:lifecycle:${DEVICE}-c`],
    ]);
    const stamps: Record<string, number> = {
      [`${DEVICE}-a`]: 1_000,
      [`${DEVICE}-b`]: 3_000,
      [`${DEVICE}-c`]: 2_000,
    };
    h.holder.queue.getJob.mockImplementation((id: string) =>
      Promise.resolve(scriptedJob({ id, timestamp: stamps[id] })),
    );
    const { service } = makeService(sagaRef);
    const page = await service.list('zone-a', 'lifecycle', { ...listOptions, deviceId: DEVICE, limit: 2 });

    expect(page?.jobs.map((job) => job.id)).toEqual([`${DEVICE}-b`, `${DEVICE}-c`]);
    expect(page?.truncated).toBe(true);
  });

  it('applies a state filter to the discovered set rather than to a window', async () => {
    h.holder.redis.scan.mockResolvedValue(['0', [`zone-a:lifecycle:${DEVICE}-a`, `zone-a:lifecycle:${DEVICE}-b`]]);
    h.holder.queue.getJob.mockImplementation((id: string) =>
      Promise.resolve(
        scriptedJob({ id, getState: vi.fn(() => Promise.resolve(id.endsWith('-a') ? 'failed' : 'delayed')) }),
      ),
    );
    const { service } = makeService(sagaRef);
    const page = await service.list('zone-a', 'lifecycle', { ...listOptions, deviceId: DEVICE, states: ['failed'] });

    expect(page?.jobs.map((job) => job.id)).toEqual([`${DEVICE}-a`]);
  });

  it('drops a job that disappeared between discovery and the read', async () => {
    h.holder.redis.scan.mockResolvedValue(['0', [`zone-a:lifecycle:${DEVICE}-a`, `zone-a:lifecycle:${DEVICE}-b`]]);
    h.holder.queue.getJob.mockImplementation((id: string) =>
      Promise.resolve(id.endsWith('-a') ? null : scriptedJob({ id })),
    );
    const { service } = makeService(sagaRef);
    const page = await service.list('zone-a', 'lifecycle', { ...listOptions, deviceId: DEVICE });

    expect(page?.jobs.map((job) => job.id)).toEqual([`${DEVICE}-b`]);
  });

  it('never falls back to the blocking KEYS command', async () => {
    h.holder.redis.scan.mockResolvedValue(['0', []]);
    const { service } = makeService(sagaRef);
    await service.list('zone-a', 'lifecycle', { ...listOptions, deviceId: DEVICE });

    expect(h.holder.redis.keys).not.toHaveBeenCalled();
  });
});

describe('QueueJobsService — degradation', () => {
  it('propagates a failed read instead of reporting an empty queue', async () => {
    h.holder.queue.getJobs.mockRejectedValue(new Error('ECONNREFUSED'));
    const { service } = makeService(sagaRef);

    await expect(service.list('zone-a', 'lifecycle', { ...listOptions, states: ['failed'] })).rejects.toThrow(
      'ECONNREFUSED',
    );
  });

  it('propagates a failed job detail read', async () => {
    h.holder.queue.getJob.mockRejectedValue(new Error('WRONGTYPE'));
    const { service } = makeService(sagaRef);

    await expect(service.get('zone-a', 'lifecycle', JOB_ID)).rejects.toThrow('WRONGTYPE');
  });
});
