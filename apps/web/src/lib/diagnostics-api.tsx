import { useMemo, type ReactNode } from 'react';

import type { DiagnosticsApi, DiagnosticsGate } from '@repo/domain-ui/hooks/use-diagnostics-api';
import { DiagnosticsApiProvider, okBody } from '@repo/domain-ui/hooks/use-diagnostics-api';
import { useCanViewJobHistory } from '~/hooks/use-can-view-job-history';
import { usePermissions } from '~/hooks/use-permissions';
import { tsr } from '~/lib/api';

const serverPath = (deviceId: string) => `/dcim/servers/${deviceId}`;

export function useHubDiagnosticsApi(): DiagnosticsApi {
  const { can, isLoading } = usePermissions();
  const { canView: canViewJobs, isPending } = useCanViewJobHistory();

  return useMemo(() => {
    const passes: Record<DiagnosticsGate, boolean> = {
      'jobs.view': canViewJobs,
      'job-logs.access': can('job-log', 'access'),
      'health.request': can('device', 'health-check'),
      'device-tokens.read': can('device-token', 'access'),
      'prefix.open': can('ipam', 'read'),
    };

    return {
      bootTrail: async (deviceId) => okBody(await tsr.getDeviceBootTrail.query({ params: { deviceId } })),
      bootReadiness: async (deviceId) => okBody(await tsr.getDeviceBootReadiness.query({ params: { deviceId } })),
      healthSummary: async (deviceId) => okBody(await tsr.getDeviceHealthSummary.query({ params: { deviceId } })),
      listHealthChecks: async (deviceId, query) =>
        okBody(await tsr.listDeviceHealthChecks.query({ params: { deviceId }, query })),
      requestHealthCheck: async (deviceId) =>
        okBody(await tsr.requestDeviceHealthCheck.mutate({ params: { deviceId }, body: {} })),
      listDeviceTokens: async (deviceId) => okBody(await tsr.listDeviceTokenSummaries.query({ params: { deviceId } })),
      listJobs: async (scope, query) => okBody(await tsr.listLifecycleJobs.query({ query: { ...query, ...scope } })),
      listDeviceJobs: async (deviceId) => okBody(await tsr.listDeviceJobs.query({ params: { deviceId } })).jobs,
      jobEvents: async (jobId) => okBody(await tsr.listLifecycleJobEvents.query({ params: { jobId } })),
      jobLogsPage: async (jobId, cursor, limit) =>
        okBody(await tsr.getJobLogs.query({ params: { jobId }, query: { cursor, limit } })),
      solLogsPage: async (deviceId, jobId, cursor, limit) =>
        okBody(await tsr.getJobSolLogs.query({ params: { deviceId, jobId }, query: { cursor, limit } })),
      gates: { isLoading: isLoading || isPending, can: (gate) => passes[gate] },
      hrefs: {
        jobs: (deviceId, jobId) =>
          jobId === undefined
            ? `${serverPath(deviceId)}/jobs`
            : `${serverPath(deviceId)}/jobs?job=${encodeURIComponent(jobId)}`,
        diagnostics: (deviceId) => `${serverPath(deviceId)}/diagnostics`,
        health: (deviceId) => `${serverPath(deviceId)}/diagnostics`,
        prefix: (prefixId) => `/ipam/prefixes/${prefixId}/edit`,
        zone: (zoneId) => `/dcim/zones/${zoneId}`,
        zoneCommission: (zoneId) => `/dcim/zones/${zoneId}/commission`,
      },
    };
  }, [can, canViewJobs, isLoading, isPending]);
}

export function HubDiagnosticsProvider({ children }: { children: ReactNode }) {
  const api = useHubDiagnosticsApi();
  return <DiagnosticsApiProvider api={api}>{children}</DiagnosticsApiProvider>;
}

export function useHubDeploymentDiagnosticsApi(deploymentId: string): DiagnosticsApi {
  const hub = useHubDiagnosticsApi();

  return useMemo(() => {
    // the operator keeps the operator routes and their raw errors; a renter reads the masked deployment routes
    if (hub.gates.can('jobs.view')) return hub;

    return {
      ...hub,
      listJobs: async (_scope, query) =>
        okBody(await tsr.listDeploymentJobs.query({ params: { id: deploymentId }, query })),
      jobEvents: async (jobId) =>
        okBody(await tsr.getDeploymentJobEvents.query({ params: { id: deploymentId, jobId } })),
      gates: { isLoading: hub.gates.isLoading, can: (gate) => gate === 'jobs.view' || hub.gates.can(gate) },
    };
  }, [hub, deploymentId]);
}

export function HubDeploymentDiagnosticsProvider({
  deploymentId,
  children,
}: {
  deploymentId: string;
  children: ReactNode;
}) {
  const api = useHubDeploymentDiagnosticsApi(deploymentId);
  return <DiagnosticsApiProvider api={api}>{children}</DiagnosticsApiProvider>;
}
