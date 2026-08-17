import { Code, ConnectError } from '@connectrpc/connect';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PartialResult } from '../../gen/brokkr/agent/v1/work_pb';
import type { TransportPool } from '../pool';
import { createResultReporter } from '../result-reporter';

beforeEach(() => {
  vi.spyOn(Math, 'random').mockReturnValue(0);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function makePool(bridges: string[], handlers: Record<string, ReturnType<typeof vi.fn>>): TransportPool {
  return {
    listAddresses: () => bridges,
    getClient: (addr: string) => {
      const h = handlers[addr];
      if (!h) throw new Error(`no handler for ${addr}`);
      return { reportResult: h, reportProgress: h, reportPartialResult: h } as never;
    },
  } as unknown as TransportPool;
}

const samplePartial = {} as PartialResult;

describe('createResultReporter', () => {
  it('retries on retryable ConnectError and eventually succeeds on the same bridge', async () => {
    const handler = vi
      .fn()
      .mockRejectedValueOnce(new ConnectError('refused', Code.Internal))
      .mockRejectedValueOnce(new ConnectError('refused', Code.Internal))
      .mockResolvedValueOnce(undefined);
    const reporter = createResultReporter(makePool(['a'], { a: handler }));
    await reporter.reportPartialResult(samplePartial);
    expect(handler).toHaveBeenCalledTimes(3);
  });

  it('retries on message-sniffed transient errors (RST_STREAM not wrapped in ConnectError)', async () => {
    const handler = vi
      .fn()
      .mockRejectedValueOnce(new Error('Stream closed with error code NGHTTP2_REFUSED_STREAM'))
      .mockResolvedValueOnce(undefined);
    const reporter = createResultReporter(makePool(['a'], { a: handler }));
    await reporter.reportPartialResult(samplePartial);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry on non-retryable codes (e.g. Unauthenticated)', async () => {
    const handler = vi.fn().mockRejectedValue(new ConnectError('bad token', Code.Unauthenticated));
    const reporter = createResultReporter(makePool(['a'], { a: handler }));
    await expect(reporter.reportPartialResult(samplePartial)).rejects.toThrow(/all 1 bridges failed/);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry a non-retryable ConnectError even if its message matches the transient regex', async () => {
    const handler = vi.fn().mockRejectedValue(new ConnectError('upstream unavailable', Code.Unauthenticated));
    const reporter = createResultReporter(makePool(['a'], { a: handler }));
    await expect(reporter.reportPartialResult(samplePartial)).rejects.toThrow(/all 1 bridges failed/);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('exhausts retries on one bridge then falls through to the next', async () => {
    const a = vi.fn().mockRejectedValue(new ConnectError('overloaded', Code.Unavailable));
    const b = vi.fn().mockResolvedValue(undefined);
    const reporter = createResultReporter(makePool(['a', 'b'], { a, b }));
    await reporter.reportPartialResult(samplePartial);
    expect(a).toHaveBeenCalledTimes(9);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('all bridges + all retries exhausted → throws', async () => {
    const a = vi.fn().mockRejectedValue(new ConnectError('refused', Code.Internal));
    const b = vi.fn().mockRejectedValue(new ConnectError('refused', Code.Internal));
    const reporter = createResultReporter(makePool(['a', 'b'], { a, b }));
    await expect(reporter.reportPartialResult(samplePartial)).rejects.toThrow(/all 2 bridges failed/);
    expect(a).toHaveBeenCalledTimes(9);
    expect(b).toHaveBeenCalledTimes(9);
  });

  it('reportProgress swallows final failure but retries on the way', async () => {
    const handler = vi
      .fn()
      .mockRejectedValueOnce(new ConnectError('refused', Code.Internal))
      .mockResolvedValueOnce(undefined);
    const reporter = createResultReporter(makePool(['a'], { a: handler }));
    await reporter.reportProgress({ workId: 'w' } as never);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('retries on NGHTTP2_REFUSED_STREAM regardless of ConnectError code', async () => {
    const handler = vi
      .fn()
      .mockRejectedValueOnce(new ConnectError('Stream closed with error code NGHTTP2_REFUSED_STREAM', Code.Unknown))
      .mockResolvedValueOnce(undefined);
    const reporter = createResultReporter(makePool(['a'], { a: handler }));
    await reporter.reportPartialResult(samplePartial);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('retries on raw http2 error without ConnectError wrapping', async () => {
    const rawErr = Object.assign(new Error('Stream closed with error code NGHTTP2_REFUSED_STREAM'), {
      code: 'ERR_HTTP2_STREAM_ERROR',
    });
    const handler = vi.fn().mockRejectedValueOnce(rawErr).mockResolvedValueOnce(undefined);
    const reporter = createResultReporter(makePool(['a'], { a: handler }));
    await reporter.reportPartialResult(samplePartial);
    expect(handler).toHaveBeenCalledTimes(2);
  });
});
