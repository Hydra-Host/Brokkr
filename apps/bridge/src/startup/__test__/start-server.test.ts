import { describe, expect, it, vi } from 'vitest';

import { KeyboardInterruptError, startServer, type SyncLogger } from '../start-server.js';

function makeLogger(): { logger: SyncLogger; entries: Array<{ level: string; message: string }> } {
  const entries: Array<{ level: string; message: string }> = [];
  const logger: SyncLogger = {
    info: (m) => {
      entries.push({ level: 'info', message: m });
    },
    error: (m) => {
      entries.push({ level: 'error', message: m });
    },
  };
  return { logger, entries };
}

function noopSignalInstaller(): (handler: (signal: 'SIGTERM' | 'SIGINT') => void) => () => void {
  return () => () => undefined;
}

describe('startServer', () => {
  it('runs the production server with a shutdown trigger and ignores SIGPIPE', async () => {
    const { logger } = makeLogger();
    const ignoreSigpipe = vi.fn();
    const exit = vi.fn() as unknown as (code: number) => never;
    let captured: Promise<void> | null = null;
    await startServer({
      startProductionServer: async (trigger) => {
        captured = trigger;
      },
      logger,
      ignoreSigpipe,
      installSignalHandlers: noopSignalInstaller(),
      exit,
    });
    expect(ignoreSigpipe).toHaveBeenCalled();
    expect(captured).toBeInstanceOf(Promise);
    expect(exit).not.toHaveBeenCalled();
  });

  it('signal handler logs receipt and resolves shutdown trigger', async () => {
    const { logger, entries } = makeLogger();
    const exit = vi.fn() as unknown as (code: number) => never;
    let signalHandler: ((signal: 'SIGTERM' | 'SIGINT') => void) | null = null;
    let triggered = false;
    const pending = startServer({
      startProductionServer: async (trigger) => {
        void trigger.then(() => {
          triggered = true;
        });
        await trigger;
      },
      logger,
      ignoreSigpipe: () => undefined,
      installSignalHandlers: (h) => {
        signalHandler = h;
        return () => undefined;
      },
      exit,
    });
    await Promise.resolve();
    signalHandler!('SIGTERM');
    await pending;
    expect(triggered).toBe(true);
    expect(entries[0]).toEqual({ level: 'info', message: 'Received SIGTERM, initiating graceful shutdown' });
    expect(exit).not.toHaveBeenCalled();
  });

  it('treats a second signal during shutdown as an idempotent no-op', async () => {
    const { logger, entries } = makeLogger();
    const exit = vi.fn() as unknown as (code: number) => never;
    let signalHandler: ((signal: 'SIGTERM' | 'SIGINT') => void) | null = null;
    const pending = startServer({
      startProductionServer: async (trigger) => {
        await trigger;
      },
      logger,
      ignoreSigpipe: () => undefined,
      installSignalHandlers: (h) => {
        signalHandler = h;
        return () => undefined;
      },
      exit,
    });
    await Promise.resolve();
    signalHandler!('SIGTERM');
    await pending;
    signalHandler!('SIGINT');
    expect(exit).not.toHaveBeenCalled();
    expect(entries).toEqual([
      { level: 'info', message: 'Received SIGTERM, initiating graceful shutdown' },
      { level: 'info', message: 'Received SIGINT, initiating graceful shutdown' },
    ]);
  });

  it('swallows EPIPE without logging or exiting', async () => {
    const { logger, entries } = makeLogger();
    const exit = vi.fn() as unknown as (code: number) => never;
    const epipe = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    await startServer({
      startProductionServer: async () => {
        throw epipe;
      },
      logger,
      ignoreSigpipe: () => undefined,
      installSignalHandlers: noopSignalInstaller(),
      exit,
    });
    expect(entries).toEqual([]);
    expect(exit).not.toHaveBeenCalled();
  });

  it('logs Shutdown requested by user on KeyboardInterruptError', async () => {
    const { logger, entries } = makeLogger();
    const exit = vi.fn() as unknown as (code: number) => never;
    await startServer({
      startProductionServer: async () => {
        throw new KeyboardInterruptError();
      },
      logger,
      ignoreSigpipe: () => undefined,
      installSignalHandlers: noopSignalInstaller(),
      exit,
    });
    expect(entries).toEqual([{ level: 'info', message: 'Shutdown requested by user' }]);
    expect(exit).not.toHaveBeenCalled();
  });

  it('logs and exits 1 on any other server failure', async () => {
    const { logger, entries } = makeLogger();
    const exit = vi.fn() as unknown as (code: number) => never;
    await startServer({
      startProductionServer: async () => {
        throw new Error('boom');
      },
      logger,
      ignoreSigpipe: () => undefined,
      installSignalHandlers: noopSignalInstaller(),
      exit,
    });
    expect(entries).toEqual([{ level: 'error', message: 'Application failed to start: boom' }]);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('uninstalls signal handlers after the server returns', async () => {
    const { logger } = makeLogger();
    const exit = vi.fn() as unknown as (code: number) => never;
    const uninstall = vi.fn();
    await startServer({
      startProductionServer: async () => undefined,
      logger,
      ignoreSigpipe: () => undefined,
      installSignalHandlers: () => uninstall,
      exit,
    });
    expect(uninstall).toHaveBeenCalled();
  });
});
