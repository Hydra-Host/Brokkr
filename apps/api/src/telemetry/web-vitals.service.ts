import { Injectable } from '@nestjs/common';
import type { ReportWebVitalsResponse, WebVitalMetric } from '@repo/api-client';
import { getTelemetryMeter } from '@repo/telemetry';

// Bucket boundaries bracket the CWV good/needs-improvement/poor thresholds so
// rating cutoffs land on bucket edges (LCP 2500/4000, TTFB 800/1800, FCP 1800/3000).
const MS_BUCKETS = [100, 200, 400, 800, 1200, 1800, 2500, 4000, 6000, 10000];
const FCP_BUCKETS = [100, 200, 400, 800, 1200, 1800, 2500, 3000, 4000, 6000, 10000];
const INP_BUCKETS = [8, 16, 40, 75, 100, 200, 300, 500, 1000];
const CLS_BUCKETS = [0.01, 0.025, 0.05, 0.1, 0.15, 0.25, 0.5, 1];

// `route` is client-supplied, so bound the label space server-side or a hostile SPA
// could mint unbounded Prometheus series: shape-check the charset, then cap distinct values.
const ROUTE_LABEL_PATTERN = /^[A-Za-z0-9/_$().-]+$/;
const MAX_ROUTE_LABELS = 200;

@Injectable()
export class WebVitalsService {
  // getTelemetryMeter is idempotent per name; resolve the shared meter once and
  // reuse it for every histogram below (declared first so the initializer sees it).
  private readonly meter = getTelemetryMeter('brokkr-hub');

  // Deliberately no otel unit field — the unit lives in the name, keeping the
  // exported prometheus names deterministic (brokkr_web_vitals_lcp_bucket etc.).
  private readonly histograms = {
    LCP: this.meter.createHistogram('brokkr.web_vitals.lcp', {
      description: 'Largest Contentful Paint reported by the SPA, in milliseconds',
      advice: { explicitBucketBoundaries: MS_BUCKETS },
    }),
    CLS: this.meter.createHistogram('brokkr.web_vitals.cls', {
      description: 'Cumulative Layout Shift score reported by the SPA (unitless)',
      advice: { explicitBucketBoundaries: CLS_BUCKETS },
    }),
    INP: this.meter.createHistogram('brokkr.web_vitals.inp', {
      description: 'Interaction to Next Paint reported by the SPA, in milliseconds',
      advice: { explicitBucketBoundaries: INP_BUCKETS },
    }),
    FCP: this.meter.createHistogram('brokkr.web_vitals.fcp', {
      description: 'First Contentful Paint reported by the SPA, in milliseconds',
      advice: { explicitBucketBoundaries: FCP_BUCKETS },
    }),
    TTFB: this.meter.createHistogram('brokkr.web_vitals.ttfb', {
      description: 'Time to First Byte reported by the SPA, in milliseconds',
      advice: { explicitBucketBoundaries: MS_BUCKETS },
    }),
  };

  // First-seen route labels admitted so far (see MAX_ROUTE_LABELS).
  private readonly admittedRoutes = new Set<string>();

  // rating is low-cardinality by contract (enum); route is bounded by
  // routeLabel below.
  record(metrics: WebVitalMetric[]): ReportWebVitalsResponse {
    for (const metric of metrics) {
      this.histograms[metric.name].record(metric.value, {
        rating: metric.rating,
        route: this.routeLabel(metric.route),
      });
    }
    return { accepted: metrics.length };
  }

  private routeLabel(route: string): string {
    if (!ROUTE_LABEL_PATTERN.test(route)) return 'invalid';
    if (this.admittedRoutes.has(route)) return route;
    if (this.admittedRoutes.size >= MAX_ROUTE_LABELS) return 'other';
    this.admittedRoutes.add(route);
    return route;
  }
}
