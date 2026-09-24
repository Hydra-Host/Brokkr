import { ActiveRecordRegistry } from '@repo/active-record';
import { DeviceNetworkType, DeviceRole, DeviceStatus, ServerLifecycleStatus, TeeCapability } from '@repo/database';
import { deviceSpecColumnsFixture } from '@repo/device-domain/testing';
import { isRecord } from '@repo/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InventoryRecord } from '../inventory.record';

function prismaSqlText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(prismaSqlText).join(' ');
  if (isRecord(value) && Array.isArray(value.strings)) {
    return `${prismaSqlText(value.strings)} ${prismaSqlText(value.values)}`;
  }
  return '';
}

describe('InventoryRecord', () => {
  const mockDelegate = {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  };

  const queryRawMock = vi.fn().mockResolvedValue([]);

  const fullRow = {
    ...deviceSpecColumnsFixture,
    name: 'gpu-host-1',
    status: DeviceStatus.ACTIVE,
    role: DeviceRole.Server,
    supplierId: 'supplier-1',
    networkType: DeviceNetworkType.Public,
    zone: { name: 'us-east-1a', region: { name: 'us-east' } },
    server: {
      id: 'server-1',
      lifecycleStatus: ServerLifecycleStatus.INVENTORY,
      teeEnabled: true,
      teeCapable: TeeCapability.TRUE,
      vpcCapable: true,
      storageLayouts: {},
      hourlyPrice: '1.50',
      floorHourlyPrice: '0.75',
      isListed: true,
      isInterruptible: false,
      deployments: [],
      serversInReservationInvite: [],
    },
    supplier: { id: 'supplier-1' },
    interfaces: [],
  };

  beforeEach(() => {
    vi.resetAllMocks();
    queryRawMock.mockResolvedValue([]);
    ActiveRecordRegistry.configureForTest({ device: mockDelegate, $queryRaw: queryRawMock }, () => ({
      organizationId: 'org-1',
      permissions: new Set<string>(['inventory:read']),
    }));
  });

  afterEach(() => vi.resetAllMocks());

  describe('policy pins', () => {
    it('findById injects the role discriminator + soft-delete pins and hydrates the include', async () => {
      mockDelegate.findFirst.mockResolvedValue(fullRow);

      await InventoryRecord.findById('device-1');

      const [args] = mockDelegate.findFirst.mock.calls[0];
      expect(args.where).toMatchObject({ id: 'device-1', role: DeviceRole.Server, deletedAt: null });
      expect(args.include).toBeDefined();
      expect(args.include.server).toBeDefined();
    });

    it('findListings filters on the LIVE server.isListed (not the frozen Device column) under the pins', async () => {
      mockDelegate.findMany.mockResolvedValue([]);

      await InventoryRecord.findListings();

      const [args] = mockDelegate.findMany.mock.calls[0];
      expect(args.where).toMatchObject({
        role: DeviceRole.Server,
        deletedAt: null,
        server: expect.objectContaining({ isListed: true }),
      });
      expect(args.where.isListed).toBeUndefined();
      expect(args.where.OR).toBeUndefined();
    });

    it('findListings keeps null-supplier devices while excluding hidden suppliers', async () => {
      mockDelegate.findMany.mockResolvedValue([]);

      await InventoryRecord.findListings(undefined, undefined, ['supplier-hidden']);

      const [args] = mockDelegate.findMany.mock.calls[0];
      expect(args.where.OR).toEqual([{ supplierId: null }, { supplierId: { notIn: ['supplier-hidden'] } }]);
    });
  });

  describe('interruptible availability (deployment-centric)', () => {
    it('findListings treats free OR interruptible-occupied hosts as listable', async () => {
      mockDelegate.findMany.mockResolvedValue([]);

      await InventoryRecord.findListings();

      const [args] = mockDelegate.findMany.mock.calls[0];
      const andClauses = args.where.server.AND;
      const orClause = andClauses.find((c: { OR?: unknown }) => Array.isArray(c.OR));
      expect(orClause.OR).toEqual(
        expect.arrayContaining([
          { deployments: { none: { endDate: null } } },
          { deployments: { some: { endDate: null, isInterruptible: true } } },
        ]),
      );
    });

    it('findListableById matches a free host OR an interruptible-occupied host', async () => {
      mockDelegate.findFirst.mockResolvedValue(null);

      await InventoryRecord.findListableById('device-1');

      const [args] = mockDelegate.findFirst.mock.calls[0];
      expect(args.where.id).toBe('device-1');
      expect(args.where.OR).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            server: expect.objectContaining({
              lifecycleStatus: ServerLifecycleStatus.INVENTORY,
              deployments: { none: { endDate: null } },
            }),
          }),
          expect.objectContaining({
            server: expect.objectContaining({
              deployments: { some: { endDate: null, isInterruptible: true } },
            }),
          }),
        ]),
      );
    });

    it('getCategoryAvailability raw SQL keys interruptible on Deployment.isInterruptible + no pending claim', async () => {
      queryRawMock.mockResolvedValue([]);

      await InventoryRecord.getCategoryAvailability();

      const sqlParts = queryRawMock.mock.calls[0][0];
      const sql = Array.isArray(sqlParts) ? sqlParts.join(' ') : String(sqlParts);
      expect(sql).toContain('dep."isInterruptible" = true');
      expect(sql).toContain('"InterruptibleClaim"');
      expect(sql).toContain('dep."endDate" IS NULL');
      expect(sql).not.toContain('ContractTerm');
    });

    it('listedSupplierIds selects distinct listed supplier ids', async () => {
      queryRawMock.mockResolvedValue([{ supplierId: 'supplier-1' }]);

      await expect(InventoryRecord.listedSupplierIds()).resolves.toEqual(['supplier-1']);

      const sqlParts = queryRawMock.mock.calls[0][0];
      const sql = Array.isArray(sqlParts) ? sqlParts.join(' ') : String(sqlParts);
      expect(sql).toContain('SELECT DISTINCT');
      expect(sql).toContain('bd."supplierId"');
      expect(sql).toContain('s."isListed" = true');
    });

    it('getCategoryAvailability omits supplier exclusion when none are hidden', async () => {
      queryRawMock.mockResolvedValue([]);

      await InventoryRecord.getCategoryAvailability();

      const sqlParts = queryRawMock.mock.calls[0][0];
      const sql = Array.isArray(sqlParts) ? sqlParts.join(' ') : String(sqlParts);
      expect(sql).not.toContain('supplierId" NOT IN');
    });

    it('getCategoryAvailability and getAllCategoryPrices exclude hidden suppliers', async () => {
      queryRawMock.mockResolvedValue([]);

      await InventoryRecord.getCategoryAvailability(['supplier-hidden']);
      await InventoryRecord.getAllCategoryPrices(['supplier-hidden']);

      expect(queryRawMock).toHaveBeenCalledTimes(2);
      for (const call of queryRawMock.mock.calls) {
        const sql = prismaSqlText(call);
        expect(sql).toContain('bd."supplierId" IS NULL OR');
        expect(sql).toContain('bd."supplierId" NOT IN');
        expect(sql).toContain('supplier-hidden');
      }
    });
  });

  describe('schema completeness (guards against silent parse-strip)', () => {
    it('preserves every Device + Server column the presenter reads through the base-finder parse', async () => {
      mockDelegate.findFirst.mockResolvedValue(fullRow);

      const aggregate = await InventoryRecord.findById('device-1');

      expect(aggregate).not.toBeNull();
      expect(aggregate).toMatchObject({
        networkType: DeviceNetworkType.Public,
        zone: { name: 'us-east-1a', region: { name: 'us-east' } },
      });
      expect(aggregate?.server).toMatchObject({
        vpcCapable: true,
        teeEnabled: true,
        teeCapable: TeeCapability.TRUE,
        isListed: true,
        isInterruptible: false,
        hourlyPrice: '1.50',
        floorHourlyPrice: '0.75',
      });
    });
  });

  describe('reservation-invite availability', () => {
    it('findAvailableForInviteById does not filter isListed', async () => {
      mockDelegate.findFirst.mockResolvedValue(null);

      await InventoryRecord.findAvailableForInviteById('device-1');

      const [args] = mockDelegate.findFirst.mock.calls[0];
      expect(args.where.id).toBe('device-1');
      expect(args.where.server.lifecycleStatus).toBe(ServerLifecycleStatus.INVENTORY);
      expect(args.where.server).not.toHaveProperty('isListed');
    });
  });

  describe('attachLatestGpuBurnInRuns hydration', () => {
    it('attaches the latest completed GpuBurnIn run onto the aggregate', async () => {
      mockDelegate.findFirst.mockResolvedValue(fullRow);
      const run = { id: 'run-1', deviceId: 'device-1' };
      queryRawMock.mockResolvedValue([run]);

      const aggregate = await InventoryRecord.findById('device-1');

      expect(aggregate?.deviceTestRuns).toEqual([run]);
    });

    it('attaches an empty array when the device has no completed run', async () => {
      mockDelegate.findFirst.mockResolvedValue(fullRow);
      queryRawMock.mockResolvedValue([]);

      const aggregate = await InventoryRecord.findById('device-1');

      expect(aggregate?.deviceTestRuns).toEqual([]);
    });

    it('queries with DISTINCT ON + ORDER BY to pick the latest completed run per device', async () => {
      mockDelegate.findFirst.mockResolvedValue(fullRow);
      queryRawMock.mockResolvedValue([]);

      await InventoryRecord.findById('device-1');

      const sqlParts = queryRawMock.mock.calls[0][0] as string[];
      const sql = sqlParts.join(' ');
      expect(sql).toContain('DISTINCT ON ("deviceId")');
      expect(sql).toContain('ORDER BY "deviceId", "endTime" DESC');
      expect(sql).toContain('"DeviceTestRun"');
    });
  });
});
