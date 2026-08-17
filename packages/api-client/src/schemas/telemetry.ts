import { z } from 'zod';

export const WebVitalNameSchema = z
  .enum(['CLS', 'INP', 'FCP', 'LCP', 'TTFB'])
  .describe('Core Web Vital metric name as reported by the web-vitals library');

export type WebVitalName = z.infer<typeof WebVitalNameSchema>;

export const WebVitalRatingSchema = z
  .enum(['good', 'needs-improvement', 'poor'])
  .describe('Threshold rating the web-vitals library assigned to the measured value');

export type WebVitalRating = z.infer<typeof WebVitalRatingSchema>;

export const WebVitalMetricSchema = z.object({
  name: WebVitalNameSchema,
  value: z
    .number()
    .finite()
    .nonnegative()
    .describe('Measured metric value: milliseconds for time-based vitals, unitless score for CLS'),
  rating: WebVitalRatingSchema,
  // .finite() mirrors value; kept permissive (no nonnegative bound) because delta
  // is unused server-side and web-vitals emits signed deltas for some metrics.
  delta: z.number().finite().describe('Change in value since the metric was last reported for this page load'),
  id: z.string().max(128).describe('Unique id the web-vitals library assigned to this metric instance'),
  route: z
    .string()
    .max(256)
    .describe(
      "Matched SPA route template id (e.g. '/servers/$serverId'), not a raw pathname, to keep label cardinality bounded",
    ),
});

export type WebVitalMetric = z.infer<typeof WebVitalMetricSchema>;

export const ReportWebVitalsRequestSchema = z.object({
  metrics: z.array(WebVitalMetricSchema).max(20).describe('Batch of buffered Core Web Vitals measurements to record'),
});

export type ReportWebVitalsRequest = z.infer<typeof ReportWebVitalsRequestSchema>;

export const ReportWebVitalsResponseSchema = z.object({
  accepted: z.number().int().describe('Number of metrics accepted for recording'),
});

export type ReportWebVitalsResponse = z.infer<typeof ReportWebVitalsResponseSchema>;
