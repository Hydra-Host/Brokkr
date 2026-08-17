import { ForbiddenException } from '@nestjs/common';
import { AuthType } from 'src/auth/identity-context';
import { describe, expect, it, vi } from 'vitest';

import { OrganizationRolesService } from '../organization-roles.service';

function build(authType: AuthType, ownerCapable = true) {
  const context = {
    organizationId: 'org-1',
    userId: 'actor',
    permissions: new Set(['organization:manage-owners']),
    requireIdentity: { authType },
    buildAuditPayload: vi.fn().mockReturnValue({
      triggeredBy: 'actor',
      triggeredByEmail: 'actor@example.com',
      organizationId: 'org-1',
    }),
    requestId: 'req-1',
    actorFields: vi.fn().mockReturnValue({
      actorType: 'UI',
      actorId: 'actor',
      actorLabel: 'actor@example.com',
      apiKeyId: null,
      apiKeyLabel: null,
    }),
    requestFields: vi.fn().mockReturnValue({
      method: 'POST',
      path: '/api/v1/organizations/roles',
      ipAddress: '203.0.113.9',
      userAgent: 'vitest',
    }),
    finalizeIntents: vi.fn(),
    pushIntent: vi.fn().mockReturnValue('intent-1'),
    requirePermission: vi.fn(),
  };
  const rbac = {
    isOwnerCapable: vi.fn().mockReturnValue(ownerCapable),
    grantOwnerAccess: vi.fn().mockResolvedValue({}),
    revokeOwnerAccess: vi.fn().mockResolvedValue({}),
    transferOwnership: vi.fn().mockResolvedValue({}),
  };
  const logger = { log: vi.fn() };
  const eventLog = { recordInTransaction: vi.fn().mockResolvedValue(undefined) };
  const service = new OrganizationRolesService(context as never, rbac as never, eventLog as never, logger as never);
  return { service, context, rbac, logger, eventLog };
}

describe('OrganizationRolesService owner-management gates', () => {
  it('rejects API-key auth even when the key carries the reserved permission', async () => {
    const { service, rbac } = build(AuthType.ApiKey);
    await expect(service.grantOwnerAccess('member-1', 'owner-role')).rejects.toThrow(ForbiddenException);
    expect(rbac.grantOwnerAccess).not.toHaveBeenCalled();
  });

  it('rejects a session that is not full-catalog owner-capable', async () => {
    const { service, rbac } = build(AuthType.Session, false);
    await expect(service.revokeOwnerAccess('member-1', 'reader-role')).rejects.toThrow(ForbiddenException);
    expect(rbac.revokeOwnerAccess).not.toHaveBeenCalled();
  });

  it('logs a structured audit payload after grant, revoke, and transfer', async () => {
    const { service, context, logger } = build(AuthType.Session);
    await service.grantOwnerAccess('member-1', 'owner-role');
    await service.revokeOwnerAccess('member-1', 'reader-role');
    await service.transferOwnership({
      sourceMemberId: 'source',
      recipientMemberId: 'recipient',
      ownerRoleId: 'owner-role',
      sourceReplacementRoleId: 'reader-role',
    });
    expect(context.buildAuditPayload).toHaveBeenCalledTimes(3);
    expect(logger.log).toHaveBeenCalledTimes(3);
    for (const [message] of logger.log.mock.calls) {
      expect(() => JSON.parse(message)).not.toThrow();
    }
  });
});
