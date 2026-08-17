import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPrismaClient, type PrismaClient } from '../index.js';
import { PG_UNIQUE_VIOLATION, extractPgErrorCode } from './test-utils.js';

const connectionString = process.env.DATABASE_URL;

describe('DnsDomain/DnsRecord active partial unique indexes', () => {
  if (!connectionString) {
    it.todo('skipped: DATABASE_URL not set — partial-unique-index assertions require a live Postgres instance');
    return;
  }

  let prisma: PrismaClient;
  const createdOrgIds: string[] = [];

  const newOrg = async (suffix: string) => {
    const org = await prisma.organization.create({ data: { name: `dns-partial-test-${suffix}-${Date.now()}`, tenantType: 'DemandCustomer' } });
    createdOrgIds.push(org.id);
    return org;
  };

  beforeAll(() => {
    prisma = createPrismaClient({ connectionString: connectionString! });
  });

  afterAll(async () => {
    for (const orgId of createdOrgIds) {
      const zones = await prisma.zone.findMany({ where: { organizationId: orgId } });
      for (const zone of zones) {
        const domains = await prisma.dnsDomain.findMany({ where: { zoneId: zone.id } });
        for (const domain of domains) {
          await prisma.dnsRecord.deleteMany({ where: { domainId: domain.id } });
        }
        await prisma.dnsDomain.deleteMany({ where: { zoneId: zone.id } });
      }
      await prisma.zone.deleteMany({ where: { organizationId: orgId } });
      await prisma.organization.deleteMany({ where: { id: orgId } });
    }
    await prisma.$disconnect();
  });

  it('lets a new DnsDomain reuse a soft-deleted (zoneId, name)', async () => {
    const org = await newOrg('domain-reuse');
    const zone = await prisma.zone.create({ data: { name: 'zone-dns-test', organizationId: org.id } });

    const a = await prisma.dnsDomain.create({ data: { name: 'example.lan', zoneId: zone.id } });
    await prisma.dnsDomain.update({ where: { id: a.id }, data: { deletedAt: new Date() } });

    const b = await prisma.dnsDomain.create({ data: { name: 'example.lan', zoneId: zone.id } });

    expect(b.deletedAt).toBeNull();
    expect(b.id).not.toBe(a.id);
  });

  it('rejects two live DnsDomains sharing (zoneId, name)', async () => {
    const org = await newOrg('domain-collision');
    const zone = await prisma.zone.create({ data: { name: 'zone-dns-dup', organizationId: org.id } });

    await prisma.dnsDomain.create({ data: { name: 'dup.lan', zoneId: zone.id } });

    const error = await prisma.dnsDomain
      .create({ data: { name: 'dup.lan', zoneId: zone.id } })
      .then(() => null)
      .catch((e: unknown) => e);
    expect(error).not.toBeNull();
    const code = extractPgErrorCode(error);
    expect(code).toMatch(new RegExp(`^(${PG_UNIQUE_VIOLATION}|P2002)$`));
  });

  it('lets a new DnsRecord reuse a soft-deleted (domainId, name, type, value)', async () => {
    const org = await newOrg('record-reuse');
    const zone = await prisma.zone.create({ data: { name: 'zone-rec-test', organizationId: org.id } });
    const domain = await prisma.dnsDomain.create({ data: { name: 'rec.lan', zoneId: zone.id } });

    const a = await prisma.dnsRecord.create({
      data: { name: 'host-a', type: 'A', value: '10.0.0.1', domainId: domain.id },
    });
    await prisma.dnsRecord.update({ where: { id: a.id }, data: { deletedAt: new Date() } });

    const b = await prisma.dnsRecord.create({
      data: { name: 'host-a', type: 'A', value: '10.0.0.1', domainId: domain.id },
    });

    expect(b.deletedAt).toBeNull();
    expect(b.id).not.toBe(a.id);
  });

  it('rejects MANUAL+AUTO records sharing (domainId, name, type, value) since source is not in the unique key', async () => {
    const org = await newOrg('source-collision');
    const zone = await prisma.zone.create({ data: { name: 'zone-src-test', organizationId: org.id } });
    const domain = await prisma.dnsDomain.create({ data: { name: 'src.lan', zoneId: zone.id } });

    await prisma.dnsRecord.create({
      data: { name: 'host-m', type: 'A', value: '10.0.0.1', source: 'MANUAL', domainId: domain.id },
    });

    const error = await prisma.dnsRecord
      .create({ data: { name: 'host-m', type: 'A', value: '10.0.0.1', source: 'AUTO', domainId: domain.id } })
      .then(() => null)
      .catch((e: unknown) => e);

    expect(error).not.toBeNull();
  });

  it('rejects two live DnsRecords sharing (domainId, name, type, value)', async () => {
    const org = await newOrg('record-collision');
    const zone = await prisma.zone.create({ data: { name: 'zone-rec-dup', organizationId: org.id } });
    const domain = await prisma.dnsDomain.create({ data: { name: 'dup-rec.lan', zoneId: zone.id } });

    await prisma.dnsRecord.create({
      data: { name: 'host-b', type: 'A', value: '10.0.0.2', domainId: domain.id },
    });

    const error = await prisma.dnsRecord
      .create({ data: { name: 'host-b', type: 'A', value: '10.0.0.2', domainId: domain.id } })
      .then(() => null)
      .catch((e: unknown) => e);
    expect(error).not.toBeNull();
    const code = extractPgErrorCode(error);
    expect(code).toMatch(new RegExp(`^(${PG_UNIQUE_VIOLATION}|P2002)$`));
  });
});
