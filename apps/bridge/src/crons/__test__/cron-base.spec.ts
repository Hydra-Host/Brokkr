import { afterEach, describe, expect, it, vi } from 'vitest';

import * as logger from '../../logger/logger.service.js';
import {
  PeriodicTask,
  resetStopGraceMsForTests,
  resetUniformRandomForTests,
  setStopGraceMsForTests,
  setUniformRandomForTests,
  type CronSpec,
} from '../cron-base.js';

function makeSpec(overrides: Partial<CronSpec> & Pick<CronSpec, 'run'>): CronSpec {
  return {
    name: 'test_cron',
    intervalMs: 10,
    ...overrides,
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

afterEach(() => {
  resetStopGraceMsForTests();
  resetUniformRandomForTests();
});

describe('PeriodicTask', () => {
  it('invokes run repeatedly at the configured interval', async () => {
    let calls = 0;
    const task = new PeriodicTask(
      makeSpec({
        run: async () => {
          calls += 1;
        },
        intervalMs: 10,
      }),
    );
    await task.start();
    await sleep(120);
    await task.stop();
    expect(calls).toBeGreaterThanOrEqual(3);
    expect(task.state.lastSuccessAt).not.toBeNull();
    expect(task.state.consecutiveFailures).toBe(0);
  });

  it('initialDelay postpones the first run', async () => {
    let calls = 0;
    const task = new PeriodicTask(
      makeSpec({
        run: async () => {
          calls += 1;
        },
        intervalMs: 5,
        initialDelayMs: 40,
      }),
    );
    await task.start();
    await sleep(15);
    expect(calls).toBe(0);
    await sleep(60);
    await task.stop();
    expect(calls).toBeGreaterThanOrEqual(1);
  });

  it('isolates exceptions and counts consecutive failures', async () => {
    let invocations = 0;
    const task = new PeriodicTask(
      makeSpec({
        run: async () => {
          invocations += 1;
          throw new Error(`boom ${invocations}`);
        },
        intervalMs: 10,
      }),
    );
    await task.start();
    await sleep(60);
    await task.stop();
    expect(invocations).toBeGreaterThanOrEqual(2);
    expect(task.state.lastError).not.toBeNull();
    expect(task.state.lastError).toContain('boom');
    expect(task.state.consecutiveFailures).toBeGreaterThanOrEqual(2);
    expect(task.state.lastRunAt).not.toBeNull();
    expect(task.state.lastSuccessAt).toBeNull();
  });

  it('clears lastError and resets counter after a successful iteration', async () => {
    let invocations = 0;
    const task = new PeriodicTask(
      makeSpec({
        run: async () => {
          invocations += 1;
          if (invocations <= 2) {
            throw new Error('transient');
          }
        },
        intervalMs: 10,
      }),
    );
    await task.start();
    await sleep(80);
    await task.stop();
    expect(invocations).toBeGreaterThanOrEqual(3);
    expect(task.state.lastError).toBeNull();
    expect(task.state.consecutiveFailures).toBe(0);
    expect(task.state.lastSuccessAt).not.toBeNull();
  });

  it('counts a timeout as a failure', async () => {
    let invocations = 0;
    const task = new PeriodicTask(
      makeSpec({
        run: async () => {
          invocations += 1;
          await sleep(1000);
        },
        intervalMs: 10,
        timeoutMs: 20,
      }),
    );
    await task.start();
    await sleep(80);
    await task.stop();
    expect(invocations).toBeGreaterThanOrEqual(1);
    expect(task.state.consecutiveFailures).toBeGreaterThanOrEqual(1);
    expect(task.state.lastError).not.toBeNull();
  });

  it('enabledWhen returning false skips the iteration silently', async () => {
    let calls = 0;
    let gateValue = false;
    const task = new PeriodicTask(
      makeSpec({
        run: async () => {
          calls += 1;
        },
        intervalMs: 10,
        enabledWhen: () => gateValue,
      }),
    );
    await task.start();
    await sleep(40);
    expect(calls).toBe(0);
    expect(task.state.lastRunAt).toBeNull();
    expect(task.state.lastSuccessAt).toBeNull();
    expect(task.state.consecutiveFailures).toBe(0);

    gateValue = true;
    await sleep(50);
    await task.stop();
    expect(calls).toBeGreaterThanOrEqual(1);
    expect(task.state.lastRunAt).not.toBeNull();
  });

  it('enabledWhen raising is logged and skips the iteration', async () => {
    let calls = 0;
    const task = new PeriodicTask(
      makeSpec({
        run: async () => {
          calls += 1;
        },
        intervalMs: 10,
        enabledWhen: () => {
          throw new Error('gate broken');
        },
      }),
    );
    await task.start();
    await sleep(50);
    await task.stop();
    expect(calls).toBe(0);
    expect(task.state.lastRunAt).toBeNull();
  });

  it('stop is idempotent and safe before start', async () => {
    const task = new PeriodicTask(makeSpec({ run: async () => undefined }));
    await task.stop();
    await task.start();
    await task.stop();
    await task.stop();
  });

  it('calling start twice raises', async () => {
    const task = new PeriodicTask(makeSpec({ run: async () => undefined }));
    await task.start();
    try {
      await expect(task.start()).rejects.toThrow(/already started/);
    } finally {
      await task.stop();
    }
  });

  it('jitter is applied via uniform random on [-jitter, +jitter]', () => {
    const calls: Array<[number, number]> = [];
    setUniformRandomForTests((min, max) => {
      calls.push([min, max]);
      return 0.005;
    });
    const task = new PeriodicTask(
      makeSpec({
        run: async () => undefined,
        intervalMs: 100,
        jitterMs: 20,
      }),
    );
    const before = Date.now();
    const nextRun = task.computeNextRun();
    expect(calls).toEqual([[-0.02, 0.02]]);
    expect(nextRun.getTime()).toBeGreaterThanOrEqual(before);
  });

  it('jitter is clamped so next-run is never in the past', () => {
    setUniformRandomForTests(() => -0.5);
    const task = new PeriodicTask(
      makeSpec({
        run: async () => undefined,
        intervalMs: 10,
        jitterMs: 100,
      }),
    );
    const before = Date.now();
    const nextRun = task.computeNextRun();
    expect(nextRun.getTime()).toBeGreaterThanOrEqual(before);
    expect(nextRun.getTime()).toBeLessThanOrEqual(Date.now() + 5);
  });

  it('stop returns within the grace window when a run is stuck', async () => {
    const started = { value: false };
    const task = new PeriodicTask(
      makeSpec({
        run: async () => {
          started.value = true;
          await sleep(60_000);
        },
        intervalMs: 5,
      }),
    );
    setStopGraceMsForTests(50);
    await task.start();
    const deadline = Date.now() + 1000;
    while (!started.value && Date.now() < deadline) {
      await sleep(5);
    }
    expect(started.value).toBe(true);
    const before = Date.now();
    await task.stop();
    const elapsed = Date.now() - before;
    expect(elapsed).toBeLessThan(500);
  });

  it('aborts the run signal when the iteration times out', async () => {
    let captured: AbortSignal | undefined;
    const abortMessages: string[] = [];
    const task = new PeriodicTask(
      makeSpec({
        run: async (signal) => {
          captured = signal;
          await new Promise<void>((_, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')));
          }).catch((error: unknown) => {
            if (error instanceof Error) abortMessages.push(error.message);
            throw error;
          });
        },
        intervalMs: 10,
        timeoutMs: 20,
      }),
    );
    await task.start();
    await sleep(80);
    await task.stop();
    expect(captured).toBeDefined();
    expect(captured!.aborted).toBe(true);
    expect(abortMessages.some((m) => m.includes('exceeded'))).toBe(true);
  });

  it('stop() aborts the in-flight run signal (cooperative shutdown cancellation)', async () => {
    let captured: AbortSignal | undefined;
    const task = new PeriodicTask(
      makeSpec({
        run: async (signal) => {
          captured = signal;
          await new Promise<void>((resolve) => {
            signal.addEventListener('abort', () => resolve());
          });
        },
        intervalMs: 10,
      }),
    );
    await task.start();
    for (let i = 0; i < 50 && captured === undefined; i += 1) await sleep(5);
    expect(captured).toBeDefined();
    expect(captured!.aborted).toBe(false);

    await task.stop();

    expect(captured!.aborted).toBe(true);
    expect((captured!.reason as Error)?.message).toContain('shutting down');
  });

  it('passes a non-aborted signal when no timeout is configured', async () => {
    let captured: AbortSignal | undefined;
    const task = new PeriodicTask(
      makeSpec({
        run: async (signal) => {
          captured = signal;
        },
        intervalMs: 10,
      }),
    );
    await task.start();
    await sleep(30);
    await task.stop();
    expect(captured).toBeDefined();
    expect(captured!.aborted).toBe(false);
  });

  it('nextRunAt advances between iterations', async () => {
    const seen: Array<Date | null> = [];
    const task = new PeriodicTask(
      makeSpec({
        run: async () => {
          seen.push(task.state.nextRunAt);
        },
        intervalMs: 10,
      }),
    );
    await task.start();
    await sleep(50);
    await task.stop();
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen[0]).not.toBeNull();
    expect(seen[1]!.getTime()).toBeGreaterThan(seen[0]!.getTime());
  });
});

describe('PeriodicTask — orphan-tail (post-timeout) logging', () => {
  const orphanCall = (spy: ReturnType<typeof vi.spyOn>, pattern: RegExp): boolean =>
    spy.mock.calls.some(
      ([msg, ctx]) => pattern.test(String(msg)) && (ctx as { jobId?: string })?.jobId === 'cron-test_cron',
    );

  it('logs orphan-completed when a timed-out run later resolves', async () => {
    const infoSpy = vi.spyOn(logger, 'logInfo').mockResolvedValue(undefined);
    try {
      const task = new PeriodicTask(
        makeSpec({
          run: async () => {
            await sleep(40);
          },
          intervalMs: 10,
          timeoutMs: 20,
        }),
      );
      await task.start();
      await sleep(120);
      await task.stop();
      expect(orphanCall(infoSpy, /orphan iteration \(post-timeout\) completed successfully/)).toBe(true);
    } finally {
      infoSpy.mockRestore();
    }
  });

  it('logs orphan-failed when a timed-out run later rejects', async () => {
    const errSpy = vi.spyOn(logger, 'logError').mockResolvedValue(undefined);
    try {
      const task = new PeriodicTask(
        makeSpec({
          run: async () => {
            await sleep(40);
            throw new Error('late boom');
          },
          intervalMs: 10,
          timeoutMs: 20,
        }),
      );
      await task.start();
      await sleep(120);
      await task.stop();
      expect(orphanCall(errSpy, /orphan iteration \(post-timeout\) failed/)).toBe(true);
    } finally {
      errSpy.mockRestore();
    }
  });
});
