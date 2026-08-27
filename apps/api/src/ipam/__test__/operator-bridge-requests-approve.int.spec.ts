import { ConflictException } from '@nestjs/common';
import { PluginMigrator } from '@hydrahost/plugin-runtime';
import { createPrismaClient, type PrismaClient as DatabasePrismaClient } from '@repo/database';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import pg from 'pg';
import { DesignationOperatorPolicy } from 'src/common/authz/operator-policy';
import { ContextService } from 'src/common/context/context.service';
import { EventLogRepository } from 'src/event-log/event-log.repository';
import { EventLogService } from 'src/event-log/event-log.service';
import { HostPluginIpamProvisioning } from 'src/ipam/host-plugin-ipam-provisioning';
import { IpAddressRepository } from 'src/ipam/ip-address/ip-address.repository';
import { IpAddressService } from 'src/ipam/ip-address/ip-address.service';
import { IpRangeRepository } from 'src/ipam/ip-range/ip-range.repository';
import { IpRangeService } from 'src/ipam/ip-range/ip-range.service';
import { IpamRoleRepository } from 'src/ipam/ipam-role/ipam-role.repository';
import { PrefixRepository } from 'src/ipam/prefix/prefix.repository';
import { PrefixService } from 'src/ipam/prefix/prefix.service';
import { PrismaClient } from 'src/prisma/prisma.client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const databasePackageDir = path.resolve(__dirname, '../../../../../packages/database');
const prismaCli = createRequire(path.join(databasePackageDir, 'package.json')).resolve('prisma/build/index.js');

const OPERATOR_BRIDGE_REQUESTS = '@hydrahost/plugin-operator-bridge-requests';

type ProvisionedPrefix = {
  role: string;
  cidr: string;
  prefixId: string;
  gatewayIpId: string | null;
  bridgeIpIds: string[];
  ipRangeIds: string[];
};

type BridgeRequest = {
  id: string;
  status: string;
  approvedBy: string | null;
  provisionResult: { prefixes: ProvisionedPrefix[] } | null;
};

type BridgeRequestsServiceLike = {
  create(input: Record<string, unknown>): Promise<BridgeRequest>;
  approve(id: string, input: { approvedBy: string }): Promise<BridgeRequest>;
  getById(id: string): Promise<BridgeRequest>;
};

type OperatorBridgeRequestsBackend = {
  BridgeRequestsService: new (
    repository: unknown,
    ipam: unknown,
    prisma: unknown,
  ) => BridgeRequestsServiceLike;
  BridgeRequestRepository: new (prisma: unknown) => unknown;
  BridgeRequestIpamService: new (hostIpam: HostPluginIpamProvisioning) => unknown;
};

type OperatorBridgeRequestsManifest = Parameters<PluginMigrator['applyAll']>[0][number];

function loadManaged<T>(specifier: string): T | undefined {
  try {
    return createRequire(__filename)(specifier);
  } catch {
    return undefined;
  }
}

const backend = loadManaged<OperatorBridgeRequestsBackend>(`${OPERATOR_BRIDGE_REQUESTS}/backend`);
const manifestModule = loadManaged<{ operatorBridgeRequestsManifest: OperatorBridgeRequestsManifest }>(
  OPERATOR_BRIDGE_REQUESTS,
);
const managedPluginPresent = backend !== undefined && manifestModule !== undefined;

const PRIMARY_CIDR = '10.99.0.0/24';
const MANAGEMENT_CIDR = '10.99.1.0/24';

async function isReachable(serverUrl: string): Promise<boolean> {
  const client = new pg.Client({ connectionString: serverUrl, connectionTimeoutMillis: 2_000 });
  try {
    await client.connect();
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => undefined);
  }
}

function toServerUrl(raw: string): string {
  const url = new URL(raw);
  url.pathname = '/postgres';
  return url.toString();
}

async function startDockerPostgres(): Promise<{ serverUrl: string; containerId: string }> {
  const run = spawnSync(
    'docker',
    [
      'run',
      '-d',
      '--rm',
      '-e',
      'POSTGRES_PASSWORD=postgres',
      '-e',
      'POSTGRES_USER=postgres',
      '-e',
      'POSTGRES_DB=postgres',
      '-p',
      '0:5432',
      'postgres:16-alpine',
    ],
    { encoding: 'utf8' },
  );
  if (run.status !== 0) {
    throw new Error(`unable to start Docker Postgres for integration test: ${run.stderr || run.error}`);
  }
  const containerId = run.stdout.trim();
  const portOut = execFileSync('docker', ['port', containerId, '5432/tcp'], { encoding: 'utf8' });
  const port = portOut.split('\n')[0]?.split(':').pop()?.trim();
  const serverUrl = `postgresql://postgres:postgres@localhost:${port}/postgres`;

  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (await isReachable(serverUrl)) return { serverUrl, containerId };
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  spawnSync('docker', ['stop', containerId]);
  throw new Error('Docker Postgres did not become ready in time');
}

function buildBridgeRequestsService(prisma: DatabasePrismaClient): BridgeRequestsServiceLike {
  const nestPrisma = prisma as unknown as PrismaClient;
  const contextService = new ContextService(new DesignationOperatorPolicy());
  const dhcpPublisher = {
    republishPrefixes: vi.fn().mockResolvedValue(undefined),
    republishForIpAddress: vi.fn().mockResolvedValue(undefined),
    republishForReservation: vi.fn().mockResolvedValue(undefined),
    republishForDevice: vi.fn().mockResolvedValue(undefined),
    republishOne: vi.fn().mockResolvedValue(true),
  };
  const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

  const prefixRepository = new PrefixRepository(nestPrisma, contextService);
  const prefixService = new PrefixService(
    prefixRepository,
    contextService,
    { set: vi.fn(), clear: vi.fn() } as never,
    { set: vi.fn(), clear: vi.fn() } as never,
    dhcpPublisher as never,
    { listLeasesForPrefix: vi.fn().mockResolvedValue([]) } as never,
    {
      deriveAll: vi.fn(),
      deriveOne: vi.fn(),
      listReservationsForPrefix: vi.fn().mockResolvedValue([]),
    } as never,
    {
      publishPrefixDnsOverride: vi.fn().mockResolvedValue(true),
      clearPrefixDnsOverride: vi.fn().mockResolvedValue(undefined),
    } as never,
    logger as never,
  );
  const ipAddressService = new IpAddressService(
    new IpAddressRepository(nestPrisma, contextService),
    contextService,
    dhcpPublisher as never,
  );
  const ipRangeService = new IpRangeService(
    new IpRangeRepository(nestPrisma, contextService),
    contextService,
    dhcpPublisher as never,
  );
  const hostIpam = new HostPluginIpamProvisioning(
    contextService,
    prefixService,
    ipAddressService,
    ipRangeService,
    new IpamRoleRepository(nestPrisma),
    new EventLogService(new EventLogRepository(nestPrisma), logger as never, contextService),
  );

  return new backend!.BridgeRequestsService(
    new backend!.BridgeRequestRepository(prisma),
    new backend!.BridgeRequestIpamService(hostIpam),
    prisma,
  );
}

describe.skipIf(!managedPluginPresent).sequential('operator-bridge-requests approve → IPAM (integration)', () => {
  let serverUrl: string;
  let containerId: string | undefined;
  let testDbName: string;
  let testDbUrl: string;
  let prisma: DatabasePrismaClient;
  let service: BridgeRequestsServiceLike;
  let orgId: string;
  let zoneId: string;

  beforeAll(async () => {
    const provided = process.env.E2E_DATABASE_SERVER_URL ?? process.env.DATABASE_URL;
    if (provided && (await isReachable(toServerUrl(provided)))) {
      serverUrl = toServerUrl(provided);
    } else {
      ({ serverUrl, containerId } = await startDockerPostgres());
    }

    testDbName = `brokkr_obr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const admin = new pg.Client({ connectionString: serverUrl });
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE "${testDbName}"`);
    } finally {
      await admin.end();
    }
    const dbUrl = new URL(serverUrl);
    dbUrl.pathname = `/${testDbName}`;
    testDbUrl = dbUrl.toString();

    execFileSync(process.execPath, [prismaCli, 'migrate', 'deploy'], {
      cwd: databasePackageDir,
      env: { ...process.env, DATABASE_URL: testDbUrl },
      stdio: 'pipe',
    });

    await new PluginMigrator(testDbUrl).applyAll([manifestModule!.operatorBridgeRequestsManifest]);

    prisma = createPrismaClient({ connectionString: testDbUrl });
    service = buildBridgeRequestsService(prisma);

    for (const slug of ['primary', 'management'] as const) {
      await prisma.ipamPrefixVlanRole.upsert({
        where: { slug },
        create: { name: slug, slug },
        update: {},
      });
    }

    const org = await prisma.organization.create({
      data: { name: `obr-int-${randomUUID()}`, tenantType: 'SupplyCustomer' },
    });
    orgId = org.id;
    const zone = await prisma.zone.create({
      data: { name: `z-${randomUUID().slice(0, 8)}`, organizationId: orgId },
    });
    zoneId = zone.id;
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect().catch(() => undefined);

    const admin = new pg.Client({ connectionString: serverUrl });
    await admin.connect().catch(() => undefined);
    try {
      await admin.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [testDbName],
      );
      await admin.query(`DROP DATABASE IF EXISTS "${testDbName}"`);
    } finally {
      await admin.end().catch(() => undefined);
    }
    if (containerId) spawnSync('docker', ['stop', containerId]);
  }, 60_000);

  it('create → approve provisions Prefix / gateway / bridge IpAddress rows', async () => {
    const created = await service.create({
      organizationId: orgId,
      zoneId,
      bridgeType: 'managed',
      bridgeCount: 1,
      networkType: 'public',
      prefixes: [
        {
          type: 'public',
          role: 'primary',
          prefix: PRIMARY_CIDR,
          gateway: '10.99.0.1',
          bridgeOneStaticIp: '10.99.0.2',
          ipRanges: [{ start: '10.99.0.100', end: '10.99.0.200' }],
        },
        {
          type: 'private',
          role: 'management',
          prefix: MANAGEMENT_CIDR,
          gateway: '10.99.1.1',
          bridgeOneStaticIp: '10.99.1.2',
        },
      ],
    });

    expect(created.status).toBe('PENDING');
    expect(created.provisionResult).toBeNull();

    const approved = await service.approve(created.id, { approvedBy: 'int-test@example.com' });

    expect(approved.status).toBe('APPROVED');
    expect(approved.approvedBy).toBe('int-test@example.com');
    expect(approved.provisionResult?.prefixes).toHaveLength(2);

    const primary = approved.provisionResult!.prefixes.find((row) => row.role === 'primary');
    const management = approved.provisionResult!.prefixes.find((row) => row.role === 'management');
    expect(primary?.cidr).toBe(PRIMARY_CIDR);
    expect(management?.cidr).toBe(MANAGEMENT_CIDR);
    expect(primary?.gatewayIpId).toBeTruthy();
    expect(primary?.bridgeIpIds).toHaveLength(1);
    expect(primary?.ipRangeIds).toHaveLength(1);

    const prefixRows = await prisma.prefix.findMany({
      where: { zoneId, organizationId: orgId, deletedAt: null },
      select: { id: true, role: true, gatewayIpId: true },
    });
    expect(prefixRows).toHaveLength(2);
    expect(prefixRows.map((row) => row.role)).toEqual(expect.arrayContaining(['PRIMARY', 'MANAGEMENT']));
    expect(prefixRows.some((row) => row.id === primary?.prefixId && row.gatewayIpId === primary.gatewayIpId)).toBe(
      true,
    );

    const gateway = await prisma.ipAddress.findUnique({ where: { id: primary!.gatewayIpId! } });
    expect(String(gateway?.address)).toContain('10.99.0.1');

    const bridgeIp = await prisma.ipAddress.findUnique({ where: { id: primary!.bridgeIpIds[0]! } });
    expect(String(bridgeIp?.address)).toContain('10.99.0.2');

    const range = await prisma.ipRange.findUnique({ where: { id: primary!.ipRangeIds[0]! } });
    expect(range?.prefixId).toBe(primary!.prefixId);
    expect(String(range?.start)).toContain('10.99.0.100');
    expect(String(range?.end)).toContain('10.99.0.200');

    await expect(service.approve(created.id, { approvedBy: 'again@example.com' })).rejects.toThrow(
      /already approved/i,
    );
    const prefixCount = await prisma.prefix.count({
      where: { zoneId, organizationId: orgId, deletedAt: null },
    });
    expect(prefixCount).toBe(2);
  });

  it('keeps the request pending when approve hits a prefix conflict', async () => {
    const conflictCidr = '10.99.50.0/24';
    const roleId = (await prisma.ipamPrefixVlanRole.findUniqueOrThrow({ where: { slug: 'primary' } })).id;
    await prisma.$executeRaw`
      INSERT INTO "Prefix" (id, prefix, status, role, "organizationId", "zoneId", "prefixRoleId", "createdAt", "updatedAt")
      VALUES (
        ${randomUUID()}::uuid,
        ${conflictCidr}::cidr,
        'ACTIVE'::"PrefixStatus",
        'PRIMARY'::"IpamRole",
        ${orgId}::uuid,
        ${zoneId}::uuid,
        ${roleId}::uuid,
        NOW(),
        NOW()
      )
    `;

    const created = await service.create({
      organizationId: orgId,
      zoneId,
      bridgeType: 'self-hosted',
      bridgeCount: 1,
      networkType: 'private',
      prefixes: [
        {
          type: 'public',
          role: 'primary',
          prefix: conflictCidr,
          gateway: '10.99.50.1',
        },
        {
          type: 'private',
          role: 'management',
          prefix: '10.99.51.0/24',
          gateway: '10.99.51.1',
        },
        {
          type: 'private',
          role: 'primary',
          prefix: '10.99.52.0/24',
          gateway: '10.99.52.1',
        },
      ],
    });

    await expect(service.approve(created.id, { approvedBy: 'int-test@example.com' })).rejects.toBeInstanceOf(
      ConflictException,
    );

    const after = await service.getById(created.id);
    expect(after.status).toBe('PENDING');
    expect(after.provisionResult).toBeNull();
  });
});
