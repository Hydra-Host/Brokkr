import { Reflector } from '@nestjs/core';
import type { UpdateOrganizationRequest } from '@repo/api-client';
import { MAIN_APP_PERMISSIONS, isMutatingPermission, permissionKey } from '@repo/auth/rbac';
import type { Prisma } from '@repo/database';
import { AuthType, type IdentityContext } from 'src/auth/identity-context';
import { DesignationOperatorPolicy } from 'src/common/authz/operator-policy';
import { ContextService } from 'src/common/context/context.service';
import { AUDIT_ACTION_KEY, type AuditActionOptions } from 'src/event-log/audit-action.decorator';
import type { EventLogWrite } from 'src/event-log/event-log.types';
import { describe, expect, it, vi } from 'vitest';
import { OrganizationsController } from '../organizations.controller';
import { OrganizationsService } from '../organizations.service';

const ORG = 'org-1';
const CURRENT = { id: ORG, name: 'Acme', logo: null, email: null, country: 'US', metadata: null };
const TX = { organization: {} } as unknown as Prisma.TransactionClient;

function identity(): IdentityContext {
  return {
    authType: AuthType.Session,
    role: 'Owner',
    organizationId: ORG,
    organization: { id: ORG },
    permissions: new Set(['organization:update']),
    session: { user: { id: 'u-1', email: 'owner@example.com' } },
  } as unknown as IdentityContext;
}

function build() {
  const writes: EventLogWrite[] = [];
  const eventLog = {
    recordInTransaction: vi.fn(async (_tx: Prisma.TransactionClient, write: EventLogWrite) => {
      writes.push(write);
    }),
  };
  const repo = {
    findOrganizationById: vi.fn(async (_id: string, _tx?: Prisma.TransactionClient) => CURRENT),
    updateOrganization: vi.fn(
      async (_id: string, data: Prisma.OrganizationUpdateInput, _tx?: Prisma.TransactionClient) => ({
        ...CURRENT,
        ...data,
      }),
    ),
  };
  const prisma = {
    $transaction: vi.fn(async (fn: (tx: Prisma.TransactionClient) => Promise<unknown>) => fn(TX)),
  };
  const contextService = new ContextService(new DesignationOperatorPolicy());
  const logger = { log: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), verbose: vi.fn() };
  const service = new OrganizationsService(
    repo as never,
    { create: vi.fn() } as never,
    { emit: vi.fn() } as never,
    contextService,
    null as never,
    { getAllowedOrgTypes: () => [] } as never,
    { resolveEffectivePermissions: vi.fn() } as never,
    prisma as never,
    eventLog as never,
    logger as never,
  );

  const run = async (fn: () => Promise<unknown>) => {
    let result: unknown;
    await new Promise<void>((resolve) => {
      contextService.run(
        {
          requestId: 'req-1',
          identity: identity(),
          method: 'PATCH',
          path: '/api/v1/organizations',
          ipAddress: '203.0.113.9',
          userAgent: 'vitest',
        },
        () => {
          void fn()
            .then((value) => {
              result = value;
            })
            .finally(resolve);
        },
      );
    });
    return result;
  };

  const update = (dto: UpdateOrganizationRequest) => run(() => service.update(dto).catch(() => undefined));

  return { service, contextService, repo, prisma, eventLog, writes, run, update };
}

describe('OrganizationsService.update event capture', () => {
  it('emits one atomic evidence row keyed organization.settings-updated', async () => {
    const { writes, update } = build();

    await update({ name: 'Renamed' });

    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      organizationId: ORG,
      tier: 'EVIDENCE',
      durability: 'ATOMIC',
      resource: 'organization',
      action: 'updated',
      actionKey: 'organization.settings-updated',
      outcome: 'SUCCEEDED',
      targetId: ORG,
      targetLabel: 'Acme',
    });
  });

  it('records the event on the same transaction client as the update', async () => {
    const { repo, eventLog, update } = build();

    await update({ name: 'Renamed' });

    expect(repo.updateOrganization.mock.calls[0][2]).toBe(TX);
    expect(eventLog.recordInTransaction.mock.calls[0][0]).toBe(TX);
  });

  it('reads the pre-image on the same transaction client as the update', async () => {
    const { repo, update } = build();

    await update({ name: 'Renamed' });

    expect(repo.findOrganizationById.mock.calls[0][1]).toBe(TX);
  });

  it('carries the acting session user and the request provenance', async () => {
    const { writes, update } = build();

    await update({ name: 'Renamed' });

    expect(writes[0]).toMatchObject({
      actorType: 'UI',
      actorId: 'u-1',
      actorLabel: 'owner@example.com',
      requestId: 'req-1',
      method: 'PATCH',
      path: '/api/v1/organizations',
      ipAddress: '203.0.113.9',
      userAgent: 'vitest',
    });
  });

  it('records the names of the changed fields', async () => {
    const { writes, update } = build();

    await update({ name: 'Renamed', email: 'billing@example.com' });

    expect(writes[0].metadata).toEqual({ changedFields: ['name', 'email'] });
  });

  it('omits a submitted field whose value is unchanged', async () => {
    const { writes, update } = build();

    await update({ name: 'Acme', country: 'DE' });

    expect(writes[0].metadata).toEqual({ changedFields: ['country'] });
  });

  it('records no field values anywhere on the row', async () => {
    const { writes, update } = build();
    const distinctive = 'zz-canary-9f3b1d-org-name';
    const distinctiveEmail = 'zz-canary-9f3b1d@example.com';

    await update({ name: distinctive, email: distinctiveEmail, metadata: '{"vatId":"zz-canary-9f3b1d"}' });

    expect(writes[0].metadata).toEqual({ changedFields: ['name', 'email', 'metadata'] });
    expect(JSON.stringify(writes[0])).not.toContain('zz-canary-9f3b1d');
  });

  it('supersedes the permission intent only after the transaction resolves', async () => {
    const { contextService, update } = build();
    const finalize = vi.spyOn(contextService, 'finalizeIntents');

    await update({ name: 'Renamed' });

    expect(finalize).toHaveBeenCalledOnce();
  });

  it('leaves the intent unfinalized when the event write fails', async () => {
    const { contextService, eventLog, update } = build();
    eventLog.recordInTransaction.mockRejectedValueOnce(new Error('event write failed'));
    const finalize = vi.spyOn(contextService, 'finalizeIntents');

    await update({ name: 'Renamed' });

    expect(finalize).not.toHaveBeenCalled();
  });

  it('gates the tier 2 fallback on a catalog permission classified as mutating', () => {
    const options = new Reflector().get<AuditActionOptions>(AUDIT_ACTION_KEY, OrganizationsController.prototype.update);

    expect(options.actionKey).toBe('organization.settings-updated');
    expect(isMutatingPermission(MAIN_APP_PERMISSIONS, permissionKey(options.resource, options.action))).toBe(true);
  });

  it('emits nothing when the caller lacks organization:update', async () => {
    const { service, contextService, writes, repo } = build();

    await new Promise<void>((resolve) => {
      contextService.run(
        { requestId: 'req-2', identity: { ...identity(), permissions: new Set() } as unknown as IdentityContext },
        () => {
          void service
            .update({ name: 'Renamed' })
            .catch(() => undefined)
            .finally(resolve);
        },
      );
    });

    expect(writes).toHaveLength(0);
    expect(repo.updateOrganization).not.toHaveBeenCalled();
  });
});
