import { describe, expect, it, vi } from 'vitest';

import type { WorkerFactory } from '../bullmq-supervisor.service.js';
import { runWorkerEntrypoint, type EntrypointLogger, type EntrypointSupervisor } from '../worker-entrypoint.js';

function makeLogger(): {
  logger: EntrypointLogger;
  entries: Array<{ level: string; message: string }>;
} {
  const entries: Array<{ level: string; message: string }> = [];
  const logger: EntrypointLogger = {
    info: (m) => {
      entries.push({ level: 'info', message: m });
    },
    error: (m) => {
      entries.push({ level: 'error', message: m });
    },
  };
  return { logger, entries };
}

function makeFakeSupervisor(): {
  supervisor: EntrypointSupervisor;
  fireSignal: () => void;
  startCalls: Array<{ lifecycle: WorkerFactory; collection: WorkerFactory }>;
  shutdownRequests: number;
} {
  const startCalls: Array<{ lifecycle: WorkerFactory; collection: WorkerFactory }> = [];
  let shutdownRequests = 0;
  let resolveWait: (() => void) | null = null;
  const waitPromise = new Promise<void>((resolve) => {
    resolveWait = resolve;
  });

  const supervisor: EntrypointSupervisor = {
    start(lifecycle, collection) {
      startCalls.push({ lifecycle, collection });
    },
    requestShutdown() {
      shutdownRequests += 1;
      if (resolveWait !== null) {
        resolveWait();
        resolveWait = null;
      }
    },
    async waitForShutdown() {
      await waitPromise;
    },
  };

  return {
    supervisor,
    fireSignal: () => {
      supervisor.requestShutdown();
    },
    startCalls,
    get shutdownRequests() {
      return shutdownRequests;
    },
  } as ReturnType<typeof makeFakeSupervisor>;
}

const noopFactory: WorkerFactory = () => ({
  async run() {},
  async close() {},
});

describe('runWorkerEntrypoint', () => {
  it('starts the supervisor with both factories and returns 0 on clean shutdown', async () => {
    const { logger, entries } = makeLogger();
    const { supervisor, fireSignal, startCalls } = makeFakeSupervisor();
    const installSignalHandlers = (handler: (signal: 'SIGTERM' | 'SIGINT') => void): (() => void) => {
      queueMicrotask(() => handler('SIGTERM'));
      return () => undefined;
    };

    const lifecycle: WorkerFactory = vi.fn(noopFactory);
    const collection: WorkerFactory = vi.fn(noopFactory);

    const code = await runWorkerEntrypoint({
      supervisor,
      lifecycleFactory: lifecycle,
      collectionFactory: collection,
      logger,
      installSignalHandlers,
    });

    expect(code).toBe(0);
    expect(startCalls).toHaveLength(1);
    expect(startCalls[0].lifecycle).toBe(lifecycle);
    expect(startCalls[0].collection).toBe(collection);
    expect(entries).toEqual([]);
    expect(typeof fireSignal).toBe('function');
  });

  it('SIGTERM and SIGINT both drive requestShutdown', async () => {
    const { logger } = makeLogger();
    const { supervisor } = makeFakeSupervisor();
    const requestSpy = vi.spyOn(supervisor, 'requestShutdown');

    const installSignalHandlers = (handler: (signal: 'SIGTERM' | 'SIGINT') => void): (() => void) => {
      queueMicrotask(() => {
        handler('SIGTERM');
        handler('SIGINT');
      });
      return () => undefined;
    };

    const code = await runWorkerEntrypoint({
      supervisor,
      lifecycleFactory: noopFactory,
      collectionFactory: noopFactory,
      logger,
      installSignalHandlers,
    });

    expect(code).toBe(0);
    expect(requestSpy).toHaveBeenCalledTimes(2);
  });

  it('returns 1 and logs when the supervisor throws', async () => {
    const { logger, entries } = makeLogger();
    const boom = new Error('boom');
    const supervisor: EntrypointSupervisor = {
      start() {},
      requestShutdown() {},
      async waitForShutdown() {
        throw boom;
      },
    };

    const code = await runWorkerEntrypoint({
      supervisor,
      lifecycleFactory: noopFactory,
      collectionFactory: noopFactory,
      logger,
      installSignalHandlers: () => () => undefined,
    });

    expect(code).toBe(1);
    expect(entries).toEqual([{ level: 'error', message: 'BullMQ worker supervisor failed: boom' }]);
  });

  it('swallows log_error rejection so the exit code is still 1', async () => {
    const supervisor: EntrypointSupervisor = {
      start() {},
      requestShutdown() {},
      async waitForShutdown() {
        throw new Error('inner');
      },
    };
    const logger: EntrypointLogger = {
      info: () => undefined,
      error: () => {
        throw new Error('logger blew up');
      },
    };

    const code = await runWorkerEntrypoint({
      supervisor,
      lifecycleFactory: noopFactory,
      collectionFactory: noopFactory,
      logger,
      installSignalHandlers: () => () => undefined,
    });

    expect(code).toBe(1);
  });

  it('uninstalls signal handlers after the supervisor completes', async () => {
    const { logger } = makeLogger();
    const { supervisor } = makeFakeSupervisor();
    const uninstall = vi.fn();
    const installSignalHandlers = (handler: (signal: 'SIGTERM' | 'SIGINT') => void): (() => void) => {
      queueMicrotask(() => handler('SIGTERM'));
      return uninstall;
    };

    await runWorkerEntrypoint({
      supervisor,
      lifecycleFactory: noopFactory,
      collectionFactory: noopFactory,
      logger,
      installSignalHandlers,
    });

    expect(uninstall).toHaveBeenCalledTimes(1);
  });

  it('uninstalls signal handlers even when the supervisor throws', async () => {
    const { logger } = makeLogger();
    const uninstall = vi.fn();
    const supervisor: EntrypointSupervisor = {
      start() {},
      requestShutdown() {},
      async waitForShutdown() {
        throw new Error('failure');
      },
    };

    await runWorkerEntrypoint({
      supervisor,
      lifecycleFactory: noopFactory,
      collectionFactory: noopFactory,
      logger,
      installSignalHandlers: () => uninstall,
    });

    expect(uninstall).toHaveBeenCalledTimes(1);
  });
});
