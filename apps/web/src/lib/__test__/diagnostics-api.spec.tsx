import type { LifecycleJobEventsResponse, LifecycleJobSummary, PaginatedResponse } from '@repo/api-client';
import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { listDeploymentJobs, getDeploymentJobEvents, listLifecycleJobs, listLifecycleJobEvents, gate } = vi.hoisted(
  () => ({
    listDeploymentJobs: vi.fn(),
    getDeploymentJobEvents: vi.fn(),
    listLifecycleJobs: vi.fn(),
    listLifecycleJobEvents: vi.fn(),
    gate: { canView: false },
  }),
);

vi.mock('~/lib/api', () => ({
  tsr: {
    listDeploymentJobs: { query: listDeploymentJobs },
    getDeploymentJobEvents: { query: getDeploymentJobEvents },
    listLifecycleJobs: { query: listLifecycleJobs },
    listLifecycleJobEvents: { query: listLifecycleJobEvents },
  },
}));

vi.mock('~/hooks/use-permissions', () => ({
  usePermissions: () => ({ can: () => false, isLoading: false, permissions: new Set<string>() }),
}));

vi.mock('~/hooks/use-can-view-job-history', () => ({
  useCanViewJobHistory: () => ({ canView: gate.canView, isPending: false }),
}));

import { useHubDeploymentDiagnosticsApi } from '../diagnostics-api';

const summary: LifecycleJobSummary = {
  id: '44444444-4444-4444-4444-444444444444',
  jobType: 'Provision',
  phase: 'RUNNING',
  deviceId: 'dev-1',
  deploymentId: 'dep-1',
  source: 'UI',
  performedBy: null,
  error: null,
  createdAt: '2026-09-18T15:25:28.000Z',
  completedAt: null,
};

const page: PaginatedResponse<LifecycleJobSummary> = {
  data: [summary],
  meta: { page: 1, pageSize: 20, totalItems: 1, totalPages: 1 },
};

const events: LifecycleJobEventsResponse = { data: [], meta: { truncated: false, cap: 500 } };
const query = { page: 1, pageSize: 20 };

afterEach(() => {
  vi.clearAllMocks();
  gate.canView = false;
});

describe('useHubDeploymentDiagnosticsApi', () => {
  it('reads the masked deployment routes for a viewer without job history and opens the jobs gate', async () => {
    listDeploymentJobs.mockResolvedValue({ status: 200, body: page });
    getDeploymentJobEvents.mockResolvedValue({ status: 200, body: events });
    const { result } = renderHook(() => useHubDeploymentDiagnosticsApi('dep-1'));

    expect(result.current.gates.can('jobs.view')).toBe(true);
    expect(result.current.gates.can('job-logs.access')).toBe(false);
    await expect(result.current.listJobs({ deploymentId: 'dep-1' }, query)).resolves.toEqual(page);
    await expect(result.current.jobEvents('job-1')).resolves.toEqual(events);

    expect(listDeploymentJobs).toHaveBeenCalledWith({ params: { id: 'dep-1' }, query });
    expect(getDeploymentJobEvents).toHaveBeenCalledWith({ params: { id: 'dep-1', jobId: 'job-1' } });
    expect(listLifecycleJobs).not.toHaveBeenCalled();
    expect(listLifecycleJobEvents).not.toHaveBeenCalled();
  });

  it('leaves a viewer with job history on the operator routes', async () => {
    gate.canView = true;
    listLifecycleJobs.mockResolvedValue({ status: 200, body: page });
    listLifecycleJobEvents.mockResolvedValue({ status: 200, body: events });
    const { result } = renderHook(() => useHubDeploymentDiagnosticsApi('dep-1'));

    expect(result.current.gates.can('jobs.view')).toBe(true);
    await expect(result.current.listJobs({ deploymentId: 'dep-1' }, query)).resolves.toEqual(page);
    await expect(result.current.jobEvents('job-1')).resolves.toEqual(events);

    expect(listLifecycleJobs).toHaveBeenCalledWith({ query: { ...query, deploymentId: 'dep-1' } });
    expect(listLifecycleJobEvents).toHaveBeenCalledWith({ params: { jobId: 'job-1' } });
    expect(listDeploymentJobs).not.toHaveBeenCalled();
    expect(getDeploymentJobEvents).not.toHaveBeenCalled();
  });
});
