import { UnauthorizedException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { RbacResolverService } from '@repo/auth/rbac';
import { OrganizationMembershipRole } from '@repo/database';
import { describe, expect, it, vi } from 'vitest';

import { AuthRepository } from '../../auth/auth.repo';
import { AuthType } from '../../auth/identity-context';
import { DesignationOperatorPolicy } from '../../common/authz/operator-policy';
import { ContextService } from '../../common/context/context.service';
import { PrismaClient } from '../../prisma/prisma.client';
import { HostPluginIdentityBinder } from '../host-plugin-identity-binder';

const ORG_ID = 'org-1';
const USER_ID = 'user-1';
const API_KEY_ID = 'ak-1';

function makeMember() {
  const now = new Date();
  return {
    id: 'member-1',
    userId: USER_ID,
    organizationId: ORG_ID,
    role: OrganizationMembershipRole.Member,
    assignedRoleId: 'role-member',
    createdAt: now,
    updatedAt: now,
    user: {
      id: USER_ID,
      email: 'grafana@example.com',
      firstName: 'Graf',
      lastName: 'Ana',
      banned: false,
      banExpires: null,
    },
    organization: {
      id: ORG_ID,
      name: 'Org',
      deletedAt: null,
      isInstanceOperator: false,
      members: [],
    },
  };
}

async function makeBinder(opts: { member?: ReturnType<typeof makeMember> | null; apiKeyOrgId?: string | null } = {}) {
  const member = 'member' in opts ? opts.member : makeMember();
  const apiKeyOrgId = 'apiKeyOrgId' in opts ? opts.apiKeyOrgId : ORG_ID;
  const contextService = new ContextService(new DesignationOperatorPolicy());
  const identitySetter = vi.fn();
  Object.defineProperty(contextService, 'identity', {
    set: identitySetter,
    get: () => undefined,
    configurable: true,
  });
  const repo = { findOrganizationMember: vi.fn().mockResolvedValue(member) };
  const prisma = {
    apiKey: {
      findUnique: vi.fn().mockResolvedValue({
        organizationId: apiKeyOrgId,
        permissions: null,
      }),
    },
  };
  const rbacResolver = {
    resolveEffectivePermissions: vi.fn().mockResolvedValue(new Set(['device:read'])),
  };
  const moduleRef = await Test.createTestingModule({
    providers: [
      HostPluginIdentityBinder,
      { provide: ContextService, useValue: contextService },
      { provide: AuthRepository, useValue: repo },
      { provide: PrismaClient, useValue: prisma },
      { provide: RbacResolverService, useValue: rbacResolver },
    ],
  }).compile();
  return { binder: moduleRef.get(HostPluginIdentityBinder), repo, prisma, identitySetter, rbacResolver, moduleRef };
}

describe('HostPluginIdentityBinder', () => {
  it('binds an API-key identity onto ContextService', async () => {
    const { binder, identitySetter, repo } = await makeBinder();

    await binder.bindVerifiedApiKey({ id: API_KEY_ID, referenceId: USER_ID, name: 'grafana' });

    expect(repo.findOrganizationMember).toHaveBeenCalledWith(USER_ID, ORG_ID);
    const identity = identitySetter.mock.calls[0][0];
    expect(identity.authType).toBe(AuthType.ApiKey);
    expect(identity.organizationId).toBe(ORG_ID);
    expect(identity.user.id).toBe(USER_ID);
    expect(identity.apiKey.organizationId).toBe(ORG_ID);
    expect([...identity.permissions]).toEqual(['device:read']);
  });

  it('rejects a key with no server-assigned organization', async () => {
    const { binder } = await makeBinder({ apiKeyOrgId: null });

    await expect(
      binder.bindVerifiedApiKey({ id: API_KEY_ID, referenceId: USER_ID, name: 'grafana' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects when the key owner is not a member', async () => {
    const { binder } = await makeBinder({ member: null });

    await expect(
      binder.bindVerifiedApiKey({ id: API_KEY_ID, referenceId: USER_ID, name: 'grafana' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a deleted organization', async () => {
    const member = makeMember();
    member.organization.deletedAt = new Date();
    const { binder } = await makeBinder({ member });

    await expect(
      binder.bindVerifiedApiKey({ id: API_KEY_ID, referenceId: USER_ID, name: 'grafana' }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('rejects a banned user', async () => {
    const member = makeMember();
    member.user.banned = true;
    member.user.banExpires = null;
    const { binder } = await makeBinder({ member });

    await expect(
      binder.bindVerifiedApiKey({ id: API_KEY_ID, referenceId: USER_ID, name: 'grafana' }),
    ).rejects.toMatchObject({ status: 403 });
  });
});
