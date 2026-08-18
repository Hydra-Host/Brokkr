import { UnauthorizedException } from '@nestjs/common';
import { resolveEffectiveApiKeyPermissions } from '@repo/auth';
import { RbacResolverService } from '@repo/auth/rbac';

import { PrismaClient } from '../prisma/prisma.client';
import { AuthRepository } from './auth.repo';
import { AuthType, type ApiKeyContext, type BaseIdentityContext } from './identity-context';
import { assertOrganizationNotDeleted, assertUserNotBanned } from './identity-guards';

type IdentityLogger = {
  error(message: string): void;
  warn(message: string): void;
};

export async function buildApiKeyIdentityContext(
  key: { id: string; referenceId: string; name?: string | null },
  deps: {
    prisma: Pick<PrismaClient, 'apiKey'>;
    repo: Pick<AuthRepository, 'findOrganizationMember'>;
    rbacResolver: Pick<RbacResolverService, 'resolveEffectivePermissions'>;
    logger: IdentityLogger;
  },
): Promise<BaseIdentityContext & ApiKeyContext> {
  const keyRecord = await deps.prisma.apiKey.findUnique({
    where: { id: key.id },
    select: { organizationId: true, permissions: true },
  });
  const organizationId = keyRecord?.organizationId;

  if (!organizationId) {
    deps.logger.error('API key has no server-assigned organization');
    throw new UnauthorizedException();
  }

  const member = await deps.repo.findOrganizationMember(key.referenceId, organizationId);
  if (!member) {
    deps.logger.error('API key owner is no longer assigned to the organization');
    throw new UnauthorizedException();
  }

  assertOrganizationNotDeleted(member.organization);
  assertUserNotBanned(member.user);

  const permissionResolution = resolveEffectiveApiKeyPermissions(
    keyRecord?.permissions,
    await deps.rbacResolver.resolveEffectivePermissions(member.assignedRoleId),
  );
  if (permissionResolution.malformed) {
    deps.logger.warn('API key has malformed permission scope');
  }

  return {
    authType: AuthType.ApiKey,
    organizationId,
    organization: member.organization,
    role: member.role,
    assignedRoleId: member.assignedRoleId,
    permissions: permissionResolution.permissions,
    apiKey: { id: key.id, referenceId: key.referenceId, name: key.name, organizationId },
    user: member.user,
  };
}
