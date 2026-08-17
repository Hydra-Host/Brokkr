import { getErrorMessage } from '../common/error-utils';
import type { WorkerFactory } from './bullmq-supervisor.service.js';

export interface EntrypointSupervisor {
  start(lifecycleFactory: WorkerFactory, collectionFactory: WorkerFactory): void;
  requestShutdown(): void;
  waitForShutdown(): Promise<void>;
}

export type EntrypointLogger = {
  info(message: string): void | Promise<void>;
  error(message: string): void | Promise<void>;
};

export interface RunWorkerEntrypointDeps {
  supervisor: EntrypointSupervisor;
  lifecycleFactory: WorkerFactory;
  collectionFactory: WorkerFactory;
  logger: EntrypointLogger;
  installSignalHandlers?: (handler: (signal: 'SIGTERM' | 'SIGINT') => void) => () => void;
}

export async function runWorkerEntrypoint(deps: RunWorkerEntrypointDeps): Promise<number> {
  const { supervisor, lifecycleFactory, collectionFactory, logger } = deps;
  const installSignalHandlers = deps.installSignalHandlers ?? defaultInstallSignalHandlers;

  const uninstall = installSignalHandlers(() => {
    supervisor.requestShutdown();
  });

  try {
    supervisor.start(lifecycleFactory, collectionFactory);
    await supervisor.waitForShutdown();
    return 0;
  } catch (exc) {
    try {
      await logger.error(`BullMQ worker supervisor failed: ${getErrorMessage(exc)}`);
    } catch (error) {
      void error;
    }
    return 1;
  } finally {
    uninstall();
  }
}

function defaultInstallSignalHandlers(handler: (signal: 'SIGTERM' | 'SIGINT') => void): () => void {
  const onTerm = (): void => handler('SIGTERM');
  const onInt = (): void => handler('SIGINT');
  process.on('SIGTERM', onTerm);
  process.on('SIGINT', onInt);
  return (): void => {
    process.off('SIGTERM', onTerm);
    process.off('SIGINT', onInt);
  };
}
