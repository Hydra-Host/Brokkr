import { OrganizationMembershipRole } from '@repo/database';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PrismaClient } from '../../../prisma/prisma.client';
import { seedBypassUser } from '../seed-bypass-user';

const roleIds = {
  owner: 'role-owner',
  admin: 'role-admin',
  member: 'role-member',
};

function makeApp(options?: { existingUsers?: boolean; missingRole?: keyof typeof roleIds }) {
  const signUpEmail = options?.existingUsers
    ? vi.fn().mockRejectedValue(new Error('USER_ALREADY_EXISTS'))
    : vi.fn().mockResolvedValue({});
  const memberUpsert = vi.fn().mockResolvedValue({});
  const users = new Map([
    ['brokkr@brokkr.local', { id: 'user-owner' }],
    ['brokkr-1@brokkr.local', { id: 'user-member' }],
    ['brokkr-2@brokkr.local', { id: 'user-admin' }],
    ['demand@brokkr.local', { id: 'user-demand' }],
    ['supply@brokkr.local', { id: 'user-supply' }],
  ]);
  const prisma = {
    organization: {
      updateMany: vi.fn(),
      upsert: vi.fn().mockResolvedValue({}),
    },
    organizationMemberRole: {
      findMany: vi.fn(({ where }: { where: { slug: keyof typeof roleIds } }) =>
        Promise.resolve(where.slug === options?.missingRole ? [] : [{ id: roleIds[where.slug] }]),
      ),
    },
    user: {
      findUnique: vi.fn(({ where }: { where: { email: string } }) => Promise.resolve(users.get(where.email) ?? null)),
    },
    member: { upsert: memberUpsert },
    account: { updateMany: vi.fn() },
  };
  const auth = { api: { signUpEmail } };
  const get = vi.fn((token) => (token === PrismaClient ? prisma : auth));
  return { app: { get } as never, get, signUpEmail, memberUpsert, prisma };
}

function bossMembershipCalls(memberUpsert: ReturnType<typeof vi.fn>) {
  return memberUpsert.mock.calls
    .map(([call]) => call)
    .filter((call) => call.create.organizationId === '00000000-0000-0000-0000-000000000000');
}

describe('seedBypassUser local BoSS identities', () => {
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('HH_ENV', 'dev');
    vi.stubEnv('AUTH_BYPASS_ENABLED', 'true');
    vi.stubEnv('HH_FORCE_BOSS', 'true');
    vi.spyOn(console, 'info').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('creates Owner, Member, and Admin users in the all-zero BoSS organization', async () => {
    const { app, signUpEmail, memberUpsert } = makeApp();
    await seedBypassUser(app, { authClientToken: 'AUTH_CLIENT' });

    expect(signUpEmail).toHaveBeenCalledWith({
      body: expect.objectContaining({ email: 'brokkr@brokkr.local', name: 'brokkr' }),
    });
    expect(signUpEmail).toHaveBeenCalledWith({
      body: expect.objectContaining({ email: 'brokkr-1@brokkr.local', name: 'brokkr-1' }),
    });
    expect(signUpEmail).toHaveBeenCalledWith({
      body: expect.objectContaining({ email: 'brokkr-2@brokkr.local', name: 'brokkr-2' }),
    });

    const memberships = bossMembershipCalls(memberUpsert);
    expect(memberships.map(({ create }) => [create.userId, create.role, create.assignedRoleId])).toEqual([
      ['user-owner', OrganizationMembershipRole.Owner, roleIds.owner],
      ['user-member', OrganizationMembershipRole.Member, roleIds.member],
      ['user-admin', OrganizationMembershipRole.Admin, roleIds.admin],
    ]);
  });

  it('preserves the primary user assigned role while reconciling Member/Admin users', async () => {
    const { app, memberUpsert } = makeApp({ existingUsers: true });
    await seedBypassUser(app, { authClientToken: 'AUTH_CLIENT' });
    await seedBypassUser(app, { authClientToken: 'AUTH_CLIENT' });

    const memberships = bossMembershipCalls(memberUpsert);
    expect(memberships).toHaveLength(6);
    for (const call of memberships) {
      if (call.create.userId === 'user-owner') {
        expect(call.update).toEqual({
          role: OrganizationMembershipRole.Owner,
          deletedAt: null,
        });
      } else {
        expect(call.update).toEqual({
          role: call.create.role,
          assignedRoleId: call.create.assignedRoleId,
          deletedAt: null,
        });
      }
    }
  });

  it('fails loudly when a required seeded system role is missing', async () => {
    const { app, memberUpsert } = makeApp({ missingRole: 'admin' });
    await expect(seedBypassUser(app, { authClientToken: 'AUTH_CLIENT' })).rejects.toThrow(
      /Required active system role "admin"/,
    );
    expect(bossMembershipCalls(memberUpsert).some(({ create }) => create.userId === 'user-admin')).toBe(false);
  });

  it('does nothing when the local auth-bypass policy is disabled', async () => {
    vi.stubEnv('AUTH_BYPASS_ENABLED', '');
    const { app, get } = makeApp();
    await seedBypassUser(app, { authClientToken: 'AUTH_CLIENT' });
    expect(get).not.toHaveBeenCalled();
  });
});
