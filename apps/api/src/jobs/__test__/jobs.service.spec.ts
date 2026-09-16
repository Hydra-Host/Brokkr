import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { ListLifecycleJobsQuery } from '@repo/api-client';
import { JobType, LifecycleJobPhase, RequestSource, type LifecycleJob } from '@repo/database';
import type { PaginatedResult } from '@repo/database/pagination';
import { LifecycleJobRecord } from '@repo/lifecycle';
import { AuthType, type IdentityContext } from 'src/auth/identity-context';
import { DesignationOperatorPolicy } from 'src/common/authz/operator-policy';
import { ContextService } from 'src/common/context/context.service';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JobsService } from '../jobs.service';

const ORG = 'org-1';
const DEVICE = 'device-1';
const DEPLOYMENT = 'deployment-1';

const q = (overrides: Partial<ListLifecycleJobsQuery> = {}): ListLifecycleJobsQuery => ({ page: 1, ...overrides });

const emptyPage = (): PaginatedResult<LifecycleJob> => ({
  data: [],
  meta: { page: 1, pageSize: 20, totalItems: 0, totalPages: 0 },
});

const row = (overrides: Partial<LifecycleJob> = {}): LifecycleJob => ({
  id: 'job-1',
  jobType: JobType.Provision,
  phase: LifecycleJobPhase.RUNNING,
  payload: {},
  deviceId: DEVICE,
  deploymentId: null,
  organizationId: ORG,
  source: RequestSource.UI,
  performedBy: 'user-1',
  scheduledAt: null,
  phoneHomeDeadline: null,
  linkedJobId: null,
  error: null,
  createdAt: new Date('2026-08-28T10:00:00.000Z'),
  updatedAt: new Date('2026-08-28T10:05:00.000Z'),
  ...overrides,
});

function identity(permissions: string[], isInstanceOperator: boolean): IdentityContext {
  return {
    authType: AuthType.Session,
    role: 'Admin',
    organizationId: ORG,
    organization: { id: ORG, isInstanceOperator },
    permissions: new Set(permissions),
    session: { user: { id: 'user-1', email: 'operator@example.com' } },
  } as unknown as IdentityContext;
}

function build({ permissions = ['job:read'], isInstanceOperator = true } = {}) {
  const contextService = new ContextService(new DesignationOperatorPolicy());
  const service = new JobsService(contextService);

  const run = <T>(fn: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      contextService.run({ requestId: 'req-1', identity: identity(permissions, isInstanceOperator) }, () => {
        fn().then(resolve, reject);
      });
    });

  return { service, run };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('JobsService.list', () => {
  it('rejects a member without the job read permission', async () => {
    const spy = vi.spyOn(LifecycleJobRecord, 'findPageByTargetUnscoped').mockResolvedValue(emptyPage());
    const { service, run } = build({ permissions: [] });

    await expect(run(() => service.list(q({ deviceId: DEVICE })))).rejects.toThrow(ForbiddenException);
    expect(spy).not.toHaveBeenCalled();
  });

  it('rejects a non-operator organization even with the permission', async () => {
    const spy = vi.spyOn(LifecycleJobRecord, 'findPageByTargetUnscoped').mockResolvedValue(emptyPage());
    const { service, run } = build({ isInstanceOperator: false });

    await expect(run(() => service.list(q({ deviceId: DEVICE })))).rejects.toThrow(ForbiddenException);
    expect(spy).not.toHaveBeenCalled();
  });

  it('rejects a query with neither deviceId nor deploymentId', async () => {
    const spy = vi.spyOn(LifecycleJobRecord, 'findPageByTargetUnscoped').mockResolvedValue(emptyPage());
    const { service, run } = build();

    await expect(run(() => service.list(q()))).rejects.toThrow(BadRequestException);
    expect(spy).not.toHaveBeenCalled();
  });

  it('passes the device filter through without the target keys in the pagination query', async () => {
    const spy = vi.spyOn(LifecycleJobRecord, 'findPageByTargetUnscoped').mockResolvedValue(emptyPage());
    const { service, run } = build();

    await run(() => service.list(q({ deviceId: DEVICE, pageSize: 10 })));

    expect(spy).toHaveBeenCalledWith({ page: 1, pageSize: 10 }, { deviceId: DEVICE, deploymentId: undefined });
  });

  it('passes the deployment filter through', async () => {
    const spy = vi.spyOn(LifecycleJobRecord, 'findPageByTargetUnscoped').mockResolvedValue(emptyPage());
    const { service, run } = build();

    await run(() => service.list(q({ deploymentId: DEPLOYMENT })));

    expect(spy).toHaveBeenCalledWith({ page: 1 }, { deviceId: undefined, deploymentId: DEPLOYMENT });
  });

  it('maps rows with completedAt null while running and set to updatedAt on terminal phases', async () => {
    vi.spyOn(LifecycleJobRecord, 'findPageByTargetUnscoped').mockResolvedValue({
      data: [
        row({ id: 'job-running', phase: LifecycleJobPhase.RUNNING }),
        row({ id: 'job-completed', phase: LifecycleJobPhase.COMPLETED }),
        row({ id: 'job-failed', phase: LifecycleJobPhase.FAILED, error: 'ipmi timeout' }),
      ],
      meta: { page: 1, pageSize: 20, totalItems: 3, totalPages: 1 },
    });
    const { service, run } = build();

    const result = await run(() => service.list(q({ deviceId: DEVICE })));

    expect(result.data).toEqual([
      {
        id: 'job-running',
        jobType: JobType.Provision,
        phase: LifecycleJobPhase.RUNNING,
        deviceId: DEVICE,
        deploymentId: null,
        source: RequestSource.UI,
        performedBy: 'user-1',
        error: null,
        createdAt: '2026-08-28T10:00:00.000Z',
        completedAt: null,
      },
      {
        id: 'job-completed',
        jobType: JobType.Provision,
        phase: LifecycleJobPhase.COMPLETED,
        deviceId: DEVICE,
        deploymentId: null,
        source: RequestSource.UI,
        performedBy: 'user-1',
        error: null,
        createdAt: '2026-08-28T10:00:00.000Z',
        completedAt: '2026-08-28T10:05:00.000Z',
      },
      {
        id: 'job-failed',
        jobType: JobType.Provision,
        phase: LifecycleJobPhase.FAILED,
        deviceId: DEVICE,
        deploymentId: null,
        source: RequestSource.UI,
        performedBy: 'user-1',
        error: 'ipmi timeout',
        createdAt: '2026-08-28T10:00:00.000Z',
        completedAt: '2026-08-28T10:05:00.000Z',
      },
    ]);
  });

  it('passes pagination meta through untouched', async () => {
    vi.spyOn(LifecycleJobRecord, 'findPageByTargetUnscoped').mockResolvedValue({
      data: [row()],
      meta: { page: 3, pageSize: 5, totalItems: 42, totalPages: 9 },
    });
    const { service, run } = build();

    const result = await run(() => service.list(q({ deviceId: DEVICE, page: 3, pageSize: 5 })));

    expect(result.meta).toEqual({ page: 3, pageSize: 5, totalItems: 42, totalPages: 9 });
  });
});
