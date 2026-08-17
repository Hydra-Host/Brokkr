import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AuthClient } from '@repo/auth';
import { permissionKey } from '@repo/auth/rbac';
import { OrganizationMembershipRole } from '@repo/database';
import type { Server } from 'http';
import request, { type Response } from 'supertest';
import { AppModule } from '../src/app.module';
import { seedBypassUser } from '../src/common/bootstrap/seed-bypass-user';
import { MAIN_APP_PERMISSIONS } from '../src/permissions/permissions.constants';
import { PrismaClient } from '../src/prisma/prisma.client';
import { makeAuthzFixtures } from './support/authz-fixtures';

process.env.AUTH_BYPASS_ALLOWED_ENVS = 'test';
// eslint-disable-next-line turbo/no-undeclared-env-vars -- this suite boots the local-only seed policy.
process.env.AUTH_BYPASS_ENABLED = 'true';

const API = '/api/v1';
const LOCAL_ORG_ID = '00000000-0000-0000-0000-000000000000';
const LOCAL_PASSWORD = 'brokkr';

describe('ownership capability authorization (e2e, isolated database)', () => {
  let app: INestApplication;
  let server: Server;
  let prisma: PrismaClient;
  let authClient: AuthClient;
  let fx: ReturnType<typeof makeAuthzFixtures>;
  let ownerRoleId: string;
  let adminRoleId: string;
  let memberRoleId: string;
  const allPermissionKeys = MAIN_APP_PERMISSIONS.map(({ resource, action }) => permissionKey(resource, action));

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    server = app.getHttpServer() as Server;
    prisma = app.get(PrismaClient);
    authClient = app.get('AUTH_CLIENT');
    fx = makeAuthzFixtures(prisma, authClient);

    ownerRoleId = await requiredSystemRoleId('owner');
    adminRoleId = await requiredSystemRoleId('admin');
    memberRoleId = await requiredSystemRoleId('member');
    await seedBypassUser(app, { authClientToken: 'AUTH_CLIENT', rehashCredential: true });
  }, 120_000);

  afterAll(async () => {
    await app.close();
  });

  async function requiredSystemRoleId(slug: string): Promise<string> {
    const role = await prisma.organizationMemberRole.findFirst({
      where: { slug, isSystem: true, organizationId: null },
      select: { id: true },
    });
    if (!role) throw new Error(`Missing seeded system role ${slug}`);
    return role.id;
  }

  function cookieHeader(response: Response): string {
    const setCookie = response.headers['set-cookie'];
    if (!setCookie) throw new Error('Authentication response did not set a session cookie');
    const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
    return cookies.map((cookie) => cookie.split(';')[0]).join('; ');
  }

  async function login(email: string, password: string, organizationId: string): Promise<string> {
    const response = await request(server).post(`${API}/auth/sign-in/email`).send({ email, password }).expect(200);
    const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
    if (!user) throw new Error(`Signed-in user ${email} not found`);
    await prisma.session.updateMany({
      where: { userId: user.id },
      data: { activeOrganizationId: organizationId },
    });
    return cookieHeader(response);
  }

  async function sessionActor(roleId: string, organizationId?: string) {
    const org = organizationId
      ? await prisma.organization.findUniqueOrThrow({ where: { id: organizationId } })
      : await fx.mkOrg();
    const email = `session-${fx.uniq()}@example.com`;
    const password = `Pw-${fx.uniq()}`;
    await request(server)
      .post(`${API}/auth/sign-up/email`)
      .send({ email, password, name: email, firstName: 'E2E', lastName: 'Actor' })
      .expect(200);
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    await prisma.member.upsert({
      where: { userId_organizationId: { userId: user.id, organizationId: org.id } },
      update: { assignedRoleId: roleId, deletedAt: null },
      create: {
        userId: user.id,
        organizationId: org.id,
        role: OrganizationMembershipRole.Member,
        assignedRoleId: roleId,
      },
    });
    return { org, user, cookie: await login(email, password, org.id) };
  }

  async function memberIn(organizationId: string, roleId: string) {
    const user = await fx.mkUser();
    const membership = await prisma.member.create({
      data: {
        userId: user.id,
        organizationId,
        role: OrganizationMembershipRole.Member,
        assignedRoleId: roleId,
      },
    });
    return { user, membership };
  }

  async function customRole(organizationId: string, permissions: string[], label = 'custom') {
    const records = await prisma.permission.findMany({
      where: {
        OR: permissions.map((key) => {
          const [resource, action] = key.split(':');
          return { resource, action };
        }),
      },
    });
    if (records.length !== permissions.length) throw new Error('Fixture permission lookup was incomplete');
    return prisma.organizationMemberRole.create({
      data: {
        name: `${label}-${fx.uniq()}`,
        slug: `${label}-${fx.uniq()}`,
        isSystem: false,
        organizationId,
        rolePermissions: { create: records.map(({ id }) => ({ permissionId: id })) },
      },
    });
  }

  const grantOwner = (cookie: string, memberId: string, roleId: string) =>
    request(server)
      .post(`${API}/organizations/memberships/${memberId}/owner-access`)
      .set('Cookie', cookie)
      .send({ roleId });
  const revokeOwner = (cookie: string, memberId: string, replacementRoleId: string) =>
    request(server)
      .post(`${API}/organizations/memberships/${memberId}/owner-access/revoke`)
      .set('Cookie', cookie)
      .send({ replacementRoleId });
  const transferOwner = (
    cookie: string,
    body: {
      sourceMemberId: string;
      recipientMemberId: string;
      ownerRoleId: string;
      sourceReplacementRoleId: string;
    },
  ) => request(server).post(`${API}/organizations/ownership/transfer`).set('Cookie', cookie).send(body);
  const assignRole = (cookie: string, memberId: string, roleId: string) =>
    request(server)
      .patch(`${API}/organizations/memberships/${memberId}/role-assignment`)
      .set('Cookie', cookie)
      .send({ roleId });

  it('allows an owner-capable session to grant owner access in its organization', async () => {
    const owner = await sessionActor(ownerRoleId);
    const target = await memberIn(owner.org.id, memberRoleId);
    await grantOwner(owner.cookie, target.membership.id, ownerRoleId).expect(200);
    expect(
      await prisma.member.findUniqueOrThrow({ where: { id: target.membership.id }, select: { assignedRoleId: true } }),
    ).toEqual({ assignedRoleId: ownerRoleId });
  });

  it('denies grant, revoke, and transfer to an ordinary manager', async () => {
    const admin = await sessionActor(adminRoleId);
    const target = await memberIn(admin.org.id, memberRoleId);
    await grantOwner(admin.cookie, target.membership.id, ownerRoleId).expect(403);
    await revokeOwner(admin.cookie, target.membership.id, memberRoleId).expect(403);
    await transferOwner(admin.cookie, {
      sourceMemberId: target.membership.id,
      recipientMemberId: target.membership.id,
      ownerRoleId,
      sourceReplacementRoleId: memberRoleId,
    }).expect(403);
  });

  it('denies ownership operations to an owner member API key', async () => {
    const org = await fx.mkOrg();
    const owner = await fx.mkUser();
    await prisma.member.create({
      data: {
        userId: owner.id,
        organizationId: org.id,
        role: OrganizationMembershipRole.Owner,
        assignedRoleId: ownerRoleId,
      },
    });
    const key = await fx.mkKey(owner.id, org.id);
    const target = await memberIn(org.id, memberRoleId);
    await request(server)
      .post(`${API}/organizations/memberships/${target.membership.id}/owner-access`)
      .set('x-api-key', key.key)
      .send({ roleId: ownerRoleId })
      .expect(403);
  });

  it('hides cross-org members and custom roles', async () => {
    const owner = await sessionActor(ownerRoleId);
    const foreignOrg = await fx.mkOrg();
    const foreignMember = await memberIn(foreignOrg.id, memberRoleId);
    const foreignOwnerRole = await customRole(foreignOrg.id, allPermissionKeys, 'foreign-owner');
    await grantOwner(owner.cookie, foreignMember.membership.id, ownerRoleId).expect(404);
    const localTarget = await memberIn(owner.org.id, memberRoleId);
    await grantOwner(owner.cookie, localTarget.membership.id, foreignOwnerRole.id).expect(404);
  });

  it('blocks owner-capable roles and targets from generic assignment', async () => {
    const owner = await sessionActor(ownerRoleId);
    const ordinary = await memberIn(owner.org.id, memberRoleId);
    await assignRole(owner.cookie, ordinary.membership.id, ownerRoleId).expect(403);
    const protectedMember = await memberIn(owner.org.id, ownerRoleId);
    await assignRole(owner.cookie, protectedMember.membership.id, memberRoleId).expect(403);
  });

  it('protects the last owner and revokes to the exact replacement when another remains', async () => {
    const source = await sessionActor(ownerRoleId);
    await revokeOwner(
      source.cookie,
      (
        await prisma.member.findFirstOrThrow({
          where: { userId: source.user.id, organizationId: source.org.id },
        })
      ).id,
      memberRoleId,
    ).expect(400);

    await memberIn(source.org.id, ownerRoleId);
    const sourceMember = await prisma.member.findFirstOrThrow({
      where: { userId: source.user.id, organizationId: source.org.id },
    });
    await revokeOwner(source.cookie, sourceMember.id, memberRoleId).expect(200);
    expect((await prisma.member.findUniqueOrThrow({ where: { id: sourceMember.id } })).assignedRoleId).toBe(
      memberRoleId,
    );
  });

  it('transfers atomically and leaves both unchanged when validation fails', async () => {
    const source = await sessionActor(ownerRoleId);
    const sourceMember = await prisma.member.findFirstOrThrow({
      where: { userId: source.user.id, organizationId: source.org.id },
    });
    const recipient = await sessionActor(memberRoleId, source.org.id);
    const recipientMember = await prisma.member.findFirstOrThrow({
      where: { userId: recipient.user.id, organizationId: source.org.id },
    });
    await transferOwner(source.cookie, {
      sourceMemberId: sourceMember.id,
      recipientMemberId: recipientMember.id,
      ownerRoleId,
      sourceReplacementRoleId: memberRoleId,
    }).expect(200);
    expect(
      await prisma.member.findMany({
        where: { id: { in: [sourceMember.id, recipientMember.id] } },
        orderBy: { id: 'asc' },
        select: { id: true, assignedRoleId: true },
      }),
    ).toEqual(
      [
        { id: sourceMember.id, assignedRoleId: memberRoleId },
        { id: recipientMember.id, assignedRoleId: ownerRoleId },
      ].sort((left, right) => left.id.localeCompare(right.id)),
    );

    const secondRecipient = await memberIn(source.org.id, memberRoleId);
    const before = await prisma.member.findMany({
      where: { id: { in: [recipientMember.id, secondRecipient.membership.id] } },
      orderBy: { id: 'asc' },
      select: { id: true, assignedRoleId: true },
    });
    await transferOwner(recipient.cookie, {
      sourceMemberId: recipientMember.id,
      recipientMemberId: secondRecipient.membership.id,
      ownerRoleId,
      sourceReplacementRoleId: ownerRoleId,
    }).expect(400);
    expect(
      await prisma.member.findMany({
        where: { id: { in: [recipientMember.id, secondRecipient.membership.id] } },
        orderBy: { id: 'asc' },
        select: { id: true, assignedRoleId: true },
      }),
    ).toEqual(before);
  });

  it('enforces strict dominance for ordinary member changes', async () => {
    const strictOrg = await fx.mkOrg();
    const managerRole = await customRole(strictOrg.id, ['member:read', 'member:change-role'], 'manager');
    const readerRole = await customRole(strictOrg.id, ['member:read'], 'reader');
    const manager = await sessionActor(managerRole.id, strictOrg.id);
    const subset = await memberIn(strictOrg.id, readerRole.id);
    await assignRole(manager.cookie, subset.membership.id, readerRole.id).expect(200);
    const equal = await memberIn(strictOrg.id, managerRole.id);
    await assignRole(manager.cookie, equal.membership.id, managerRole.id).expect(403);

    const incomparableOrg = await fx.mkOrg();
    const changeOnlyRole = await customRole(incomparableOrg.id, ['member:change-role'], 'change-only');
    const incomparableReader = await customRole(incomparableOrg.id, ['member:read'], 'reader');
    const incomparableActor = await sessionActor(changeOnlyRole.id, incomparableOrg.id);
    const incomparableTarget = await memberIn(incomparableOrg.id, incomparableReader.id);
    await assignRole(incomparableActor.cookie, incomparableTarget.membership.id, changeOnlyRole.id).expect(403);
  });

  it('requires an owner-capable session for owner invitations and preserves the exact role on acceptance', async () => {
    const owner = await sessionActor(ownerRoleId);
    const admin = await sessionActor(adminRoleId, owner.org.id);
    await request(server)
      .post(`${API}/organizations/invitations`)
      .set('Cookie', admin.cookie)
      .send({ email: `denied-${fx.uniq()}@example.com`, roleId: ownerRoleId })
      .expect(403);

    const inviteeHome = await fx.mkOrg();
    const invitee = await sessionActor(memberRoleId, inviteeHome.id);
    const invitation = await request(server)
      .post(`${API}/organizations/invitations`)
      .set('Cookie', owner.cookie)
      .send({ email: invitee.user.email, roleId: ownerRoleId })
      .expect(200);
    await request(server)
      .post(`${API}/organizations/invitations/${invitation.body.id}/accept`)
      .set('Cookie', invitee.cookie)
      .send({})
      .expect(200);
    expect(
      await prisma.member.findUniqueOrThrow({
        where: { userId_organizationId: { userId: invitee.user.id, organizationId: owner.org.id } },
        select: { assignedRoleId: true },
      }),
    ).toEqual({ assignedRoleId: ownerRoleId });
  });

  it('rejects partial reserved roles and allows a full-catalog owner role create/update', async () => {
    const owner = await sessionActor(ownerRoleId);
    await request(server)
      .post(`${API}/organizations/roles`)
      .set('Cookie', owner.cookie)
      .send({
        name: 'Partial Owner',
        slug: `partial-owner-${fx.uniq()}`,
        permissions: ['organization:manage-owners'],
      })
      .expect(400);

    const created = await request(server)
      .post(`${API}/organizations/roles`)
      .set('Cookie', owner.cookie)
      .send({
        name: 'Custom Owner',
        slug: `custom-owner-${fx.uniq()}`,
        permissions: allPermissionKeys,
      })
      .expect(201);
    expect(created.body.isOwnerCapable).toBe(true);
    await request(server)
      .patch(`${API}/organizations/roles/${created.body.id}`)
      .set('Cookie', owner.cookie)
      .send({ permissions: allPermissionKeys })
      .expect(200);
  });

  it('hides admin-catalog roles and guessed IDs across every public role path', async () => {
    const owner = await sessionActor(ownerRoleId);
    const ownerMember = await prisma.member.findFirstOrThrow({
      where: { userId: owner.user.id, organizationId: owner.org.id },
    });
    const adminPermission = await prisma.permission.upsert({
      where: { resource_action: { resource: 'admin.organizations', action: 'manage-members' } },
      update: {},
      create: {
        resource: 'admin.organizations',
        action: 'manage-members',
        description: 'Private admin test permission',
      },
    });
    const mainPermissions = await prisma.permission.findMany({
      where: {
        OR: MAIN_APP_PERMISSIONS.map(({ resource, action }) => ({ resource, action })),
      },
      select: { id: true },
    });
    const hiddenRole = await prisma.organizationMemberRole.create({
      data: {
        name: 'Local Admin Secret',
        slug: `local-admin-${fx.uniq()}`,
        organizationId: owner.org.id,
        rolePermissions: {
          create: [...mainPermissions, adminPermission].map(({ id }) => ({ permissionId: id })),
        },
      },
    });
    await prisma.member.update({
      where: { id: ownerMember.id },
      data: { assignedRoleId: hiddenRole.id },
    });
    const target = await memberIn(owner.org.id, memberRoleId);
    const hiddenInvitation = await prisma.invitation.create({
      data: {
        email: `legacy-hidden-${fx.uniq()}@example.com`,
        inviterId: owner.user.id,
        organizationId: owner.org.id,
        assignedRoleId: hiddenRole.id,
        status: 'pending',
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

    const roles = await request(server).get(`${API}/organizations/roles`).set('Cookie', owner.cookie).expect(200);
    expect(roles.body.map((role: { id: string }) => role.id)).not.toContain(hiddenRole.id);

    await request(server).get(`${API}/organizations/roles/${hiddenRole.id}`).set('Cookie', owner.cookie).expect(404);
    await assignRole(owner.cookie, target.membership.id, hiddenRole.id).expect(404);
    await request(server)
      .post(`${API}/organizations/invitations`)
      .set('Cookie', owner.cookie)
      .send({ email: `hidden-${fx.uniq()}@example.com`, roleId: hiddenRole.id })
      .expect(404);
    await request(server)
      .post(`${API}/organizations/roles/clone`)
      .set('Cookie', owner.cookie)
      .send({ systemRoleId: hiddenRole.id, name: 'Clone', slug: `clone-${fx.uniq()}` })
      .expect(404);
    await request(server)
      .patch(`${API}/organizations/roles/${hiddenRole.id}`)
      .set('Cookie', owner.cookie)
      .send({ permissions: allPermissionKeys })
      .expect(404);
    await request(server).delete(`${API}/organizations/roles/${hiddenRole.id}`).set('Cookie', owner.cookie).expect(404);

    const organizations = await request(server).get(`${API}/organizations`).set('Cookie', owner.cookie).expect(200);
    expect(organizations.body.data).toContainEqual(
      expect.objectContaining({
        id: owner.org.id,
        role: 'Managed role',
        assignedRoleId: null,
      }),
    );

    const members = await request(server)
      .get(`${API}/organizations/memberships`)
      .set('Cookie', owner.cookie)
      .expect(200);
    expect(members.body.data).toContainEqual(
      expect.objectContaining({
        id: ownerMember.id,
        role: 'Managed role',
        assignedRoleId: null,
      }),
    );

    const invitations = await request(server)
      .get(`${API}/organizations/invitations`)
      .set('Cookie', owner.cookie)
      .expect(200);
    expect(invitations.body.data).toContainEqual(
      expect.objectContaining({
        id: hiddenInvitation.id,
        role: 'Managed role',
        roleId: null,
      }),
    );
  });

  it('prevents member removal from eliminating ownership', async () => {
    const owner = await sessionActor(ownerRoleId);
    const ownerMember = await prisma.member.findFirstOrThrow({
      where: { userId: owner.user.id, organizationId: owner.org.id },
    });
    await request(server)
      .delete(`${API}/organizations/memberships/${ownerMember.id}`)
      .set('Cookie', owner.cookie)
      .expect(403);
    expect(await prisma.member.findUnique({ where: { id: ownerMember.id } })).not.toBeNull();
  });

  it('resolves local Owner, Admin, and Member capabilities and denies owner operations to the subsets', async () => {
    const localUsers = await prisma.user.findMany({
      where: { email: { in: ['brokkr@brokkr.local', 'brokkr-1@brokkr.local', 'brokkr-2@brokkr.local'] } },
      include: {
        members: {
          where: { organizationId: LOCAL_ORG_ID, deletedAt: null },
          include: { assignedRole: { include: { rolePermissions: { include: { permission: true } } } } },
        },
      },
      orderBy: { email: 'asc' },
    });
    expect(localUsers).toHaveLength(3);
    expect(localUsers.map((user) => [user.email, user.members[0]?.assignedRole?.name])).toEqual([
      ['brokkr-1@brokkr.local', 'Member'],
      ['brokkr-2@brokkr.local', 'Admin'],
      ['brokkr@brokkr.local', 'Owner'],
    ]);

    const memberCookie = await login('brokkr-1@brokkr.local', LOCAL_PASSWORD, LOCAL_ORG_ID);
    const adminCookie = await login('brokkr-2@brokkr.local', LOCAL_PASSWORD, LOCAL_ORG_ID);
    const ownerCookie = await login('brokkr@brokkr.local', LOCAL_PASSWORD, LOCAL_ORG_ID);
    const target = await memberIn(LOCAL_ORG_ID, memberRoleId);
    await grantOwner(memberCookie, target.membership.id, ownerRoleId).expect(403);
    await grantOwner(adminCookie, target.membership.id, ownerRoleId).expect(403);
    await grantOwner(ownerCookie, target.membership.id, ownerRoleId).expect(200);
  });
});
