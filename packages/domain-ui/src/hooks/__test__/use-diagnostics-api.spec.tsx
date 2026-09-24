import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DiagnosticsApiProvider,
  diagnosticsKeys,
  useDiagnosticsApi,
  type DiagnosticsApi,
} from '../use-diagnostics-api';

const unused = () => Promise.reject(new Error('unused'));

const fakeApi = (): DiagnosticsApi => ({
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
    prefix: () => null,
    zone: () => null,
    zoneCommission: () => null,
  },
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useDiagnosticsApi', () => {
  it('returns the api the provider was given', () => {
    const api = fakeApi();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <DiagnosticsApiProvider api={api}>{children}</DiagnosticsApiProvider>
    );
    const { result } = renderHook(() => useDiagnosticsApi(), { wrapper });
    expect(result.current).toBe(api);
  });

  it('throws outside a provider', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => renderHook(() => useDiagnosticsApi())).toThrow(/DiagnosticsApiProvider/);
  });
});

describe('diagnosticsKeys', () => {
  it('spells the device keys with the device id second', () => {
    expect(diagnosticsKeys.bootTrail('dev-1')).toEqual(['device-boot-trail', 'dev-1']);
    expect(diagnosticsKeys.bootReadiness('dev-1')).toEqual(['device-boot-readiness', 'dev-1']);
    expect(diagnosticsKeys.health('dev-1')).toEqual(['device-health', 'dev-1']);
    expect(diagnosticsKeys.deviceTokens('dev-1')).toEqual(['device-tokens', 'dev-1']);
    expect(diagnosticsKeys.deviceJobs('dev-1')).toEqual(['device-jobs', 'dev-1']);
  });

  it('carries the scope and query on the list keys', () => {
    expect(diagnosticsKeys.jobs({ deviceId: 'dev-1' }, { page: 2 })).toEqual([
      'lifecycle-jobs',
      { deviceId: 'dev-1' },
      { page: 2 },
    ]);
    expect(diagnosticsKeys.healthChecks('dev-1', { page: 1 })).toEqual(['device-health-checks', 'dev-1', { page: 1 }]);
  });

  it('gives every key family a distinct prefix', () => {
    const prefixes = [
      diagnosticsKeys.bootTrail('x')[0],
      diagnosticsKeys.bootReadiness('x')[0],
      diagnosticsKeys.health('x')[0],
      diagnosticsKeys.healthChecks('x', {})[0],
      diagnosticsKeys.deviceTokens('x')[0],
      diagnosticsKeys.jobs({}, {})[0],
      diagnosticsKeys.deviceJobs('x')[0],
      diagnosticsKeys.jobEvents('x')[0],
      diagnosticsKeys.jobLogs('x')[0],
      diagnosticsKeys.solLogs('x')[0],
      diagnosticsKeys.deploymentSolLog('x')[0],
    ];
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });
});
