import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AuthClient } from '@repo/auth';
import { requireSystemRoleId } from '@repo/auth/rbac';
import { OrganizationMembershipRole } from '@repo/database';
import type { Server } from 'http';
import request from 'supertest';
import { PrismaClient } from '../src/prisma/prisma.client';
import { AppModule } from './../src/app.module';
import { makeAuthzFixtures } from './support/authz-fixtures';

describe('API key authorization (e2e, live guards)', () => {
  let app: INestApplication;
  let server: Server;
  let prisma: PrismaClient;
  let authClient: AuthClient;

  const { Owner, Admin, Member } = OrganizationMembershipRole;
  let fx: ReturnType<typeof makeAuthzFixtures>;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    server = app.getHttpServer() as Server;
    prisma = app.get(PrismaClient);
    authClient = app.get('AUTH_CLIENT');
    fx = makeAuthzFixtures(prisma, authClient);
  }, 120_000);

  afterAll(async () => {
    await app.close();
  });

  const mkOrg = () => fx.mkOrg();
  const mkUser = () => fx.mkUser();
  const mkMember = (userId: string, organizationId: string, role: OrganizationMembershipRole) =>
    fx.mkMember(userId, organizationId, role);
  const mkKey = (userId: string, organizationId: string, flatPerms?: string[]) =>
    fx.mkKey(userId, organizationId, flatPerms);
  const actor = (role: OrganizationMembershipRole, keyScope?: string[]) => fx.actor(role, keyScope);
  const uniq = () => fx.uniq();

  const listKeys = (key: string) => request(server).get('/api/v1/organizations/api-keys').set('x-api-key', key);
  const getKey = (key: string, id: string) =>
    request(server).get(`/api/v1/organizations/api-keys/${id}`).set('x-api-key', key);
  const createKey = (key: string, body: object) =>
    request(server).post('/api/v1/organizations/api-keys').set('x-api-key', key).send(body);
  const updateKey = (key: string, id: string, body: object) =>
    request(server).patch(`/api/v1/organizations/api-keys/${id}`).set('x-api-key', key).send(body);
  const deleteKey = (key: string, id: string) =>
    request(server).delete(`/api/v1/organizations/api-keys/${id}`).set('x-api-key', key);

  describe('happy paths', () => {
    it('admin can create an API key', async () => {
      const admin = await actor(Admin);
      await createKey(admin.authKey.key, { name: 'new' }).expect(201);
    });

    it('member can create their own API key', async () => {
      const member = await actor(Member);
      await createKey(member.authKey.key, { name: 'mine' }).expect(201);
    });

    it('member can list keys in their org', async () => {
      const member = await actor(Member);
      await listKeys(member.authKey.key).expect(200);
    });

    it('a member can edit the scope of a key they own', async () => {
      const member = await actor(Member);
      await updateKey(member.authKey.key, member.authKey.id, { permissions: null }).expect(200);
    });

    it('an admin can edit another member’s key', async () => {
      const org = await mkOrg();
      const admin = await mkUser();
      const bob = await mkUser();
      await mkMember(admin.id, org.id, Admin);
      await mkMember(bob.id, org.id, Member);
      const adminKey = await mkKey(admin.id, org.id);
      const bobKey = await mkKey(bob.id, org.id);
      await updateKey(adminKey.key, bobKey.id, { permissions: null }).expect(200);
    });

    it('an admin can DELETE another member’s key (the delete-via-Prisma fix)', async () => {
      const org = await mkOrg();
      const admin = await mkUser();
      const bob = await mkUser();
      await mkMember(admin.id, org.id, Admin);
      await mkMember(bob.id, org.id, Member);
      const adminKey = await mkKey(admin.id, org.id);
      const bobKey = await mkKey(bob.id, org.id);
      await deleteKey(adminKey.key, bobKey.id).expect(204);
      expect(await prisma.apiKey.findUnique({ where: { id: bobKey.id } })).toBeNull();
    });

    it('a member can delete their own key', async () => {
      const member = await actor(Member);
      const own = await mkKey(member.userId, member.orgId);
      await deleteKey(member.authKey.key, own.id).expect(204);
    });
  });

  describe('sad paths — the guard blocks the attempt', () => {
    it('member CANNOT edit another user’s key → 403', async () => {
      const org = await mkOrg();
      const alice = await mkUser();
      const bob = await mkUser();
      await mkMember(alice.id, org.id, Member);
      await mkMember(bob.id, org.id, Member);
      const aliceKey = await mkKey(alice.id, org.id);
      const bobKey = await mkKey(bob.id, org.id);
      await updateKey(aliceKey.key, bobKey.id, { permissions: null }).expect(403);
    });

    it('member CANNOT delete another user’s key → 403', async () => {
      const org = await mkOrg();
      const alice = await mkUser();
      const bob = await mkUser();
      await mkMember(alice.id, org.id, Member);
      await mkMember(bob.id, org.id, Member);
      const aliceKey = await mkKey(alice.id, org.id);
      const bobKey = await mkKey(bob.id, org.id);
      await deleteKey(aliceKey.key, bobKey.id).expect(403);
      expect(await prisma.apiKey.findUnique({ where: { id: bobKey.id } })).not.toBeNull();
    });

    it('CANNOT create a key scoped to a permission the actor lacks (escalation) → 403', async () => {
      const member = await actor(Member);
      await createKey(member.authKey.key, { name: 'escalate', permissions: ['api-key:delete'] }).expect(403);
    });

    it('CANNOT update a key to escalate beyond the actor’s own permissions → 403', async () => {
      const member = await actor(Member);
      await updateKey(member.authKey.key, member.authKey.id, { permissions: ['api-key:delete'] }).expect(403);
    });

    it('an admin CANNOT scope a member’s key beyond the OWNER’s permissions → 403', async () => {
      const org = await mkOrg();
      const admin = await mkUser();
      const bob = await mkUser();
      await mkMember(admin.id, org.id, Admin);
      await mkMember(bob.id, org.id, Member);
      const adminKey = await mkKey(admin.id, org.id);
      const bobKey = await mkKey(bob.id, org.id);
      await updateKey(adminKey.key, bobKey.id, { permissions: ['api-key:delete'] }).expect(403);
      const ok = await updateKey(adminKey.key, bobKey.id, { permissions: ['api-key:read'] }).expect(200);
      expect(ok.body.permissions).toEqual(['api-key:read']);
    });

    it('a scoped key cannot exceed its own scope even if the owner’s role could → 403', async () => {
      const owner = await actor(Owner, ['api-key:read']);
      await createKey(owner.authKey.key, { name: 'nope' }).expect(403);
      await listKeys(owner.authKey.key).expect(200);
    });
  });

  describe('cross-org isolation (IDOR) — foreign keys are invisible', () => {
    it('GET a key from another org → 404', async () => {
      const a = await actor(Admin);
      const b = await actor(Admin);
      const bKey = await mkKey(b.userId, b.orgId);
      await getKey(a.authKey.key, bKey.id).expect(404);
    });

    it('UPDATE a key from another org → 404', async () => {
      const a = await actor(Admin);
      const b = await actor(Admin);
      const bKey = await mkKey(b.userId, b.orgId);
      await updateKey(a.authKey.key, bKey.id, { permissions: null }).expect(404);
    });

    it('DELETE a key from another org → 404 (and the row survives)', async () => {
      const a = await actor(Admin);
      const b = await actor(Admin);
      const bKey = await mkKey(b.userId, b.orgId);
      await deleteKey(a.authKey.key, bKey.id).expect(404);
      expect(await prisma.apiKey.findUnique({ where: { id: bKey.id } })).not.toBeNull();
    });
  });

  describe('live role changes narrow keys immediately', () => {
    it('a full-inherit key minted as Admin loses admin powers the moment the owner is demoted', async () => {
      const org = await mkOrg();
      const alice = await mkUser();
      const bob = await mkUser();
      const aliceMember = await mkMember(alice.id, org.id, Admin);
      await mkMember(bob.id, org.id, Member);
      const aliceKey = await mkKey(alice.id, org.id);
      const target1 = await mkKey(bob.id, org.id);
      const target2 = await mkKey(bob.id, org.id);

      await deleteKey(aliceKey.key, target1.id).expect(204);

      const memberRoleId = await requireSystemRoleId(prisma, Member);
      await prisma.member.update({
        where: { id: aliceMember.id },
        data: { role: Member, assignedRoleId: memberRoleId },
      });

      await deleteKey(aliceKey.key, target2.id).expect(403);
      expect(await prisma.apiKey.findUnique({ where: { id: target2.id } })).not.toBeNull();
    });
  });

  describe('authentication boundary', () => {
    it('no API key → 401', async () => {
      await request(server).get('/api/v1/organizations/api-keys').expect(401);
    });

    it('invalid API key → 401', async () => {
      await listKeys('brk_this-is-not-a-real-key').expect(401);
    });

    it('a key whose owner was removed from the org → 401', async () => {
      const org = await mkOrg();
      const user = await mkUser();
      const member = await mkMember(user.id, org.id, Member);
      const key = await mkKey(user.id, org.id);
      await listKeys(key.key).expect(200);
      await prisma.member.update({ where: { id: member.id }, data: { deletedAt: new Date() } });
      await listKeys(key.key).expect(401);
    });
  });

  describe('cross-tenant isolation (active-record)', () => {
    it('the zones list returns only the caller’s org, never another org’s rows', async () => {
      const a = await actor(Admin);
      const b = await actor(Admin);
      const zoneA = await prisma.zone.create({ data: { name: `za-${uniq()}`, organizationId: a.orgId } });
      const zoneB = await prisma.zone.create({ data: { name: `zb-${uniq()}`, organizationId: b.orgId } });

      const res = await listZones(a.authKey.key).expect(200);
      const ids = res.body.data.map((z: { id: string }) => z.id);
      expect(ids).toContain(zoneA.id);
      expect(ids).not.toContain(zoneB.id);
    });
  });

  const listZones = (key: string) => request(server).get('/api/v1/zones').set('x-api-key', key);
});
