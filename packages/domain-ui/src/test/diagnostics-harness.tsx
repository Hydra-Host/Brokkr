import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, type RenderResult } from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';
import { DiagnosticsApiProvider, type DiagnosticsApi } from '../hooks/use-diagnostics-api';

const unused = () => Promise.reject(new Error('unused'));

export function fakeDiagnosticsApi(overrides: Partial<DiagnosticsApi> = {}): DiagnosticsApi {
  return {
    bootTrail: unused,
    bootReadiness: unused,
    healthSummary: unused,
    listHealthChecks: unused,
    requestHealthCheck: unused,
    listDeviceTokens: unused,
    listJobs: unused,
    jobEvents: unused,
    jobLogsPage: unused,
    solLogsPage: unused,
    gates: { isLoading: false, can: () => true },
    hrefs: {
      jobs: (deviceId) => `/servers/${deviceId}/jobs`,
      diagnostics: (deviceId) => `/servers/${deviceId}/diagnostics`,
      health: (deviceId) => `/servers/${deviceId}/health`,
      prefix: (prefixId) => `/prefixes/${prefixId}/dhcp`,
      zone: () => null,
      zoneCommission: () => null,
    },
    ...overrides,
  };
}

export function diagnosticsWrapper(api: DiagnosticsApi = fakeDiagnosticsApi()) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function DiagnosticsWrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <DiagnosticsApiProvider api={api}>{children}</DiagnosticsApiProvider>
      </QueryClientProvider>
    );
  };
}

export function renderWithDiagnostics(ui: ReactElement, api: DiagnosticsApi = fakeDiagnosticsApi()): RenderResult {
  return render(ui, { wrapper: diagnosticsWrapper(api) });
}
