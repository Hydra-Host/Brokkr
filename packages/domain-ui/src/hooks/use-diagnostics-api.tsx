import { createContext, useContext, type ReactNode } from 'react';

import type {
  DeviceBootReadiness,
  DeviceBootTrail,
  DeviceHealthChecksListResponse,
  DeviceHealthSummary,
  DeviceJob,
  DeviceTokenSummary,
  JobLogsResponse,
  JobSolLogsResponse,
  LifecycleJobEventsResponse,
  LifecycleJobSummary,
  PaginatedResponse,
  PaginationQuery,
  RequestDeviceHealthCheckResponse,
} from '@repo/api-client';

export type DiagnosticsGate = 'jobs.view' | 'job-logs.access' | 'health.request' | 'device-tokens.read' | 'prefix.open';

export interface LifecycleJobsScope {
  deviceId?: string;
  deploymentId?: string;
}

export interface DiagnosticsApi {
  bootTrail(deviceId: string): Promise<DeviceBootTrail>;
  bootReadiness(deviceId: string): Promise<DeviceBootReadiness>;
  healthSummary(deviceId: string): Promise<DeviceHealthSummary>;
  listHealthChecks(deviceId: string, query: PaginationQuery): Promise<DeviceHealthChecksListResponse>;
  requestHealthCheck(deviceId: string): Promise<RequestDeviceHealthCheckResponse>;
  listDeviceTokens(deviceId: string): Promise<DeviceTokenSummary[]>;
  listJobs(scope: LifecycleJobsScope, query: PaginationQuery): Promise<PaginatedResponse<LifecycleJobSummary>>;
  listDeviceJobs?(deviceId: string): Promise<DeviceJob[]>;
  jobEvents(jobId: string): Promise<LifecycleJobEventsResponse>;
  jobLogsPage(jobId: string, cursor: string | undefined, limit: number): Promise<JobLogsResponse>;
  solLogsPage(deviceId: string, jobId: string, cursor: number, limit: number): Promise<JobSolLogsResponse>;
  gates: { isLoading: boolean; can(gate: DiagnosticsGate): boolean };
  hrefs: {
    jobs(deviceId: string, jobId?: string): string;
    diagnostics(deviceId: string): string;
    health(deviceId: string): string;
    prefix(prefixId: string): string | null;
    zone(zoneId: string): string | null;
    zoneCommission(zoneId: string): string | null;
  };
}

const DiagnosticsApiContext = createContext<DiagnosticsApi | null>(null);

export function DiagnosticsApiProvider({ api, children }: { api: DiagnosticsApi; children: ReactNode }) {
  return <DiagnosticsApiContext.Provider value={api}>{children}</DiagnosticsApiContext.Provider>;
}

export function useDiagnosticsApi(): DiagnosticsApi {
  const api = useContext(DiagnosticsApiContext);
  if (api === null) throw new Error('useDiagnosticsApi must be used within a DiagnosticsApiProvider');
  return api;
}

export function isOk<R extends { status: number }>(response: R): response is Extract<R, { status: 200 }> {
  return response.status === 200;
}

// non-2xx responses are thrown whole, the same shape the tsr query hooks surface as their error
export function okBody<R extends { status: number; body: unknown }>(response: R): Extract<R, { status: 200 }>['body'] {
  if (!isOk(response)) throw response;
  return response.body;
}

export const diagnosticsKeys = {
  bootTrail: (deviceId: string) => ['device-boot-trail', deviceId] as const,
  bootReadiness: (deviceId: string) => ['device-boot-readiness', deviceId] as const,
  health: (deviceId: string) => ['device-health', deviceId] as const,
  healthChecks: (deviceId: string, query: unknown) => ['device-health-checks', deviceId, query] as const,
  deviceTokens: (deviceId: string) => ['device-tokens', deviceId] as const,
  jobs: (scope: LifecycleJobsScope, query: unknown) => ['lifecycle-jobs', scope, query] as const,
  deviceJobs: (deviceId: string) => ['device-jobs', deviceId] as const,
  jobEvents: (jobId: string) => ['job-events', jobId] as const,
  jobLogs: (jobId: string) => ['job-logs', jobId] as const,
  solLogs: (jobId: string) => ['sol-logs', jobId] as const,
  deploymentSolLog: (deploymentId: string) => ['deployment-sol-log', deploymentId] as const,
};
