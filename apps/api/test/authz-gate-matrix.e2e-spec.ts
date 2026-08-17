import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AuthClient } from '@repo/auth';
import { OrganizationMembershipRole } from '@repo/database';
import type { Server } from 'http';
import request from 'supertest';
import { PrismaClient } from '../src/prisma/prisma.client';
import { AppModule } from './../src/app.module';
import { makeAuthzFixtures } from './support/authz-fixtures';

describe('authorization gate matrix (e2e, per resource)', () => {
  let app: INestApplication;
  let server: Server;
  let prisma: PrismaClient;
  let authClient: AuthClient;
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

  const ENDPOINTS: Array<{ resource: string; path: string; perm: string; unrelated: string }> = [
    { resource: 'api-key', path: '/api/v1/organizations/api-keys', perm: 'api-key:read', unrelated: 'zone:read' },
    { resource: 'webhook', path: '/api/v1/organizations/webhooks', perm: 'webhook:read', unrelated: 'zone:read' },
    { resource: 'member', path: '/api/v1/organizations/memberships', perm: 'member:read', unrelated: 'zone:read' },
    { resource: 'ipam', path: '/api/v1/ipam/vrfs', perm: 'ipam:read', unrelated: 'zone:read' },
    { resource: 'device', path: '/api/v1/servers', perm: 'device:read', unrelated: 'zone:read' },
    { resource: 'device-model', path: '/api/v1/device-models', perm: 'device-model:read', unrelated: 'zone:read' },
    { resource: 'zone', path: '/api/v1/zones', perm: 'zone:read', unrelated: 'api-key:read' },
    { resource: 'deployment', path: '/api/v1/deployments', perm: 'deployment:read', unrelated: 'api-key:read' },
  ];

  for (const { resource, path, perm, unrelated } of ENDPOINTS) {
    describe(`${resource} → ${path}`, () => {
      it(`allows a key scoped to ${perm} → 200`, async () => {
        const a = await fx.actor(OrganizationMembershipRole.Owner, [perm]);
        await request(server).get(path).set('x-api-key', a.authKey.key).expect(200);
      });

      it(`blocks a key without ${perm} → 403`, async () => {
        const a = await fx.actor(OrganizationMembershipRole.Owner, [unrelated]);
        await request(server).get(path).set('x-api-key', a.authKey.key).expect(403);
      });
    });
  }
});
