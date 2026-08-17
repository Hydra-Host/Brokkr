import { initContract } from '@ts-rest/core';
import { ReportWebVitalsRequestSchema, ReportWebVitalsResponseSchema } from '../schemas/telemetry';
import { type RouteMetadata } from './metadata';
import { authedErrorResponses } from './responses';

const c = initContract();

export const telemetryRoutes = c.router({
  reportWebVitals: {
    method: 'POST',
    path: '/telemetry/web-vitals',
    body: ReportWebVitalsRequestSchema,
    responses: {
      202: ReportWebVitalsResponseSchema,
      ...authedErrorResponses,
    },
    summary: 'Report web vitals',
    description:
      'Ingests a batch of Core Web Vitals measurements collected by the SPA and records them as OpenTelemetry histograms on the hub.',
    metadata: { visibility: 'internal' } satisfies RouteMetadata,
  },
});
