import { ActiveRecordRegistry } from '@repo/active-record';
import { createPrismaClientOptions } from '@repo/database';
import { randomUUID } from 'crypto';
import { DesignationOperatorPolicy } from 'src/common/authz/operator-policy';
import { ContextService } from 'src/common/context/context.service';
import { EventLogRepository } from 'src/event-log/event-log.repository';
import { EventLogService } from 'src/event-log/event-log.service';
import { PrismaClient } from 'src/prisma/prisma.client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { HostPluginIpamProvisioning } from '../host-plugin-ipam-provisioning';

const connectionString = process.env.DATABASE_URL;

describe.skipIf(!connectionString)('system event capture for plugin IPAM rollback (integration, live DB)', () => {
  let prisma: PrismaClient;
  let contextService: ContextService;
  let eventLog: EventLogService;
  let hostPlugin: HostPluginIpamProvisioning;
  let organizationId: string;
  let zoneId: string;
  let octet = 0;

  const logger = { log: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), verbose: vi.fn() };

  const rowsForOrg = () => prisma.eventLog.findMany({ where: { organizationId }, orderBy: { createdAt: 'asc' } });

  async function seedProvisionedTargets() {
    const block = octet++;
    const prefixId = randomUUID();
    await prisma.$executeRaw`
      INSERT INTO "Prefix" (id, prefix, status, "organizationId", "zoneId", "createdAt", "updatedAt")
      VALUES (${prefixId}::uuid, ${`10.97.${block}.0/24`}::cidr, 'ACTIVE', ${organizationId}, ${zoneId}::uuid, now(), now())
    `;
    const ipAddress = await prisma.ipAddress.create({
      data: { address: `10.97.${block}.10`, status: 'ACTIVE', organizationId },
    });
    const ipRange = await prisma.ipRange.create({
      data: { start: `10.97.${block}.100`, end: `10.97.${block}.200`, status: 'ACTIVE', organizationId, prefixId },
    });
    return { prefixId, ipAddressId: ipAddress.id, ipRangeId: ipRange.id };
  }

  const rollback = (targets: { prefixId: string; ipAddressId: string; ipRangeId: string }) =>
    hostPlugin.rollbackProvisioned({
      organizationId,
      prefixIds: [targets.prefixId],
      ipAddressIds: [targets.ipAddressId],
      ipRangeIds: [targets.ipRangeId],
    });

  beforeAll(async () => {
    prisma = new PrismaClient(createPrismaClientOptions({ connectionString: connectionString! }));
    contextService = new ContextService(new DesignationOperatorPolicy());
    eventLog = new EventLogService(new EventLogRepository(prisma), logger as never, contextService);
    ActiveRecordRegistry.configureForTest(prisma);

    hostPlugin = new HostPluginIpamProvisioning(
      contextService,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      eventLog,
    );

    const org = await prisma.organization.create({
      data: { name: `it-ipam-rollback-${randomUUID()}`, tenantType: 'SupplyCustomer' },
    });
    organizationId = org.id;
    zoneId = (await prisma.zone.create({ data: { name: `z-${randomUUID().slice(0, 8)}`, organizationId } })).id;
  }, 60_000);

  afterAll(async () => {
    await prisma.eventLog.deleteMany({ where: { organizationId } });
    await prisma.changelog.deleteMany({ where: { organizationId } });
    await prisma.ipRange.deleteMany({ where: { organizationId } });
    await prisma.ipAddress.deleteMany({ where: { organizationId } });
    await prisma.prefix.deleteMany({ where: { organizationId } });
    await prisma.zone.deleteMany({ where: { id: zoneId } });
    await prisma.organization.deleteMany({ where: { id: organizationId } });
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.eventLog.deleteMany({ where: { organizationId } });
  });

  it('records exactly one atomic SYSTEM row for a plugin rollback', async () => {
    const targets = await seedProvisionedTargets();

    await rollback(targets);

    const rows = await rowsForOrg();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      organizationId,
      actorType: 'SYSTEM',
      actorId: null,
      actorLabel: null,
      apiKeyId: null,
      actionKey: 'ipam.rollback',
      resource: 'ipam',
      action: 'rollback',
      outcome: 'SUCCEEDED',
      errorCode: null,
      tier: 'EVIDENCE',
      durability: 'ATOMIC',
      method: null,
      path: null,
    });
  });

  it('soft-deletes the provisioned records alongside the row it records', async () => {
    const targets = await seedProvisionedTargets();

    await rollback(targets);

    const prefix = await prisma.prefix.findUnique({ where: { id: targets.prefixId } });
    const ipAddress = await prisma.ipAddress.findUnique({ where: { id: targets.ipAddressId } });
    const ipRange = await prisma.ipRange.findUnique({ where: { id: targets.ipRangeId } });

    expect(prefix?.deletedAt).toBeInstanceOf(Date);
    expect(ipAddress?.deletedAt).toBeInstanceOf(Date);
    expect(ipRange?.deletedAt).toBeInstanceOf(Date);
    expect(await rowsForOrg()).toHaveLength(1);
  });

  it('reports the counts actually soft-deleted, not the counts requested', async () => {
    const targets = await seedProvisionedTargets();

    await hostPlugin.rollbackProvisioned({
      organizationId,
      prefixIds: [targets.prefixId, randomUUID()],
      ipAddressIds: [targets.ipAddressId],
      ipRangeIds: [targets.ipRangeId],
    });

    const rows = await rowsForOrg();
    expect(rows).toHaveLength(1);
    expect(rows[0].metadata).toEqual({ prefixes: 1, ipAddresses: 1, ipRanges: 1 });
  });

  it('records a row even when the rollback has nothing left to undo', async () => {
    await hostPlugin.rollbackProvisioned({
      organizationId,
      prefixIds: [],
      ipAddressIds: [],
      ipRangeIds: [],
    });

    const rows = await rowsForOrg();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorType: 'SYSTEM', actionKey: 'ipam.rollback', durability: 'ATOMIC' });
    expect(rows[0].metadata).toEqual({ prefixes: 0, ipAddresses: 0, ipRanges: 0 });
  });

  it('writes no row and leaves the records intact when the transaction fails', async () => {
    const targets = await seedProvisionedTargets();
    const failing = new EventLogService(new EventLogRepository(prisma), logger as never, contextService);
    vi.spyOn(failing, 'recordInTransaction').mockRejectedValue(new Error('event row rejected'));
    const plugin = new HostPluginIpamProvisioning(
      contextService,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      failing,
    );

    await expect(
      plugin.rollbackProvisioned({
        organizationId,
        prefixIds: [targets.prefixId],
        ipAddressIds: [targets.ipAddressId],
        ipRangeIds: [targets.ipRangeId],
      }),
    ).rejects.toThrow('event row rejected');

    expect(await rowsForOrg()).toHaveLength(0);
    expect((await prisma.prefix.findUnique({ where: { id: targets.prefixId } }))?.deletedAt).toBeNull();
    expect((await prisma.ipAddress.findUnique({ where: { id: targets.ipAddressId } }))?.deletedAt).toBeNull();
    expect((await prisma.ipRange.findUnique({ where: { id: targets.ipRangeId } }))?.deletedAt).toBeNull();
  });
});
