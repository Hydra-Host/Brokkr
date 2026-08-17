import { afterEach, describe, expect, it, vi } from 'vitest';

import { HttpProbeService } from './http-probe.service';

const stubFetch = (impl: (url: string, opts: RequestInit) => Promise<unknown>) => vi.stubGlobal('fetch', vi.fn(impl));

const okResponse = (status: number) => ({ ok: status >= 200 && status < 300, status });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('HttpProbeService.probe', () => {
  it('reports ok with status and latency on a 2xx response', async () => {
    stubFetch(() => Promise.resolve(okResponse(200)));

    const result = await new HttpProbeService().probe('http://x/healthcheck');

    expect(result).toEqual({
      target: 'http://x/healthcheck',
      ok: true,
      statusCode: 200,
      latencyMs: expect.any(Number),
      detail: null,
    });
  });

  it('reports not-ok with the status on a non-2xx response', async () => {
    stubFetch(() => Promise.resolve(okResponse(503)));

    const result = await new HttpProbeService().probe('http://x/healthcheck');

    expect(result.ok).toBe(false);
    expect(result.statusCode).toBe(503);
    expect(result.latencyMs).toEqual(expect.any(Number));
    expect(result.detail).toMatch(/503/);
  });

  it('reports null status and latency with the error detail on a connection failure', async () => {
    stubFetch(() => Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:8080')));

    const result = await new HttpProbeService().probe('http://x/healthcheck');

    expect(result).toEqual({
      target: 'http://x/healthcheck',
      ok: false,
      statusCode: null,
      latencyMs: null,
      detail: 'connect ECONNREFUSED 127.0.0.1:8080',
    });
  });

  it('reports a timeout detail when the deadline rejects the fetch', async () => {
    stubFetch(() => Promise.reject(new DOMException('signal timed out', 'TimeoutError')));

    const result = await new HttpProbeService().probe('http://x/healthcheck');

    expect(result).toEqual({
      target: 'http://x/healthcheck',
      ok: false,
      statusCode: null,
      latencyMs: null,
      detail: 'timeout after 2000ms',
    });
  });

  it('fetches once when the first attempt succeeds', async () => {
    stubFetch(() => Promise.resolve(okResponse(200)));

    await new HttpProbeService().probe('http://x/healthcheck');

    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('retries once and reports ok when the second attempt succeeds', async () => {
    let calls = 0;
    stubFetch(() => {
      calls += 1;
      return calls === 1
        ? Promise.reject(new DOMException('signal timed out', 'TimeoutError'))
        : Promise.resolve(okResponse(200));
    });

    const result = await new HttpProbeService().probe('http://x/healthcheck');

    expect(result).toMatchObject({ ok: true, statusCode: 200 });
    expect(calls).toBe(2);
  });

  it('reports the retry failure after both attempts fail', async () => {
    stubFetch(() => Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:8080')));

    const result = await new HttpProbeService().probe('http://x/healthcheck');

    expect(result).toMatchObject({ ok: false, detail: 'connect ECONNREFUSED 127.0.0.1:8080' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('retries a non-2xx response once', async () => {
    let calls = 0;
    stubFetch(() => {
      calls += 1;
      return Promise.resolve(okResponse(calls === 1 ? 503 : 200));
    });

    const result = await new HttpProbeService().probe('http://x/healthcheck');

    expect(result).toMatchObject({ ok: true, statusCode: 200 });
    expect(calls).toBe(2);
  });
});
