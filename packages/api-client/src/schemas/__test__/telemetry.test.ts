import { ReportWebVitalsRequestSchema, WebVitalMetricSchema } from '../telemetry';

function baseMetric(overrides: Record<string, unknown> = {}) {
  return {
    name: 'LCP',
    value: 1234.5,
    rating: 'good',
    delta: 12.5,
    id: 'v5-lcp-1',
    route: '/servers/$serverId',
    ...overrides,
  };
}

function batchOf(count: number) {
  return { metrics: Array.from({ length: count }, (_, i) => baseMetric({ id: `v5-lcp-${i}` })) };
}

describe('WebVitalMetricSchema', () => {
  it('accepts a well-formed metric', () => {
    expect(WebVitalMetricSchema.safeParse(baseMetric()).success).toBe(true);
  });

  describe('value', () => {
    it.each([
      ['negative', -1],
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
      ['-Infinity', Number.NEGATIVE_INFINITY],
    ])('rejects a %s value', (_label, value) => {
      expect(WebVitalMetricSchema.safeParse(baseMetric({ value })).success).toBe(false);
    });

    it('accepts zero (a valid non-negative measurement)', () => {
      expect(WebVitalMetricSchema.safeParse(baseMetric({ value: 0 })).success).toBe(true);
    });
  });

  describe('delta', () => {
    it('accepts a negative finite delta (kept permissive, unused server-side)', () => {
      expect(WebVitalMetricSchema.safeParse(baseMetric({ delta: -5 })).success).toBe(true);
    });

    it.each([
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
    ])('rejects a %s delta', (_label, delta) => {
      expect(WebVitalMetricSchema.safeParse(baseMetric({ delta })).success).toBe(false);
    });
  });

  describe('name enum', () => {
    it.each(['CLS', 'INP', 'FCP', 'LCP', 'TTFB'])('accepts %s', (name) => {
      expect(WebVitalMetricSchema.safeParse(baseMetric({ name })).success).toBe(true);
    });

    it('rejects an unknown vital name', () => {
      expect(WebVitalMetricSchema.safeParse(baseMetric({ name: 'FID' })).success).toBe(false);
    });
  });

  describe('rating enum', () => {
    it.each(['good', 'needs-improvement', 'poor'])('accepts %s', (rating) => {
      expect(WebVitalMetricSchema.safeParse(baseMetric({ rating })).success).toBe(true);
    });

    it('rejects an unknown rating', () => {
      expect(WebVitalMetricSchema.safeParse(baseMetric({ rating: 'excellent' })).success).toBe(false);
    });
  });

  describe('id length', () => {
    it('accepts an id at the 128-char limit', () => {
      expect(WebVitalMetricSchema.safeParse(baseMetric({ id: 'x'.repeat(128) })).success).toBe(true);
    });

    it('rejects an id over 128 chars', () => {
      expect(WebVitalMetricSchema.safeParse(baseMetric({ id: 'x'.repeat(129) })).success).toBe(false);
    });
  });

  describe('route length', () => {
    it('accepts a route at the 256-char limit', () => {
      expect(WebVitalMetricSchema.safeParse(baseMetric({ route: 'r'.repeat(256) })).success).toBe(true);
    });

    it('rejects a route over 256 chars', () => {
      expect(WebVitalMetricSchema.safeParse(baseMetric({ route: 'r'.repeat(257) })).success).toBe(false);
    });
  });
});

describe('ReportWebVitalsRequestSchema', () => {
  it('accepts a batch at the 20-metric cap', () => {
    expect(ReportWebVitalsRequestSchema.safeParse(batchOf(20)).success).toBe(true);
  });

  it('rejects a batch over the 20-metric cap', () => {
    expect(ReportWebVitalsRequestSchema.safeParse(batchOf(21)).success).toBe(false);
  });

  it('accepts an empty batch', () => {
    expect(ReportWebVitalsRequestSchema.safeParse({ metrics: [] }).success).toBe(true);
  });
});
