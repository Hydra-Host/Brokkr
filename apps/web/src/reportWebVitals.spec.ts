import { contract, ReportWebVitalsRequestSchema, type ReportWebVitalsRequest } from '@repo/api-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import reportWebVitals from './reportWebVitals';

const { callbacks } = vi.hoisted(() => {
  const callbacks: Record<string, (metric: unknown) => void> = {};
  return { callbacks };
});
vi.mock('web-vitals', () => ({
  onCLS: (cb: (metric: unknown) => void) => {
    callbacks.CLS = cb;
  },
  onINP: (cb: (metric: unknown) => void) => {
    callbacks.INP = cb;
  },
  onFCP: (cb: (metric: unknown) => void) => {
    callbacks.FCP = cb;
  },
  onLCP: (cb: (metric: unknown) => void) => {
    callbacks.LCP = cb;
  },
  onTTFB: (cb: (metric: unknown) => void) => {
    callbacks.TTFB = cb;
  },
}));

const sendBeacon = vi.fn<(url: string, data?: BodyInit | null) => boolean>(() => true);

const beaconBodies: string[] = [];
class CapturingBlob extends Blob {
  constructor(parts?: BlobPart[], options?: BlobPropertyBag) {
    super(parts, options);
    for (const part of parts ?? []) {
      if (typeof part === 'string') beaconBodies.push(part);
    }
  }
}

function sentPayload(callIndex: number): ReportWebVitalsRequest {
  const body = beaconBodies[callIndex];
  if (body === undefined) throw new Error('no beacon body captured');
  return ReportWebVitalsRequestSchema.parse(JSON.parse(body));
}

function makeMetric(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    name: 'LCP',
    value: 1234.5,
    rating: 'good',
    delta: 1234.5,
    id: 'v5-lcp-1',
    entries: [],
    navigationType: 'navigate',
    ...overrides,
  };
}

describe('reportWebVitals', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    sendBeacon.mockClear();
    beaconBodies.length = 0;
    vi.stubGlobal('Blob', CapturingBlob);
    Object.defineProperty(navigator, 'sendBeacon', { value: sendBeacon, configurable: true, writable: true });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('flushes the buffer to the contract path after the idle debounce', () => {
    reportWebVitals({ state: { matches: [{ routeId: '__root__' }, { routeId: '/servers/$serverId' }] } });
    callbacks.LCP?.(makeMetric());
    expect(sendBeacon).not.toHaveBeenCalled();

    vi.advanceTimersByTime(10_000);
    expect(sendBeacon).toHaveBeenCalledTimes(1);
    expect(sendBeacon.mock.calls[0]?.[0]).toBe(contract.reportWebVitals.path);
    expect(sentPayload(0).metrics).toEqual([
      {
        name: 'LCP',
        value: 1234.5,
        rating: 'good',
        delta: 1234.5,
        id: 'v5-lcp-1',
        route: '/servers/$serverId',
      },
    ]);
  });

  it('supersedes a buffered value for the same metric instance id', () => {
    reportWebVitals({ state: { matches: [{ routeId: '/deployments' }] } });
    callbacks.CLS?.(makeMetric({ name: 'CLS', id: 'v5-cls-1', value: 0.02, delta: 0.02, rating: 'good' }));
    callbacks.CLS?.(makeMetric({ name: 'CLS', id: 'v5-cls-1', value: 0.12, delta: 0.1, rating: 'needs-improvement' }));

    vi.advanceTimersByTime(10_000);
    expect(sendBeacon).toHaveBeenCalledTimes(1);
    const payload = sentPayload(0);
    expect(payload.metrics).toHaveLength(1);
    expect(payload.metrics[0]).toMatchObject({ name: 'CLS', value: 0.12, rating: 'needs-improvement' });
  });

  it('flushes immediately when the page becomes hidden and falls back to an unknown route', () => {
    reportWebVitals({ state: { matches: [] } });
    callbacks.TTFB?.(makeMetric({ name: 'TTFB', id: 'v5-ttfb-1', value: 220, delta: 220 }));

    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(sendBeacon).toHaveBeenCalledTimes(1);
    expect(sentPayload(0).metrics[0]).toMatchObject({ name: 'TTFB', route: 'unknown' });

    vi.advanceTimersByTime(10_000);
    expect(sendBeacon).toHaveBeenCalledTimes(1);
  });

  it('reports each metric instance at most once across flushes', () => {
    reportWebVitals({ state: { matches: [{ routeId: '/deployments' }] } });
    callbacks.CLS?.(makeMetric({ name: 'CLS', id: 'v5-cls-1', value: 0.05, delta: 0.05 }));

    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(sendBeacon).toHaveBeenCalledTimes(1);

    callbacks.CLS?.(makeMetric({ name: 'CLS', id: 'v5-cls-1', value: 0.12, delta: 0.07 }));
    document.dispatchEvent(new Event('visibilitychange'));
    vi.advanceTimersByTime(10_000);
    expect(sendBeacon).toHaveBeenCalledTimes(1);
  });

  it('swallows beacon failures instead of throwing into the app', () => {
    reportWebVitals({ state: { matches: [{ routeId: '/deployments' }] } });
    callbacks.FCP?.(makeMetric({ name: 'FCP', id: 'v5-fcp-1' }));
    sendBeacon.mockImplementationOnce(() => {
      throw new Error('beacon rejected');
    });
    expect(() => vi.advanceTimersByTime(10_000)).not.toThrow();
  });

  it('keeps metrics buffered when sendBeacon reports the beacon was not queued', () => {
    reportWebVitals({ state: { matches: [{ routeId: '/deployments' }] } });
    callbacks.LCP?.(makeMetric({ name: 'LCP', id: 'v5-lcp-1' }));

    sendBeacon.mockReturnValueOnce(false);
    vi.advanceTimersByTime(10_000);
    expect(sendBeacon).toHaveBeenCalledTimes(1);

    callbacks.CLS?.(makeMetric({ name: 'CLS', id: 'v5-cls-1', value: 0.02, delta: 0.02, rating: 'good' }));
    vi.advanceTimersByTime(10_000);
    expect(sendBeacon).toHaveBeenCalledTimes(2);
    expect(
      sentPayload(1)
        .metrics.map((m) => m.id)
        .sort(),
    ).toEqual(['v5-cls-1', 'v5-lcp-1']);
  });
});
