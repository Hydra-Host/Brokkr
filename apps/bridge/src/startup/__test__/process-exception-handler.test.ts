import { afterEach, describe, expect, it, vi } from 'vitest';

import { setupProcessExceptionHandler, type ProcessExceptionHandlerOptions } from '../process-exception-handler.js';

const installed: {
  events: Array<'uncaughtException' | 'unhandledRejection'>;
  listeners: Array<(...args: unknown[]) => void>;
} = {
  events: [],
  listeners: [],
};

const originalOn = process.on.bind(process);

afterEach(() => {
  for (let i = 0; i < installed.events.length; i += 1) {
    process.off(installed.events[i], installed.listeners[i] as never);
  }
  installed.events.length = 0;
  installed.listeners.length = 0;
});

function trackOn<E extends 'uncaughtException' | 'unhandledRejection'>(
  event: E,
  listener: (...args: unknown[]) => void,
): void {
  installed.events.push(event);
  installed.listeners.push(listener);
  originalOn(event, listener as never);
}

interface CapturedHandlers {
  uncaught: (err: Error, origin: string) => void;
  unhandled: (reason: unknown) => void;
}

function install(
  logger: { error: (m: string, ctx?: { appClassName?: string }) => void },
  options: ProcessExceptionHandlerOptions,
): CapturedHandlers {
  const original = process.on.bind(process);
  let uncaught: ((err: Error, origin: string) => void) | null = null;
  let unhandled: ((reason: unknown) => void) | null = null;
  process.on = ((event: string, listener: (...args: unknown[]) => void) => {
    if (event === 'uncaughtException') uncaught = listener as never;
    else if (event === 'unhandledRejection') unhandled = listener as never;
    trackOn(event as never, listener);
    return process;
  }) as typeof process.on;

  try {
    setupProcessExceptionHandler(logger, options);
  } finally {
    process.on = original;
  }

  expect(uncaught).not.toBeNull();
  expect(unhandled).not.toBeNull();
  return { uncaught: uncaught!, unhandled: unhandled! };
}

function makeFatalSpies(): {
  options: ProcessExceptionHandlerOptions;
  shutdownCalls: number;
  exitCodes: number[];
  exitDelays: number[];
} {
  const state = { shutdownCalls: 0, exitCodes: [] as number[], exitDelays: [] as number[] };
  return {
    get shutdownCalls() {
      return state.shutdownCalls;
    },
    get exitCodes() {
      return state.exitCodes;
    },
    get exitDelays() {
      return state.exitDelays;
    },
    options: {
      requestShutdown: () => {
        state.shutdownCalls += 1;
      },
      exit: (code: number) => {
        state.exitCodes.push(code);
      },
      setForceExitTimer: (fn: () => void, delayMs: number) => {
        state.exitDelays.push(delayMs);
        fn();
      },
    },
  };
}

describe('setupProcessExceptionHandler', () => {
  it('routes uncaughtException through logger.error with appClassName="process"', () => {
    const events: Array<{ msg: string; ctx?: { appClassName?: string } }> = [];
    const logger = {
      error: (m: string, ctx?: { appClassName?: string }) => {
        events.push({ msg: m, ctx });
      },
    };
    const spies = makeFatalSpies();
    const { uncaught, unhandled } = install(logger, spies.options);

    uncaught(Object.assign(new Error('boom'), { name: 'TypeError' }), 'uncaughtException');
    expect(events).toEqual([
      { msg: 'Unhandled uncaughtException exception: TypeError: boom', ctx: { appClassName: 'process' } },
    ]);

    events.length = 0;
    unhandled(new Error('promise-boom'));
    expect(events).toEqual([
      { msg: 'Unhandled promise rejection: Error: promise-boom', ctx: { appClassName: 'process' } },
    ]);

    events.length = 0;
    unhandled('not-an-error');
    expect(events).toEqual([
      { msg: 'Unhandled promise rejection: string: not-an-error', ctx: { appClassName: 'process' } },
    ]);
  });

  it('fails fast on uncaughtException: requests graceful shutdown then exits non-zero', () => {
    const spies = makeFatalSpies();
    const { uncaught } = install({ error: () => undefined }, spies.options);

    uncaught(new Error('boom'), 'uncaughtException');

    expect(spies.shutdownCalls).toBe(1);
    expect(spies.exitCodes).toEqual([1]);
  });

  it('fails fast on unhandledRejection via the same shutdown-then-exit path', () => {
    const spies = makeFatalSpies();
    const { unhandled } = install({ error: () => undefined }, spies.options);

    unhandled(new Error('promise-boom'));

    expect(spies.shutdownCalls).toBe(1);
    expect(spies.exitCodes).toEqual([1]);
  });

  it('is idempotent: a second fatal event does not re-trigger shutdown or stack another exit', () => {
    const spies = makeFatalSpies();
    const { uncaught, unhandled } = install({ error: () => undefined }, spies.options);

    uncaught(new Error('first'), 'uncaughtException');
    unhandled(new Error('second'));
    uncaught(new Error('third'), 'uncaughtException');

    expect(spies.shutdownCalls).toBe(1);
    expect(spies.exitCodes).toEqual([1]);
  });

  it('still fails fast when no shutdown trigger is wired (exit is unconditional)', () => {
    const exitCodes: number[] = [];
    const { uncaught } = install(
      { error: () => undefined },
      {
        exit: (code) => {
          exitCodes.push(code);
        },
        setForceExitTimer: (fn) => fn(),
      },
    );

    uncaught(new Error('boom'), 'uncaughtException');
    expect(exitCodes).toEqual([1]);
  });

  it('swallows logger failures but still fails fast', () => {
    const spies = makeFatalSpies();
    const { uncaught, unhandled } = install(
      {
        error: () => {
          throw new Error('logger broken');
        },
      },
      spies.options,
    );

    expect(() => uncaught(new Error('boom'), 'uncaughtException')).not.toThrow();
    expect(spies.exitCodes).toEqual([1]);

    expect(() => unhandled(new Error('boom'))).not.toThrow();
  });

  it('a corrupted-state shutdown request must not mask the forced exit', () => {
    const exitCodes: number[] = [];
    const { uncaught } = install(
      { error: () => undefined },
      {
        requestShutdown: () => {
          throw new Error('shutdown trigger exploded');
        },
        exit: (code) => {
          exitCodes.push(code);
        },
        setForceExitTimer: (fn) => fn(),
      },
    );

    expect(() => uncaught(new Error('boom'), 'uncaughtException')).not.toThrow();
    expect(exitCodes).toEqual([1]);
  });

  it('forces a single non-zero exit via the real backstop timer when graceful shutdown never completes', () => {
    vi.useFakeTimers();
    try {
      const exitCodes: number[] = [];
      const { uncaught } = install(
        { error: () => undefined },
        {
          requestShutdown: () => {
          },
          exit: (code) => {
            exitCodes.push(code);
          },
          forceExitDelayMs: 5_000,
        },
      );

      uncaught(new Error('boom'), 'uncaughtException');

      expect(exitCodes).toEqual([]);
      vi.advanceTimersByTime(4_999);
      expect(exitCodes).toEqual([]);

      vi.advanceTimersByTime(1);
      expect(exitCodes).toEqual([1]);

      vi.advanceTimersByTime(60_000);
      expect(exitCodes).toEqual([1]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves the default backstop timer referenced so a clean drain cannot pre-empt the non-zero exit', () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const { uncaught } = install(
        { error: () => undefined },
        {
          requestShutdown: () => undefined,
          exit: () => undefined,
          forceExitDelayMs: 5_000,
        },
      );

      uncaught(new Error('boom'), 'uncaughtException');

      expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 5_000);

      timer = setTimeoutSpy.mock.results[0]?.value as ReturnType<typeof setTimeout>;
      const refState = timer as unknown as { hasRef?: () => boolean };
      expect(typeof refState.hasRef).toBe('function');
      expect(refState.hasRef?.()).toBe(true);
    } finally {
      if (timer) clearTimeout(timer);
      setTimeoutSpy.mockRestore();
    }
  });
});
