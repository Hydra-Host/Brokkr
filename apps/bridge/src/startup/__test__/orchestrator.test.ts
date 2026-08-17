import { describe, expect, it, vi } from 'vitest';

import { StartupOrchestrator } from '../orchestrator.js';
import type { StartupLogger } from '../startup-deps.types.js';

function recordingLogger(): { logger: StartupLogger; lines: string[] } {
  const lines: string[] = [];
  const logger: StartupLogger = {
    info: (message) => {
      lines.push(`info:${message}`);
    },
    warn: (message) => {
      lines.push(`warn:${message}`);
    },
    error: (message) => {
      lines.push(`error:${message}`);
    },
    debug: () => undefined,
  };
  return { logger, lines };
}

async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe('StartupOrchestrator', () => {
  it('runs blocking tasks sequentially and rethrows failures', async () => {
    const order: string[] = [];
    const orchestrator = new StartupOrchestrator();
    orchestrator.addBlockingTask({
      name: 'first',
      run: async () => {
        order.push('first');
      },
    });
    orchestrator.addBlockingTask({
      name: 'explodes',
      run: async () => {
        order.push('explodes');
        throw new Error('boom');
      },
    });
    orchestrator.addBlockingTask({
      name: 'never',
      run: async () => {
        order.push('never');
      },
    });

    await expect(orchestrator.runBlockingTasks('job')).rejects.toThrow('boom');
    expect(order).toEqual(['first', 'explodes']);
  });

  it('starts background services without letting failures propagate', async () => {
    const orchestrator = new StartupOrchestrator();
    const started: string[] = [];
    orchestrator.addBackgroundService({
      name: 'sync-throws',
      start: () => {
        throw new Error('sync fail');
      },
      stop: () => undefined,
    });
    orchestrator.addBackgroundService({
      name: 'async-throws',
      start: async () => {
        throw new Error('async fail');
      },
      stop: () => undefined,
    });
    orchestrator.addBackgroundService({
      name: 'ok',
      start: () => {
        started.push('ok');
      },
      stop: () => undefined,
    });

    await orchestrator.startBackgroundServices('job');
    await new Promise((resolve) => setImmediate(resolve));
    expect(started).toEqual(['ok']);
  });

  it('stops started services in reverse order, surviving stop failures', async () => {
    const orchestrator = new StartupOrchestrator();
    const stopped: string[] = [];
    const make = (name: string, failStop = false) => ({
      name,
      start: () => undefined,
      stop: () => {
        stopped.push(name);
        if (failStop) throw new Error(`${name} stop failed`);
      },
    });
    orchestrator.addBackgroundService(make('a'));
    orchestrator.addBackgroundService(make('b', true));
    orchestrator.addBackgroundService(make('c'));

    await orchestrator.startBackgroundServices('job');
    await orchestrator.stopAll('job');
    expect(stopped).toEqual(['c', 'b', 'a']);

    stopped.length = 0;
    await orchestrator.stopAll('job');
    expect(stopped).toEqual([]);
  });

  it('does not stop services that never started', async () => {
    const orchestrator = new StartupOrchestrator();
    const stop = vi.fn();
    orchestrator.addBackgroundService({ name: 'unstarted', start: () => undefined, stop });
    await orchestrator.stopAll('job');
    expect(stop).not.toHaveBeenCalled();
  });
});

describe('StartupOrchestrator.runSupervised telemetry', () => {
  it('emits success + monitoring-confirmation lines when a supervised task returns', async () => {
    const { logger, lines } = recordingLogger();
    const orchestrator = new StartupOrchestrator(logger);
    orchestrator.addBackgroundService({
      name: 'returns-clean',
      start: async () => undefined,
      stop: () => undefined,
    });

    await orchestrator.startBackgroundServices('job');
    await flushMicrotasks();

    expect(lines).toContain("info:Background task 'returns-clean' execution started");
    expect(lines).toContain("info:Background task 'returns-clean' completed successfully");
    expect(lines).toContain("info:Background task 'returns-clean' monitoring confirms successful completion");
    expect(lines.some((l) => l.startsWith('warn:'))).toBe(false);
  });

  it('swallows an exception from start() and does NOT emit the success-monitoring line', async () => {
    const { logger, lines } = recordingLogger();
    const orchestrator = new StartupOrchestrator(logger);
    orchestrator.addBackgroundService({
      name: 'throws',
      start: async () => {
        throw new Error('boom');
      },
      stop: () => undefined,
    });

    await orchestrator.startBackgroundServices('job');
    await flushMicrotasks();

    expect(lines).toContain("warn:Background task 'throws' failed: boom");
    expect(lines).not.toContain("info:Background task 'throws' monitoring confirms successful completion");
  });

  it('emits cancellation telemetry when stopAll cancels a parked supervised task', async () => {
    const { logger, lines } = recordingLogger();
    const orchestrator = new StartupOrchestrator(logger);

    let releaseStart: (() => void) | null = null;
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });

    orchestrator.addBackgroundService({
      name: 'parked',
      start: () => startGate,
      stop: () => {
        if (releaseStart !== null) releaseStart();
      },
    });

    await orchestrator.startBackgroundServices('job');
    await flushMicrotasks();
    await orchestrator.stopAll('job');
    await flushMicrotasks();

    expect(lines).toContain("warn:Background task 'parked' was cancelled");
    expect(lines).toContain("warn:Background task 'parked' was cancelled externally");
    expect(lines).not.toContain("info:Background task 'parked' monitoring confirms successful completion");
  });
});
