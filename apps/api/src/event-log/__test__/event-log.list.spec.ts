import { ForbiddenException } from '@nestjs/common';
import type { Prisma } from '@repo/database';
import { describe, expect, it, vi } from 'vitest';
import { AuthType, type IdentityContext } from 'src/auth/identity-context';
import { DesignationOperatorPolicy } from 'src/common/authz/operator-policy';
import { ContextService } from 'src/common/context/context.service';
import type { EventLogQuery } from '@repo/api-client';
import { EventLogRepository } from '../event-log.repository';
import { EventLogService } from '../event-log.service';

const ORG = 'org-1';

/** `page` is required on the parsed query type; every case here varies only the filters. */
const q = (overrides: Partial<EventLogQuery> = {}): EventLogQuery => ({ page: 1, ...overrides });

function identity(permissions: string[]): IdentityContext {
  return {
    authType: AuthType.Session,
    role: 'Admin',
    organizationId: ORG,
    organization: { id: ORG },
    permissions: new Set(permissions),
    session: { user: { id: 'u-1', email: 'admin@example.com' } },
  } as unknown as IdentityContext;
}

function build(permissions = ['event-log:access']) {
  const list = vi
    .fn()
    .mockResolvedValue({ data: [], meta: { page: 1, pageSize: 25, totalItems: 0, totalPages: 0 } });
  const logger = { log: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), verbose: vi.fn() };
  const contextService = new ContextService(new DesignationOperatorPolicy());
  const service = new EventLogService({ list } as unknown as EventLogRepository, logger as never, contextService);

  const run = <T>(fn: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      contextService.run({ requestId: 'req-1', identity: identity(permissions) }, () => {
        fn().then(resolve, reject);
      });
    });

  const whereFrom = (call = 0): Prisma.EventLogWhereInput => list.mock.calls[call][0];

  return { service, list, run, whereFrom };
}

describe('EventLogService.list', () => {
  it('requires the event-log access permission', async () => {
    const { service, run, list } = build([]);

    await expect(run(() => service.list(q()))).rejects.toThrow(ForbiddenException);
    expect(list).not.toHaveBeenCalled();
  });

  it('pins the organization from context', async () => {
    const { service, run, whereFrom } = build();

    await run(() => service.list(q()));

    expect(whereFrom().organizationId).toBe(ORG);
  });

  it('ignores an organizationId supplied by the caller', async () => {
    const { service, run, whereFrom } = build();

    await run(() => service.list(q({ organizationId: 'someone-elses-org' } as never)));

    expect(whereFrom().organizationId).toBe(ORG);
  });

  it('hides device and system actors by default', async () => {
    const { service, run, whereFrom } = build();

    await run(() => service.list(q()));

    expect(whereFrom().actorType).toEqual({ notIn: ['DEVICE', 'SYSTEM'] });
  });

  it('includes them when asked', async () => {
    const { service, run, whereFrom } = build();

    await run(() => service.list(q({ includeSystemActors: true })));

    expect(whereFrom().actorType).toBeUndefined();
  });

  it('lets an explicit actorType filter win over the default exclusion', async () => {
    const { service, run, whereFrom } = build();

    await run(() => service.list(q({ actorType: 'SYSTEM' })));

    expect(whereFrom().actorType).toBe('SYSTEM');
  });

  it('applies a date range as a createdAt window', async () => {
    const { service, run, whereFrom } = build();
    const from = new Date('2026-08-01T00:00:00.000Z');
    const to = new Date('2026-08-02T00:00:00.000Z');

    await run(() => service.list(q({ from, to })));

    expect(whereFrom().createdAt).toEqual({ gte: from, lte: to });
  });

  it('omits the createdAt window when neither bound is given', async () => {
    const { service, run, whereFrom } = build();

    await run(() => service.list(q()));

    expect(whereFrom().createdAt).toBeUndefined();
  });

  it('applies every named filter to the where clause', async () => {
    const { service, run, whereFrom } = build();

    await run(() =>
      service.list(
        q({
        actionKey: 'member.removed',
        resource: 'member',
        tier: 'EVIDENCE',
        durability: 'ATOMIC',
        actorId: 'u-9',
        outcome: 'SUCCEEDED',
        targetId: 'm-1',
        }),
      ),
    );

    expect(whereFrom()).toMatchObject({
      organizationId: ORG,
      actionKey: 'member.removed',
      resource: 'member',
      tier: 'EVIDENCE',
      durability: 'ATOMIC',
      actorId: 'u-9',
      outcome: 'SUCCEEDED',
      targetId: 'm-1',
    });
  });

  it('omits filters that were not supplied', async () => {
    const { service, run, whereFrom } = build();

    await run(() => service.list(q({ resource: 'member' })));

    expect(whereFrom().actionKey).toBeUndefined();
    expect(whereFrom().targetId).toBeUndefined();
  });

  it('passes the remaining query through to pagination', async () => {
    const { service, run, list } = build();

    await run(() => service.list(q({ page: 2, pageSize: 50 })));

    expect(list.mock.calls[0][1]).toMatchObject({ page: 2, pageSize: 50 });
  });
});
