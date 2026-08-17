import type { StartupLogger } from './startup-deps.types.js';

export interface ProcessExceptionLogger {
  error: StartupLogger['error'];
}

export interface ProcessExceptionHandlerOptions {
  // Shared with the signal path; idempotent, safe to invoke concurrently with a signal-triggered shutdown.
  requestShutdown?: () => void;
  exit?: (code: number) => void;
  // Exit never waits on shutdown completion (a hung shutdown must not strand the process); the timer stays referenced so exit(1) wins over a clean loop drain.
  forceExitDelayMs?: number;
  setForceExitTimer?: (fn: () => void, delayMs: number) => void;
}

const DEFAULT_FORCE_EXIT_DELAY_MS = 5_000;

export function setupProcessExceptionHandler(
  logger: ProcessExceptionLogger,
  options: ProcessExceptionHandlerOptions = {},
): void {
  const exit = options.exit ?? ((code: number): void => process.exit(code));
  const forceExitDelayMs = options.forceExitDelayMs ?? DEFAULT_FORCE_EXIT_DELAY_MS;
  const setForceExitTimer =
    options.setForceExitTimer ??
    ((fn: () => void, delayMs: number): void => {
      setTimeout(fn, delayMs);
    });

  let failingFast = false;
  const failFast = (): void => {
    if (failingFast) return;
    failingFast = true;
    try {
      options.requestShutdown?.();
    } catch {
      // A corrupted-state shutdown request must not mask the forced exit.
    }
    setForceExitTimer(() => exit(1), forceExitDelayMs);
  };

  process.on('uncaughtException', (error: Error, origin: string) => {
    try {
      logger.error(`Unhandled ${origin} exception: ${error.name}: ${error.message}`, { appClassName: 'process' });
    } catch {
      // Logger failure must not re-enter the uncaught-exception path.
    }
    failFast();
  });

  // Restores Node's default `--unhandled-rejections=throw` crash semantics (a log-only handler would suppress them).
  process.on('unhandledRejection', (reason: unknown) => {
    try {
      const name = reason instanceof Error ? reason.name : typeof reason;
      const message = reason instanceof Error ? reason.message : String(reason);
      logger.error(`Unhandled promise rejection: ${name}: ${message}`, { appClassName: 'process' });
    } catch {
      // Logger failure must not re-enter the unhandled-rejection path.
    }
    failFast();
  });
}
