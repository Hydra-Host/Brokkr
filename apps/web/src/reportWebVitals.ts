import { contract, type ReportWebVitalsRequest, type WebVitalMetric } from '@repo/api-client';
import { onCLS, onFCP, onINP, onLCP, onTTFB, type MetricType } from 'web-vitals';

/** Minimal view of the TanStack router: the matched-route stack, for route template ids. */
interface MatchedRouteSource {
  state: { matches: ReadonlyArray<{ routeId: string }> };
}

// The contract router bakes API_PREFIX into every route path, so this is the
// full '/api/v1/...' URL — do not prepend the prefix again.
const WEB_VITALS_PATH = contract.reportWebVitals.path;

const FLUSH_IDLE_MS = 10_000;
// Contract-enforced batch cap (metrics: array(...).max(20)).
const MAX_BATCH_SIZE = 20;

// Collects Core Web Vitals and beacons them to the hub in batches (idle-debounced + on page hide).
// All failures are swallowed — vitals reporting must never break the app.
const reportWebVitals = (router: MatchedRouteSource): void => {
  try {
    // Keyed by metric instance id: CLS/INP re-report updated values on later
    // visibility changes, and the newest value supersedes a buffered one.
    const buffer = new Map<string, WebVitalMetric>();
    // CLS/INP re-report the same instance with a new cumulative value on later cycles; the hub keeps
    // every sample, so re-sending double-counts a page view — report each instance once (first wins).
    const sentIds = new Set<string>();
    let idleTimer: ReturnType<typeof setTimeout> | undefined;

    const currentRoute = (): string => {
      // The deepest match's routeId is the route TEMPLATE (e.g. '/servers/$serverId'),
      // not the raw pathname — keeps the metric label cardinality bounded.
      const matches = router.state.matches;
      const deepest = matches[matches.length - 1];
      return (deepest?.routeId ?? 'unknown').slice(0, 256);
    };

    const flush = (): void => {
      try {
        if (idleTimer !== undefined) {
          clearTimeout(idleTimer);
          idleTimer = undefined;
        }
        if (buffer.size === 0 || typeof navigator.sendBeacon !== 'function') return;
        // At most 5 instances exist per page session (one per subscribed vital),
        // so this fits a single beacon; slice to the contract cap as a guard.
        const batch = [...buffer.entries()].slice(0, MAX_BATCH_SIZE);
        const payload: ReportWebVitalsRequest = { metrics: batch.map(([, metric]) => metric) };
        // sendBeacon instead of the tsr client: delivery must survive page
        // unload (flush fires on pagehide), where fetch is cancelled.
        const queued = navigator.sendBeacon(
          WEB_VITALS_PATH,
          new Blob([JSON.stringify(payload)], { type: 'application/json' }),
        );
        // Retire ids only once the beacon is queued: a false return (or throw) means nothing was
        // sent, so keep them buffered for the next flush rather than dropping the samples.
        if (!queued) return;
        for (const [id] of batch) {
          sentIds.add(id);
          buffer.delete(id);
        }
      } catch {
        /* see doc comment */
      }
    };

    const handleMetric = (metric: MetricType): void => {
      try {
        if (sentIds.has(metric.id)) return;
        buffer.set(metric.id, {
          name: metric.name,
          value: metric.value,
          rating: metric.rating,
          delta: metric.delta,
          id: metric.id.slice(0, 128),
          route: currentRoute(),
        });
        if (idleTimer !== undefined) clearTimeout(idleTimer);
        idleTimer = setTimeout(flush, FLUSH_IDLE_MS);
      } catch {
        /* see doc comment */
      }
    };

    onCLS(handleMetric);
    onINP(handleMetric);
    onFCP(handleMetric);
    onLCP(handleMetric);
    onTTFB(handleMetric);

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flush();
    });
    window.addEventListener('pagehide', flush);
  } catch {
    /* see doc comment */
  }
};

export default reportWebVitals;
