import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  awaitBullmqProcessor,
  resetBullmqProcessorForTests,
  setBullmqProcessor,
} from '../../bullmq/bullmq-processor-singleton';
import { JOB_NAME } from '../../bullmq/bullmq.types';
import {
  BullmqProcessorService,
  CrossBridgeHandoff,
  type InboundEnvelopeOpener,
  type JobHandler,
  type ProcessableJob,
} from '../../bullmq/handlers.service';
import type { BullmqQueue } from '../../bullmq/queue.service';
import { BullmqQueueService } from '../../bullmq/queue.service';
import { BullmqRegistryService } from '../../bullmq/registry.service';
import { LockLost } from '../../saga-framework/saga-runner.service';
import { ZoneCryptoService } from '../../zone-crypto/zone-crypto.service';
import { createCollectionWorker, createLifecycleWorker, createRenderRequestEnqueuer } from '../bullmq-factories';

interface CapturedWorker {
  queueName: string;
  processor: (job: unknown, token?: string) => Promise<unknown>;
  opts: Record<string, unknown>;
  runCalls: number;
  closeCalls: Array<boolean | undefined>;
}

function makeWorkerCtor(captured: { worker: CapturedWorker | null }): typeof import('bullmq').Worker {
  class FakeWorker {
    constructor(
      queueName: string,
      processor: (job: unknown, token?: string) => Promise<unknown>,
      opts: Record<string, unknown>,
    ) {
      captured.worker = {
        queueName,
        processor,
        opts,
        runCalls: 0,
        closeCalls: [],
      };
    }
    async run(): Promise<void> {
      if (captured.worker !== null) captured.worker.runCalls += 1;
    }
    async close(force?: boolean): Promise<void> {
      if (captured.worker !== null) captured.worker.closeCalls.push(force);
    }
  }
  return FakeWorker as unknown as typeof import('bullmq').Worker;
}

const PASSTHROUGH_OPENER: InboundEnvelopeOpener = {
  async open(job) {
    return { payload: job.data, createdAtMs: Date.now(), isBridgeLocal: false };
  },
};

type MoveToDelayedFn = ProcessableJob<unknown>['scripts']['moveToDelayed'];

const REDIS_CONFIG = {
  url: 'redis://localhost:6379/0',
  host: 'localhost',
  port: 6379,
  username: '',
  password: '',
  db: 0,
  tls: false,
  tlsCaCert: '',
  prefix: '',
  socketTimeout: 5,
  socketConnectTimeout: 5,
  retryOnError: true,
  maxConnections: 50,
  encryptionKey: '',
  ttls: {
    deviceNetplan: 120,
    bmcCipher: 2_592_000,
    deviceSshIp: 300,
    resolvedIp: 3600,
    deviceInitrd: 600,
    bridgeInterfaces: 300,
    syncVersion: 2_592_000,
  },
};

const BULLMQ_CONFIG = {
  redisKeyPrefix: 'bridge:jobs',
  defaultJobTtlSeconds: 7200,
  bullmqQueueName: 'lifecycle',
  bullmqPrefix: 'bull',
  redisPrefix: '',
  queueMode: 'device' as const,
  bullmqRetries: 1,
  lifecycleWorkerConcurrency: 10,
  deviceLockTimeoutSeconds: 60,
  deviceLockRenewIntervalSeconds: 20,
  lockLostRedelaySeconds: 90,
  bullmqLockDurationMs: 300_000,
  bullmqLockRenewTimeMs: 60_000,
  bullmqMaxStalledCount: 5,
  bullmqStalledIntervalMs: 30_000,
  resultsQueueName: 'inbox',
  resultsQueuePrefix: 'results',
  collectionQueueName: 'collection',
  collectionWorkerConcurrency: 1,
  strandedPlanResumeIntervalSeconds: 30,
  strandedPlanGraceSeconds: 60,
  strandedPlanResumeBatchSize: 10,
  strandedPlanRunningStaleSeconds: 1800,
};

describe('bullmq worker factories', () => {
  beforeEach(() => {
    resetBullmqProcessorForTests();
  });

  afterEach(() => {
    resetBullmqProcessorForTests();
  });

  it('createLifecycleWorker wires the lifecycle queue name + concurrency from config', () => {
    const captured: { worker: CapturedWorker | null } = { worker: null };
    const worker = createLifecycleWorker({
      config: BULLMQ_CONFIG,
      redisConfig: REDIS_CONFIG,
      workerCtor: makeWorkerCtor(captured),
    });

    expect(worker).toBeDefined();
    expect(captured.worker).not.toBeNull();
    expect(captured.worker!.queueName).toBe('lifecycle');
    expect(captured.worker!.opts.concurrency).toBe(10);
    expect(captured.worker!.opts.prefix).toBe('bull');
    expect(captured.worker!.opts.lockDuration).toBe(300_000);
    expect(captured.worker!.opts.lockRenewTime).toBe(60_000);
    expect(captured.worker!.opts.autorun).toBe(false);
    expect(Object.hasOwn(captured.worker!.opts, 'telemetry')).toBe(true);
    expect(captured.worker!.opts.telemetry).toBeUndefined();
    const connection = captured.worker!.opts.connection as Record<string, unknown>;
    expect(connection.host).toBe('localhost');
    expect(connection.port).toBe(6379);
    expect(connection.maxRetriesPerRequest).toBeNull();
  });

  it('createCollectionWorker wires the collection queue name + concurrency from config', () => {
    const captured: { worker: CapturedWorker | null } = { worker: null };
    createCollectionWorker({
      config: BULLMQ_CONFIG,
      redisConfig: REDIS_CONFIG,
      workerCtor: makeWorkerCtor(captured),
    });
    expect(captured.worker!.queueName).toBe('collection');
    expect(captured.worker!.opts.concurrency).toBe(1);
  });

  it('loads the private CA cert into the worker tls options when tlsCaCert is set', () => {
    const caPath = join(tmpdir(), 'cod309-bullmq-ca.pem');
    const caBody = '-----BEGIN CERTIFICATE-----\ncod309\n-----END CERTIFICATE-----';
    writeFileSync(caPath, caBody);
    try {
      const captured: { worker: CapturedWorker | null } = { worker: null };
      createLifecycleWorker({
        config: BULLMQ_CONFIG,
        redisConfig: { ...REDIS_CONFIG, tls: true, tlsCaCert: caPath },
        workerCtor: makeWorkerCtor(captured),
      });
      const connection = captured.worker!.opts.connection as Record<string, unknown>;
      expect(connection.tls).toEqual({ ca: Buffer.from(caBody) });
    } finally {
      rmSync(caPath, { force: true });
    }
  });

  it('uses empty tls options when TLS is on but no CA cert is configured', () => {
    const captured: { worker: CapturedWorker | null } = { worker: null };
    createLifecycleWorker({
      config: BULLMQ_CONFIG,
      redisConfig: { ...REDIS_CONFIG, tls: true, tlsCaCert: '' },
      workerCtor: makeWorkerCtor(captured),
    });
    const connection = captured.worker!.opts.connection as Record<string, unknown>;
    expect(connection.tls).toEqual({});
  });

  it('SupervisedWorker.run + close delegate to the underlying bullmq Worker', async () => {
    const captured: { worker: CapturedWorker | null } = { worker: null };
    const worker = createLifecycleWorker({
      config: BULLMQ_CONFIG,
      redisConfig: REDIS_CONFIG,
      workerCtor: makeWorkerCtor(captured),
    });
    await worker.run();
    await worker.close(true);
    expect(captured.worker!.runCalls).toBe(1);
    expect(captured.worker!.closeCalls).toEqual([true]);
  });

  it('processor callback awaits the singleton and dispatches saga.run through the registry', async () => {
    const registry = new BullmqRegistryService();
    const handlerSeen: ProcessableJob<Record<string, unknown>>[] = [];
    const sagaHandler: JobHandler = async (job) => {
      handlerSeen.push(job);
      return { plan_id: 'plan-x', status: 'completed' };
    };
    registry.register(JOB_NAME.SAGA_RUN, sagaHandler);
    const processor = new BullmqProcessorService(
      { [JOB_NAME.SAGA_RUN]: registry.getHandler(JOB_NAME.SAGA_RUN)! },
      PASSTHROUGH_OPENER,
    );
    setBullmqProcessor(processor);

    const captured: { worker: CapturedWorker | null } = { worker: null };
    createLifecycleWorker({
      config: BULLMQ_CONFIG,
      redisConfig: REDIS_CONFIG,
      workerCtor: makeWorkerCtor(captured),
    });

    const fakeJob = {
      id: 'job-1',
      name: JOB_NAME.SAGA_RUN,
      data: { plan_id: 'plan-x', saga_name: 'deprovision', payload: { device_id: 'dev-1' } },
      queueName: 'lifecycle',
      queue: { opts: {} },
      scripts: {
        moveToDelayed: vi.fn(async () => {}),
      },
    };

    const result = await captured.worker!.processor(fakeJob, 'token-1');
    expect(result).toEqual({ plan_id: 'plan-x', status: 'completed' });
    expect(handlerSeen).toHaveLength(1);
    expect(handlerSeen[0].data.plan_id).toBe('plan-x');
  });

  it('processor callback parks until setBullmqProcessor lands the singleton (post-boot race)', async () => {
    const registry = new BullmqRegistryService();
    registry.register(JOB_NAME.SAGA_RUN, async () => ({ ok: true }));
    const processor = new BullmqProcessorService(
      { [JOB_NAME.SAGA_RUN]: registry.getHandler(JOB_NAME.SAGA_RUN)! },
      PASSTHROUGH_OPENER,
    );

    const captured: { worker: CapturedWorker | null } = { worker: null };
    createLifecycleWorker({
      config: BULLMQ_CONFIG,
      redisConfig: REDIS_CONFIG,
      workerCtor: makeWorkerCtor(captured),
    });

    const fakeJob = {
      id: 'job-2',
      name: JOB_NAME.SAGA_RUN,
      data: {},
      queueName: 'lifecycle',
      queue: { opts: {} },
      scripts: { moveToDelayed: vi.fn(async () => {}) },
    };

    const pending = captured.worker!.processor(fakeJob, 'token-2');
    let resolved = false;
    const resolvedPromise = pending.then((r) => {
      resolved = true;
      return r;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);

    setBullmqProcessor(processor);
    await expect(resolvedPromise).resolves.toEqual({ ok: true });
  });

  it('LockLost redelay maps through CrossBridgeHandoff to bullmq WaitingChildrenError', async () => {
    const failing: JobHandler = async () => {
      throw new LockLost('device lock expired');
    };
    const processor = new BullmqProcessorService(
      { [JOB_NAME.SAGA_RUN]: failing },
      PASSTHROUGH_OPENER,
      undefined,
      BULLMQ_CONFIG.lockLostRedelaySeconds * 1000,
    );
    setBullmqProcessor(processor);

    const captured: { worker: CapturedWorker | null } = { worker: null };
    createLifecycleWorker({
      config: BULLMQ_CONFIG,
      redisConfig: REDIS_CONFIG,
      workerCtor: makeWorkerCtor(captured),
    });

    const moveToDelayed = vi.fn<MoveToDelayedFn>(async () => {});
    const fakeJob = {
      id: 'job-3',
      name: JOB_NAME.SAGA_RUN,
      data: {},
      queueName: 'lifecycle',
      queue: { opts: {} },
      scripts: { moveToDelayed },
    };

    await expect(captured.worker!.processor(fakeJob, 'token-3')).rejects.toMatchObject({
      name: 'WaitingChildrenError',
    });
    expect(moveToDelayed).toHaveBeenCalledTimes(1);
    expect(moveToDelayed.mock.calls[0][2]).toBe(90_000);
  });

  it('singleton: setBullmqProcessor → awaitBullmqProcessor returns the registered instance', async () => {
    const processor = new BullmqProcessorService({}, PASSTHROUGH_OPENER);
    setBullmqProcessor(processor);
    await expect(awaitBullmqProcessor()).resolves.toBe(processor);
  });

  it('CrossBridgeHandoff outside the processor still propagates verbatim', async () => {
    const handler: JobHandler = async () => {
      throw new CrossBridgeHandoff('manual reschedule');
    };
    const processor = new BullmqProcessorService({ [JOB_NAME.SAGA_RUN]: handler }, PASSTHROUGH_OPENER);
    setBullmqProcessor(processor);

    const captured: { worker: CapturedWorker | null } = { worker: null };
    createLifecycleWorker({
      config: BULLMQ_CONFIG,
      redisConfig: REDIS_CONFIG,
      workerCtor: makeWorkerCtor(captured),
    });

    const fakeJob = {
      id: 'job-4',
      name: JOB_NAME.SAGA_RUN,
      data: {},
      queueName: 'lifecycle',
      queue: { opts: {} },
      scripts: { moveToDelayed: vi.fn(async () => {}) },
    };

    await expect(captured.worker!.processor(fakeJob, 'token-4')).rejects.toMatchObject({
      name: 'WaitingChildrenError',
    });
  });
});

describe('createRenderRequestEnqueuer zone-crypto wiring', () => {
  class FakeResultsQueue implements BullmqQueue {
    readonly added: Array<{ name: string; data: Record<string, unknown> }> = [];
    readonly name = 'inbox';

    async add(name: string, data: Record<string, unknown>): Promise<unknown> {
      this.added.push({ name, data });
      return {};
    }

    async remove(): Promise<void> {}

    async getJobState(): Promise<string | null> {
      return null;
    }

    async close(): Promise<void> {}
  }

  class FakeBullmqQueueService {
    readonly queue = new FakeResultsQueue();
    async getResultsQueue(): Promise<BullmqQueue | null> {
      return this.queue;
    }
    async resetSharedOpsStateOnConnectionError(): Promise<boolean> {
      return false;
    }
  }

  const ENQUEUE_ARGS = {
    requestId: '550e8400-e29b-41d4-a716-446655440099',
    domain: 'netplan',
    bridgeId: 'bridge-1',
    entityId: 'dev-1',
  };

  it('passes plaintext through when zone crypto is dormant', async () => {
    const queueService = new FakeBullmqQueueService();
    const zoneCrypto = new ZoneCryptoService();
    zoneCrypto.clear();
    const enqueuer = createRenderRequestEnqueuer(queueService as unknown as BullmqQueueService, zoneCrypto, {
      BROKKR_ZONE_ID: '00000000-0000-4000-8000-000000000099',
    });

    const ok = await enqueuer(ENQUEUE_ARGS);
    expect(ok).toBe(true);
    const { data } = queueService.queue.added[0];
    expect(data.request_id).toBe(ENQUEUE_ARGS.requestId);
    expect(data.envelope_v).toBeUndefined();
  });

  it('seals the envelope when zone crypto is active', async () => {
    const queueService = new FakeBullmqQueueService();
    const zoneCrypto = new ZoneCryptoService();
    zoneCrypto.set({
      zonePriv: Buffer.alloc(32, 1),
      zonePub: Buffer.alloc(32, 2),
      hubPub: Buffer.alloc(32, 3),
      enrolledAt: 1_700_000_000_000,
    });
    try {
      const enqueuer = createRenderRequestEnqueuer(queueService as unknown as BullmqQueueService, zoneCrypto, {
        BROKKR_ZONE_ID: '00000000-0000-4000-8000-000000000042',
      });

      const ok = await enqueuer(ENQUEUE_ARGS);
      expect(ok).toBe(true);
      const { data } = queueService.queue.added[0];
      expect(data.envelope_v).toBe(1);
      expect(data.ciphertext).toBeTypeOf('string');
      expect(data.tag).toBeTypeOf('string');
      expect(data.request_id).toBeUndefined();
      expect(data.aad).toMatchObject({
        zone_id: '00000000-0000-4000-8000-000000000042',
        queue_name: 'inbox',
        job_id: ENQUEUE_ARGS.requestId,
      });
    } finally {
      zoneCrypto.clear();
    }
  });
});
