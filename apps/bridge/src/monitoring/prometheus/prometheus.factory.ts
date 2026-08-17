// Per-request factory so concurrent calls don't clobber each other's jobId tag on a shared singleton.

import type { PrometheusMonitoringService } from './prometheus.service';

export const PROMETHEUS_SERVICE_FACTORY = 'PROMETHEUS_SERVICE_FACTORY';

export interface PrometheusServiceFactory {
  create(jobId: string): PrometheusMonitoringService;
}
