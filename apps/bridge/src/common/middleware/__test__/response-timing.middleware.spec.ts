import { AsyncResource } from 'node:async_hooks';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ContextLogger } from '../../../logger/logger.service';
import { AccessLogMiddleware, type AccessLogRequest, type AccessLogResponse } from '../access-log.middleware';
import { ResponseTimingMiddleware, getResponseTimingDuration } from '../response-timing.middleware';

function makeResponse(statusCode = 200): AccessLogResponse & { fire(event: 'finish' | 'close'): void } {
  const listeners: Record<string, Array<() => void>> = { finish: [], close: [] };
  return {
    statusCode,
    on(event: 'finish' | 'close', listener: () => void) {
      const bound = AsyncResource.bind(listener);
      listeners[event].push(bound);
      return this;
    },
    fire(event: 'finish' | 'close') {
      for (const l of listeners[event]) l();
    },
  };
}

function makeRequest(): AccessLogRequest {
  return { method: 'GET', url: '/health', headers: { host: 'localhost' } };
}

function mockHrtime(...readingsNs: bigint[]): ReturnType<typeof vi.spyOn> {
  const queue = [...readingsNs];
  return vi
    .spyOn(process.hrtime, 'bigint')
    .mockImplementation(() => queue.shift() ?? readingsNs[readingsNs.length - 1]);
}

describe('getResponseTimingDuration', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns 0 (rounded) outside any ResponseTimingMiddleware frame', () => {
    expect(getResponseTimingDuration()).toBe(0);
  });

  it('measures elapsed seconds within the ALS frame', () => {
    mockHrtime(0n, 1_250_000_000n);
    const mw = new ResponseTimingMiddleware();
    let observed = -1;
    mw.use({}, {}, () => {
      observed = getResponseTimingDuration();
    });
    expect(observed).toBe(1.25);
  });

  it('never returns a negative duration if the clock reads backwards/equal', () => {
    mockHrtime(5_000_000_000n, 5_000_000_000n);
    const mw = new ResponseTimingMiddleware();
    let observed = -1;
    mw.use({}, {}, () => {
      observed = getResponseTimingDuration();
    });
    expect(observed).toBe(0);
    expect(observed).toBeGreaterThanOrEqual(0);
  });
});

describe('ResponseTimingMiddleware -> AccessLogMiddleware wiring', () => {
  let debug: ReturnType<typeof vi.fn>;
  let logger: ContextLogger;

  beforeEach(() => {
    debug = vi.fn().mockResolvedValue(undefined);
    logger = { debug, info: vi.fn().mockResolvedValue(undefined) } as unknown as ContextLogger;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('emits a total-duration line sourced from getResponseTimingDuration', () => {
    mockHrtime(0n, 0n, 2_000_000_000n, 2_000_000_000n);

    const timing = new ResponseTimingMiddleware();
    const access = new AccessLogMiddleware(logger);
    const req = makeRequest();
    const res = makeResponse();

    timing.use(req, res, () => {
      access.use(req, res, () => {});
    });

    res.fire('finish');

    const messages = debug.mock.calls.map((c) => String(c[0]));
    const totalLine = messages.find((m) => m.includes('total'));
    expect(totalLine).toBeDefined();
    expect(totalLine).toContain('total 2.0s');
  });
});
