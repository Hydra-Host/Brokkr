import type { Queue } from 'bullmq';
import { afterEach, describe, expect, it } from 'vitest';

import { ConnectionRegistry } from '../../../agent/connection-registry/connection-registry.service';
import { BrokkrLiveReadinessService } from '../../../brokkr-live/brokkr-live-readiness.service';
import { BullmqSupervisorService, type SupervisedWorker } from '../../../bullmq/bullmq-supervisor.service';
import { getShutdownSignal, setShutdownSignal, ShutdownRequested } from '../shutdown-signal';

function makeIdleWorker(): SupervisedWorker {
  let resolveRun: (() => void) | null = null;
  const runPromise = new Promise<void>((resolve) => {
    resolveRun = resolve;
  });
  return {
    async run() {
      await runPromise;
    },
    async close() {
      if (resolveRun !== null) {
        resolveRun();
        resolveRun = null;
      }
    },
  };
}

function makeIdleQueue(): Queue {
  return {
    name: 'idle',
    client: Promise.resolve({ zrangebyscore: async () => [], zscore: async () => '0' }),
    toKey: (type: string) => `idle:${type}`,
    getJob: async () => undefined,
    close: async () => {},
  } as unknown as Queue;
}

const silentLogger = {
  info: async () => undefined,
  error: async () => undefined,
};

describe('shutdown signal holder', () => {
  afterEach(() => {
    setShutdownSignal(undefined);
  });

  it('is empty until a supervisor starts', () => {
    expect(getShutdownSignal()).toBeUndefined();
  });

  it('publishes the supervisor signal on start and clears it on destroy', async () => {
    const supervisor = new BullmqSupervisorService();
    supervisor.start(makeIdleWorker, makeIdleWorker, makeIdleQueue(), makeIdleQueue(), 3_600);

    expect(getShutdownSignal()?.aborted).toBe(false);

    await supervisor.onModuleDestroy();

    expect(getShutdownSignal()).toBeUndefined();
  });

  it('aborts an in-flight brokkr-live readiness wait when the supervisor requests shutdown', async () => {
    const supervisor = new BullmqSupervisorService();
    supervisor.start(makeIdleWorker, makeIdleWorker, makeIdleQueue(), makeIdleQueue(), 3_600);
    const service = new BrokkrLiveReadinessService('job-drain', new ConnectionRegistry(), silentLogger, {
      initialDelaySeconds: 90,
      maxWaitSeconds: 600,
    });

    const startedAt = Date.now();
    const waiting = service.waitForBrokkrLive('device-drain', { initialDelay: 90 });
    supervisor.requestShutdown();

    await expect(waiting).rejects.toThrow(ShutdownRequested);
    expect(Date.now() - startedAt).toBeLessThan(1_000);

    await supervisor.waitForShutdown();
  });
});
