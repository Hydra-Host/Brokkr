import { afterEach, describe, expect, it, vi } from 'vitest';

import { parseStepSeconds, ThanosBadQuery, ThanosService } from '../thanos.service';

const jsonResponse = (body: unknown, ok = true, statusCode = 200): Response =>
  ({ ok, status: statusCode, json: async () => body }) as Response;

function stubFetch(routes: Record<string, unknown>): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      const path = new URL(url).pathname + new URL(url).search;
      for (const [match, body] of Object.entries(routes)) {
        if (path.startsWith(match)) return Promise.resolve(jsonResponse(body));
      }
      throw new Error(`unstubbed fetch: ${path}`);
    }),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('ThanosService.query', () => {
  it('flattens a vector result into one sample per series', async () => {
    stubFetch({
      '/api/v1/query': {
        status: 'success',
        data: {
          resultType: 'vector',
          result: [{ metric: { __name__: 'up', job: 'x' }, value: [1000.5, '1'] }],
        },
      },
    });
    const res = await new ThanosService().query('up');
    expect(res.resultType).toBe('vector');
    expect(res.samples).toEqual([{ metric: { __name__: 'up', job: 'x' }, value: '1', timestamp: 1000.5 }]);
    expect(res.warnings).toEqual([]);
  });

  it('collapses a matrix result to each series’ latest point', async () => {
    stubFetch({
      '/api/v1/query': {
        status: 'success',
        data: {
          resultType: 'matrix',
          result: [
            {
              metric: { __name__: 'rate' },
              values: [
                [100, '1'],
                [200, '2'],
                [300, '3'],
              ],
            },
          ],
        },
      },
    });
    const res = await new ThanosService().query('rate(x[5m])');
    expect(res.samples).toEqual([{ metric: { __name__: 'rate' }, value: '3', timestamp: 300 }]);
  });

  it('represents a scalar result as a single label-less sample', async () => {
    stubFetch({ '/api/v1/query': { status: 'success', data: { resultType: 'scalar', result: [42, '4'] } } });
    const res = await new ThanosService().query('2+2');
    expect(res.resultType).toBe('scalar');
    expect(res.samples).toEqual([{ metric: {}, value: '4', timestamp: 42 }]);
  });

  it('throws ThanosBadQuery on a Prometheus error envelope', async () => {
    stubFetch({ '/api/v1/query': { status: 'error', errorType: 'bad_data', error: 'parse error' } });
    await expect(new ThanosService().query('cpu{')).rejects.toBeInstanceOf(ThanosBadQuery);
  });
});

describe('ThanosService.queryRange', () => {
  it('maps a matrix result to series preserving all points, their order, and metric labels', async () => {
    stubFetch({
      '/api/v1/query_range': {
        status: 'success',
        data: {
          resultType: 'matrix',
          result: [
            {
              metric: { __name__: 'rate', job: 'x' },
              values: [
                [100, '1'],
                [200, '2'],
                [300, '3'],
              ],
            },
            { metric: { __name__: 'rate', job: 'y' }, values: [[100, '9']] },
          ],
        },
      },
    });
    const res = await new ThanosService().queryRange('rate(x[5m])', '100', '300', '5m');
    expect(res.series).toEqual([
      {
        metric: { __name__: 'rate', job: 'x' },
        points: [
          [100, '1'],
          [200, '2'],
          [300, '3'],
        ],
      },
      { metric: { __name__: 'rate', job: 'y' }, points: [[100, '9']] },
    ]);
    expect(res.warnings).toEqual([]);
    const called = new URL(String(vi.mocked(globalThis.fetch).mock.calls[0]?.[0]));
    expect(called.pathname).toBe('/api/v1/query_range');
    expect(Object.fromEntries(called.searchParams)).toEqual({
      query: 'rate(x[5m])',
      start: '100',
      end: '300',
      step: '300s',
    });
  });

  it('passes warnings through from the envelope', async () => {
    stubFetch({
      '/api/v1/query_range': {
        status: 'success',
        warnings: ['partial response'],
        data: { resultType: 'matrix', result: [] },
      },
    });
    const res = await new ThanosService().queryRange('up', '0', '10', '1s');
    expect(res).toEqual({ series: [], warnings: ['partial response'] });
  });

  it('throws ThanosBadQuery on a Prometheus error envelope', async () => {
    stubFetch({ '/api/v1/query_range': { status: 'error', errorType: 'bad_data', error: 'parse error' } });
    await expect(new ThanosService().queryRange('cpu{', '0', '10', '1s')).rejects.toBeInstanceOf(ThanosBadQuery);
  });

  it.each(['abc', '0s'])('rejects step %s without fetching', async (step) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(new ThanosService().queryRange('up', '0', '10', step)).rejects.toBeInstanceOf(ThanosBadQuery);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a unix-seconds window too wide for the step without fetching', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(new ThanosService().queryRange('up', '0', '1000000', '1s')).rejects.toBeInstanceOf(ThanosBadQuery);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('parseStepSeconds', () => {
  it.each([
    ['30', 30],
    ['30s', 30],
    ['5m', 300],
    ['2h', 7200],
    ['1d', 86400],
  ])('parses %s to %d seconds', (step, expected) => {
    expect(parseStepSeconds(step)).toBe(expected);
  });
});

describe('ThanosService.status', () => {
  it('renders unbounded int64 store times as "—" and keeps real times', async () => {
    stubFetch({
      '/api/v1/status/buildinfo': { status: 'success', data: { version: '0.38.0' } },
      '/api/v1/stores': {
        status: 'success',
        data: {
          receive: [
            { name: '127.0.0.1:10901', lastError: null, minTime: 1782856593000, maxTime: 9.223372036854776e18 },
          ],
        },
      },
    });
    const res = await new ThanosService().status();
    expect(res.version).toBe('0.38.0');
    expect(res.stores).toEqual([
      { name: '127.0.0.1:10901', type: 'receive', minTime: '2026-06-30 21:56:33Z', maxTime: '—', lastError: null },
    ]);
  });
});

describe('ThanosService.metrics', () => {
  it('filters metric names case-insensitively by substring', async () => {
    stubFetch({
      '/api/v1/label/__name__/values': { status: 'success', data: ['cpu_usage', 'mem_used', 'CPU_temp'] },
    });
    expect(await new ThanosService().metrics('cpu')).toEqual(['CPU_temp', 'cpu_usage']);
  });

  it('returns names sorted, per the contract', async () => {
    stubFetch({
      '/api/v1/label/__name__/values': { status: 'success', data: ['mem_used', 'cpu_usage', 'disk_io'] },
    });
    expect(await new ThanosService().metrics()).toEqual(['cpu_usage', 'disk_io', 'mem_used']);
  });
});
