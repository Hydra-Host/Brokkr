import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPrismaClient, type PrismaClient } from '../index.js';
import { PG_UNIQUE_VIOLATION, extractPgErrorCode } from './test-utils.js';

const connectionString = process.env.DATABASE_URL;

describe('Vlan active (zoneId, vid) partial unique index', () => {
  if (!connectionString) {
    it.todo('skipped: DATABASE_URL not set — partial-unique-index assertions require a live Postgres instance');
    return;
  }

  let prisma: PrismaClient;
  const createdOrgIds: string[] = [];

  const newOrg = async (suffix: string) => {
    const org = await prisma.organization.create({
      data: { name: `vlan-vid-test-${suffix}-${Date.now()}`, tenantType: 'DemandCustomer' },
    });
    createdOrgIds.push(org.id);
    return org;
  };

  beforeAll(() => {
    prisma = createPrismaClient({ connectionString: connectionString! });
  });

  afterAll(async () => {
    for (const orgId of createdOrgIds) {
      await prisma.vlan.deleteMany({ where: { organizationId: orgId } });
      await prisma.zone.deleteMany({ where: { organizationId: orgId } });
      await prisma.organization.deleteMany({ where: { id: orgId } });
    }
    await prisma.$disconnect();
  });

  it('lets the same VID exist in two different zones', async () => {
    const org = await newOrg('cross-zone');
    const zoneA = await prisma.zone.create({ data: { name: 'zone-a', organizationId: org.id } });
    const zoneB = await prisma.zone.create({ data: { name: 'zone-b', organizationId: org.id } });

    const a = await prisma.vlan.create({
      data: { name: 'vlan-a', vid: 100, organizationId: org.id, zoneId: zoneA.id },
    });
    const b = await prisma.vlan.create({
      data: { name: 'vlan-b', vid: 100, organizationId: org.id, zoneId: zoneB.id },
    });

    expect(a.vid).toBe(100);
    expect(b.vid).toBe(100);
    expect(b.id).not.toBe(a.id);
  });

  it('lets two zone-less VLANs share a VID', async () => {
    const org = await newOrg('zone-less');

    const a = await prisma.vlan.create({
      data: { name: 'vlan-a', vid: 200, organizationId: org.id },
    });
    const b = await prisma.vlan.create({
      data: { name: 'vlan-b', vid: 200, organizationId: org.id },
    });

    expect(a.zoneId).toBeNull();
    expect(b.zoneId).toBeNull();
    expect(b.id).not.toBe(a.id);
  });

  it('rejects two live VLANs sharing (zoneId, vid)', async () => {
    const org = await newOrg('collision');
    const zone = await prisma.zone.create({ data: { name: 'zone-dup', organizationId: org.id } });

    await prisma.vlan.create({
      data: { name: 'vlan-a', vid: 300, organizationId: org.id, zoneId: zone.id },
    });

    const error = await prisma.vlan
      .create({ data: { name: 'vlan-b', vid: 300, organizationId: org.id, zoneId: zone.id } })
      .then(() => null)
      .catch((e: unknown) => e);
    expect(error).not.toBeNull();
    const code = extractPgErrorCode(error);
    expect(code).toMatch(new RegExp(`^(${PG_UNIQUE_VIOLATION}|P2002)$`));
  });
});
