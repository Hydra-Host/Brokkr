import { ForbiddenException, NotFoundException } from '@nestjs/common';
import {
  ActiveRecordRegistry,
  PermissionContextRequiredError,
  TenantContextRequiredError,
  type ActiveRecordContext,
} from '@repo/active-record';
import { createPrismaClient, DeviceRole, type PrismaClient } from '@repo/database';
import { randomUUID } from 'crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InterfaceRecord } from '../../../dcim/interface/interface.record';
import { BaremetalRecord } from '../../../devices/baremetal.record';
import { ZoneRecord } from '../../../zones/zone.record';

describe('active-record tenant scoping (integration, live DB)', () => {
  let prisma: PrismaClient;
  let orgA: string;
  let orgB: string;
  let zoneA1: string;
  let zoneA2: string;
  let zoneB1: string;
  let deviceA: string;
  let ifaceA: string;
  const createdZoneIds: string[] = [];
  const createdOrgs: string[] = [];

  const ALL_PERMS = [
    'zone:read',
    'zone:update',
    'zone:delete',
    'device:read',
    'device:update',
    'device:delete',
    'dcim:read',
    'dcim:create',
    'dcim:update',
    'dcim:delete',
  ];

  let ctx: ActiveRecordContext | undefined;
  const asOrg = (organizationId: string, permissions: string[] = ALL_PERMS) => {
    ctx = { organizationId, permissions: new Set(permissions) };
  };

  async function mkDevice(supplierId: string): Promise<string> {
    const device = await prisma.device.create({
      data: {
        name: `dev-${randomUUID().slice(0, 8)}`,
        supplierId,
        role: DeviceRole.Server,
      },
    });
    await prisma.server.create({ data: { deviceId: device.id } });
    return device.id;
  }

  beforeAll(async () => {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error('DATABASE_URL is required for the tenant-scoping integration test');
    prisma = createPrismaClient({ connectionString });
    ActiveRecordRegistry.configureForTest(prisma, () => ctx);

    const a = await prisma.organization.create({
      data: { name: `it-ten-A-${randomUUID()}`, tenantType: 'SupplyCustomer' },
    });
    const b = await prisma.organization.create({
      data: { name: `it-ten-B-${randomUUID()}`, tenantType: 'SupplyCustomer' },
    });
    orgA = a.id;
    orgB = b.id;
    createdOrgs.push(orgA, orgB);

    const mkZone = (organizationId: string) =>
      prisma.zone.create({ data: { name: `z-${randomUUID().slice(0, 8)}`, organizationId } });
    zoneA1 = (await mkZone(orgA)).id;
    zoneA2 = (await mkZone(orgA)).id;
    zoneB1 = (await mkZone(orgB)).id;

    deviceA = await mkDevice(orgA);
    ifaceA = (await prisma.interface.create({ data: { name: `if-${randomUUID().slice(0, 8)}`, deviceId: deviceA } }))
      .id;
  }, 60_000);

  afterAll(async () => {
    const devs = await prisma.device.findMany({ where: { supplierId: { in: createdOrgs } }, select: { id: true } });
    const deviceIds = devs.map((d) => d.id);
    await prisma.interface.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.server.deleteMany({ where: { deviceId: { in: deviceIds } } });
    await prisma.device.deleteMany({ where: { id: { in: deviceIds } } });
    await prisma.zone.deleteMany({ where: { id: { in: [zoneA1, zoneA2, zoneB1, ...createdZoneIds] } } });
    await prisma.organization.deleteMany({ where: { id: { in: createdOrgs } } });
    ActiveRecordRegistry.configureForTest(prisma, null);
    await prisma.$disconnect();
  });

  describe('flat tenantField — ZoneRecord (organizationId)', () => {
    it('scoped reads return only the caller org’s rows', async () => {
      asOrg(orgA);
      const idsA = (await ZoneRecord.findAllActive()).map((z) => z.data.id);
      expect(idsA).toEqual(expect.arrayContaining([zoneA1, zoneA2]));
      expect(idsA).not.toContain(zoneB1);

      asOrg(orgB);
      const idsB = (await ZoneRecord.findAllActive()).map((z) => z.data.id);
      expect(idsB).toContain(zoneB1);
      expect(idsB).not.toContain(zoneA1);
    });

    it('findActiveById returns the caller’s own row, null for another org’s', async () => {
      asOrg(orgA);
      expect(await ZoneRecord.findActiveById(zoneA1)).not.toBeNull();
      expect(await ZoneRecord.findActiveById(zoneB1)).toBeNull();
    });

    it('unscoped finders deliberately cross tenants (admin/saga tier)', async () => {
      asOrg(orgA);
      const ids = (await ZoneRecord.findManyUnscoped({ where: { id: { in: [zoneA1, zoneA2, zoneB1] } } })).map(
        (z) => z.data.id,
      );
      expect(ids).toEqual(expect.arrayContaining([zoneA1, zoneA2, zoneB1]));
    });

    it('an explicit where.organizationId cannot escape the caller’s tenant (pinned to ctx)', async () => {
      asOrg(orgA);
      const ids = (await ZoneRecord.findMany({ where: { organizationId: orgB, deletedAt: null } })).map(
        (z) => z.data.id,
      );
      expect(ids).not.toContain(zoneB1);
      expect(ids).toContain(zoneA1);
    });

    it('an explicit null org (platform-row probe) is pinned to ctx, no leak', async () => {
      asOrg(orgA);
      const ids = (await ZoneRecord.findMany({ where: { organizationId: null, deletedAt: null } })).map(
        (z) => z.data.id,
      );
      expect(ids).not.toContain(zoneB1);
      expect(ids).toContain(zoneA1);
    });
  });

  describe('writes stay within the tenant (ZoneRecord)', () => {
    async function createZoneAs(organizationId: string): Promise<string> {
      asOrg(organizationId);
      const id = randomUUID();
      const rec = await ZoneRecord.build({ name: `z-w-${id.slice(0, 8)}`, id, uuidSuffix: id.slice(-5) }).save();
      createdZoneIds.push(rec.data.id);
      return rec.data.id;
    }

    it('create() auto-stamps the caller org and the row is isolated from other orgs', async () => {
      const id = await createZoneAs(orgA);
      const row = await prisma.zone.findUnique({ where: { id } });
      expect(row?.organizationId).toBe(orgA);

      asOrg(orgA);
      expect(await ZoneRecord.findActiveById(id)).not.toBeNull();
      asOrg(orgB);
      expect(await ZoneRecord.findActiveById(id)).toBeNull();
    });

    it('an owner can update its own zone; the change persists scoped to its org', async () => {
      const id = await createZoneAs(orgA);
      asOrg(orgA);
      const rec = await ZoneRecord.findActiveById(id);
      await rec!.set({ name: 'renamed-in-org-a' }).save();

      const row = await prisma.zone.findUnique({ where: { id } });
      expect(row?.name).toBe('renamed-in-org-a');
      expect(row?.organizationId).toBe(orgA);
    });

    it('an owner can delete its own zone; afterwards it is gone for that org', async () => {
      const id = await createZoneAs(orgA);
      asOrg(orgA);
      const rec = await ZoneRecord.findActiveById(id);
      await rec!.delete();
      expect(await ZoneRecord.findActiveById(id)).toBeNull();
    });
  });

  describe('no bound context — tenant strict mode (distinct from the permission gate)', () => {
    it('a scoped finder throws TenantContextRequiredError, never reads unscoped', async () => {
      ctx = undefined;
      await expect(ZoneRecord.findMany({ where: { deletedAt: null } })).rejects.toBeInstanceOf(
        TenantContextRequiredError,
      );
    });
  });

  describe('the requireAction permission gate — ZoneRecord', () => {
    it('denies a caller whose context lacks zone:read', () => {
      ctx = { organizationId: orgA, permissions: new Set() };
      expect(() => ZoneRecord.findAllActive()).toThrow(ForbiddenException);
    });

    it('fails closed with no bound context', () => {
      ctx = undefined;
      expect(() => ZoneRecord.findAllActive()).toThrow(PermissionContextRequiredError);
    });
  });

  describe('alternate flat field — BaremetalRecord (supplierId)', () => {
    it('the owning org fetches its own device; another org gets null', async () => {
      asOrg(orgA);
      expect((await BaremetalRecord.findByDeviceId(deviceA))?.data.id).toBe(deviceA);
      asOrg(orgB);
      expect(await BaremetalRecord.findByDeviceId(deviceA)).toBeNull();
    });

    it('the *OrThrow variant surfaces NotFound cross-tenant (the endpoint’s 404)', async () => {
      asOrg(orgB);
      await expect(BaremetalRecord.findByDeviceIdOrThrow(deviceA)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('denies a caller lacking device:read; fails closed with no context', async () => {
      ctx = { organizationId: orgA, permissions: new Set() };
      await expect(BaremetalRecord.findByDeviceId(deviceA)).rejects.toBeInstanceOf(ForbiddenException);
      ctx = undefined;
      await expect(BaremetalRecord.findByDeviceId(deviceA)).rejects.toBeInstanceOf(PermissionContextRequiredError);
    });

    it('soft delete: a deleted device drops from the default finder but remains under includeDeleted', async () => {
      const id = await mkDevice(orgA);
      asOrg(orgA);
      const rec = await BaremetalRecord.findByDeviceId(id);
      await rec!.delete();

      expect(await BaremetalRecord.findByDeviceId(id)).toBeNull();
      expect((await BaremetalRecord.findByDeviceId(id, { includeDeleted: true }))?.data.id).toBe(id);
    });
  });

  describe('relation-path (nested) — InterfaceRecord (device.supplierId)', () => {
    it('the owning org sees the interface on its device; another org cannot', async () => {
      asOrg(orgA, ['dcim:read']);
      expect((await InterfaceRecord.findById(ifaceA))?.data.id).toBe(ifaceA);
      asOrg(orgB, ['dcim:read']);
      expect(await InterfaceRecord.findById(ifaceA)).toBeNull();
    });

    it('the OrThrow variant surfaces NotFound cross-tenant', async () => {
      asOrg(orgB, ['dcim:read']);
      await expect(InterfaceRecord.findByIdOrThrow(ifaceA)).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
