import { ConflictException, ForbiddenException } from '@nestjs/common';
import { OrganizationMembershipRole, TenantType } from '@repo/database';
import { describe, expect, it, vi } from 'vitest';

import type { ContextService } from '../../common/context/context.service';
import { OrganizationsService } from '../organizations.service';

const { Owner, Member } = OrganizationMembershipRole;

function build(opts: {
  callerRole?: OrganizationMembershipRole;
  allowedTypes?: TenantType[];
  membership?: unknown;
  sessionCache?: unknown;
}) {
  const repo = {
    createOrganization: vi.fn().mockResolvedValue({ id: 'org-1', name: 'Org', tenantType: TenantType.DemandCustomer }),
    updateOrganization: vi.fn().mockResolvedValue({ id: 'org-1' }),
    findMembership: vi.fn().mockResolvedValue(opts.membership ?? null),
    findActiveSessions: vi.fn().mockResolvedValue([]),
    setActiveOrganizationForAllSessions: vi.fn().mockResolvedValue(undefined),
  };
  const ctx = {
    role: opts.callerRole ?? Owner,
    organizationId: 'org-1',
    userId: 'u1',
    requirePermission: vi.fn((_resource: string, _action: string) => {
      if ((opts.callerRole ?? Owner) === Member) throw new ForbiddenException('missing permission');
    }),
    buildAuditPayload: vi.fn(() => ({ triggeredBy: 'u1', triggeredByEmail: 'a@example.com', organizationId: 'org-1' })),
  } as unknown as ContextService;
  const allowedOrgTypes = { getAllowedOrgTypes: () => opts.allowedTypes ?? [TenantType.DemandCustomer] };
  const logger = { warn: vi.fn(), log: vi.fn() };
  const rbacResolver = { resolveEffectivePermissions: vi.fn().mockResolvedValue(new Set<string>()) };
  const membershipsRepo = { create: vi.fn().mockResolvedValue({}) };
  const service = new OrganizationsService(
    repo as never,
    membershipsRepo as never,
    { emit: vi.fn() } as never,
    ctx,
    (opts.sessionCache ?? null) as never,
    allowedOrgTypes as never,
    rbacResolver as never,
    logger as never,
  );
  return { service, repo, logger, ctx };
}

describe('OrganizationsService.create — server-side tenant-type enforcement', () => {
  it('rejects a tenant type not permitted on the instance (client cannot forge type)', async () => {
    const { service, repo } = build({ allowedTypes: [TenantType.DemandCustomer] });
    await expect(service.create({ name: 'Acme', type: 'SupplyCustomer' }, 'u1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(repo.createOrganization).not.toHaveBeenCalled();
  });
});

describe('OrganizationsService.update — requirePermission gate', () => {
  it('blocks a non-privileged (Member) caller', async () => {
    const { service, repo } = build({ callerRole: Member });
    await expect(service.update({ name: 'New name' })).rejects.toBeInstanceOf(ForbiddenException);
    expect(repo.updateOrganization).not.toHaveBeenCalled();
  });

  it('allows a privileged (Owner) caller and writes an audit line', async () => {
    const { service, repo, ctx, logger } = build({ callerRole: Owner });
    await expect(service.update({ name: 'New name' })).resolves.toBeDefined();
    expect(repo.updateOrganization).toHaveBeenCalledWith('org-1', {
      name: 'New name',
      logo: undefined,
      email: undefined,
      country: undefined,
      metadata: undefined,
    });
    expect(ctx.buildAuditPayload).toHaveBeenCalled();
    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('actor=a@example.com'));
  });
});

describe('OrganizationsService.setActiveOrganization — cross-org membership check', () => {
  it('rejects activating an org the user is not a member of', async () => {
    const { service, repo } = build({ membership: null });
    await expect(service.setActiveOrganization('u1', 'org-2')).rejects.toBeInstanceOf(ConflictException);
    expect(repo.findMembership).toHaveBeenCalledWith('u1', 'org-2');
    expect(repo.findActiveSessions).not.toHaveBeenCalled();
    expect(repo.setActiveOrganizationForAllSessions).not.toHaveBeenCalled();
  });

  it('logs and still succeeds when a session-cache delete fails (DB is the source of truth)', async () => {
    const sessionCache = { get: vi.fn(), set: vi.fn(), delete: vi.fn().mockRejectedValue(new Error('redis down')) };
    const { service, repo, logger } = build({ membership: { role: Owner }, sessionCache });
    repo.findActiveSessions.mockResolvedValue([{ token: 'tok-1' }]);

    await expect(service.setActiveOrganization('u1', 'org-1')).resolves.toEqual({
      success: true,
      organizationId: 'org-1',
    });
    expect(sessionCache.delete).toHaveBeenCalledWith('tok-1');
    expect(logger.warn).toHaveBeenCalledOnce();
  });
});
