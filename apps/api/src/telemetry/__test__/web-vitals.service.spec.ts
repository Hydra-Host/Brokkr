import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WebVitalsService } from '../web-vitals.service';

const { histogramCreated, histogramRecord } = vi.hoisted(() => ({
  histogramCreated: vi.fn(),
  histogramRecord: vi.fn(),
}));
vi.mock('@repo/telemetry', () => ({
  getTelemetryMeter: () => ({
    createHistogram: (name: string, options?: Record<string, unknown>) => {
      histogramCreated(name, options);
      return {
        record: (value: number, attributes?: Record<string, unknown>) => histogramRecord(name, value, attributes),
      };
    },
  }),
}));

describe('WebVitalsService', () => {
  beforeEach(() => {
    histogramCreated.mockClear();
    histogramRecord.mockClear();
  });

  it('creates the five spec-named histograms with explicit bucket advice', () => {
    new WebVitalsService();
    const created = new Map<string, { advice?: { explicitBucketBoundaries?: number[] } }>(
      histogramCreated.mock.calls.map(([name, options]) => [name, options]),
    );
    expect([...created.keys()].sort()).toEqual([
      'brokkr.web_vitals.cls',
      'brokkr.web_vitals.fcp',
      'brokkr.web_vitals.inp',
      'brokkr.web_vitals.lcp',
      'brokkr.web_vitals.ttfb',
    ]);
    expect(created.get('brokkr.web_vitals.lcp')?.advice?.explicitBucketBoundaries).toEqual([
      100, 200, 400, 800, 1200, 1800, 2500, 4000, 6000, 10000,
    ]);
    expect(created.get('brokkr.web_vitals.inp')?.advice?.explicitBucketBoundaries).toEqual([
      8, 16, 40, 75, 100, 200, 300, 500, 1000,
    ]);
    expect(created.get('brokkr.web_vitals.cls')?.advice?.explicitBucketBoundaries).toEqual([
      0.01, 0.025, 0.05, 0.1, 0.15, 0.25, 0.5, 1,
    ]);
    expect(created.get('brokkr.web_vitals.fcp')?.advice?.explicitBucketBoundaries).toEqual([
      100, 200, 400, 800, 1200, 1800, 2500, 3000, 4000, 6000, 10000,
    ]);
  });

  it('records each metric to its name-matched histogram with rating/route attributes', () => {
    const service = new WebVitalsService();
    const result = service.record([
      {
        name: 'LCP',
        value: 1830.4,
        rating: 'needs-improvement',
        delta: 1830.4,
        id: 'v5-lcp',
        route: '/servers/$serverId',
      },
      { name: 'CLS', value: 0.04, rating: 'good', delta: 0.02, id: 'v5-cls', route: '/deployments' },
      { name: 'TTFB', value: 220, rating: 'good', delta: 220, id: 'v5-ttfb', route: '/deployments' },
    ]);
    expect(result).toEqual({ accepted: 3 });
    expect(histogramRecord).toHaveBeenCalledTimes(3);
    expect(histogramRecord).toHaveBeenCalledWith('brokkr.web_vitals.lcp', 1830.4, {
      rating: 'needs-improvement',
      route: '/servers/$serverId',
    });
    expect(histogramRecord).toHaveBeenCalledWith('brokkr.web_vitals.cls', 0.04, {
      rating: 'good',
      route: '/deployments',
    });
    expect(histogramRecord).toHaveBeenCalledWith('brokkr.web_vitals.ttfb', 220, {
      rating: 'good',
      route: '/deployments',
    });
  });

  it('accepts an empty batch without recording', () => {
    const service = new WebVitalsService();
    expect(service.record([])).toEqual({ accepted: 0 });
    expect(histogramRecord).not.toHaveBeenCalled();
  });

  describe('route label bounding', () => {
    const metric = (route: string) => ({
      name: 'LCP' as const,
      value: 1000,
      rating: 'good' as const,
      delta: 1000,
      id: 'v5-lcp',
      route,
    });

    it("normalizes a route that is not shaped like a route template id to 'invalid'", () => {
      const service = new WebVitalsService();
      service.record([metric('/servers?q=<script>')]);
      expect(histogramRecord).toHaveBeenCalledWith('brokkr.web_vitals.lcp', 1000, {
        rating: 'good',
        route: 'invalid',
      });
    });

    it("caps distinct route labels, folding overflow into 'other' while known routes pass through", () => {
      const service = new WebVitalsService();
      for (let i = 0; i < 200; i++) {
        service.record([metric(`/route-${i}`)]);
      }
      histogramRecord.mockClear();

      service.record([metric('/route-brand-new'), metric('/route-0')]);

      expect(histogramRecord).toHaveBeenCalledWith('brokkr.web_vitals.lcp', 1000, { rating: 'good', route: 'other' });
      expect(histogramRecord).toHaveBeenCalledWith('brokkr.web_vitals.lcp', 1000, {
        rating: 'good',
        route: '/route-0',
      });
    });
  });
});
