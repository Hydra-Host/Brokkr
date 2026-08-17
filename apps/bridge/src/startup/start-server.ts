import { getErrorMessage } from '../common/error-utils';
import type { StartupLogger } from './startup-deps.types.js';

export type SyncLogger = Pick<StartupLogger, 'info' | 'error'>;

export interface StartServerDeps {
  startProductionServer(shutdownTrigger: Promise<void>): Promise<void>;
  logger: SyncLogger;
  exit?: (code: number) => never;
  installSignalHandlers?: (handler: (signal: 'SIGTERM' | 'SIGINT') => void) => () => void;
  ignoreSigpipe?: () => void;
  onShutdownReady?: (requestShutdown: () => void) => void;
}

const SIGNAL_NAMES: Record<'SIGTERM' | 'SIGINT', string> = {
  SIGTERM: 'SIGTERM',
  SIGINT: 'SIGINT',
};

export async function startServer(deps: StartServerDeps): Promise<void> {
  const { startProductionServer, logger } = deps;
  const exit = deps.exit ?? defaultExit;
  const ignoreSigpipe = deps.ignoreSigpipe ?? defaultIgnoreSigpipe;
  const installSignalHandlers = deps.installSignalHandlers ?? defaultInstallSignalHandlers;

  ignoreSigpipe();

  let resolveShutdown: (() => void) | null = null;
  const shutdownTrigger = new Promise<void>((resolve) => {
    resolveShutdown = resolve;
  });

  const requestShutdown = (): void => {
    if (resolveShutdown !== null) {
      const fire = resolveShutdown;
      resolveShutdown = null;
      fire();
    }
  };

  deps.onShutdownReady?.(requestShutdown);

  const uninstall = installSignalHandlers((signal) => {
    const sigName = SIGNAL_NAMES[signal];
    try {
      logger.info(`Received ${sigName}, initiating graceful shutdown`);
    } catch (error) {
      void error;
    }
    requestShutdown();
  });

  try {
    await startProductionServer(shutdownTrigger);
  } catch (exc) {
    if (isBrokenPipe(exc)) return;
    if (isKeyboardInterrupt(exc)) {
      try {
        logger.info('Shutdown requested by user');
      } catch (error) {
        void error;
      }
      return;
    }
    try {
      logger.error(`Application failed to start: ${getErrorMessage(exc)}`);
    } catch (error) {
      void error;
    }
    exit(1);
  } finally {
    uninstall();
  }
}

function defaultExit(code: number): never {
  process.exit(code);
}

function defaultIgnoreSigpipe(): void {
  if (process.platform !== 'win32') {
    process.on('SIGPIPE', () => undefined);
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

export class KeyboardInterruptError extends Error {
  constructor() {
    super('KeyboardInterrupt');
    this.name = 'KeyboardInterruptError';
  }
}

function isKeyboardInterrupt(exc: unknown): boolean {
  return exc instanceof KeyboardInterruptError;
}

function isBrokenPipe(exc: unknown): boolean {
  if (!exc || typeof exc !== 'object') return false;
  const code = (exc as { code?: unknown }).code;
  return code === 'EPIPE';
}
