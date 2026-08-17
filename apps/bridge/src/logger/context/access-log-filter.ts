import { ACCESS_LOG_MONITORING_PREFIX, ACCESS_LOG_QUIET_ROUTES } from './logging-context.constants';

export interface AccessLogFilterInput {
  url: string;
  statusCode: number;
  monitoringLogsEnabled: boolean;
}

export function shouldLogAccess(input: AccessLogFilterInput): boolean {
  const { url, statusCode, monitoringLogsEnabled } = input;

  for (const route of ACCESS_LOG_QUIET_ROUTES) {
    if (url.includes(route)) {
      return statusCode !== 200;
    }
  }

  if (statusCode === 200) return false;

  if (url.includes(ACCESS_LOG_MONITORING_PREFIX) && !monitoringLogsEnabled) {
    return false;
  }

  return true;
}
