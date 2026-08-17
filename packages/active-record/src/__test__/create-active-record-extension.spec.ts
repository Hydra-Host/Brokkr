import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ActiveRecordRegistry } from '../active-record.registry';
import type { ChangeSet, LeafChange } from '../active-record.types';
import { createActiveRecord, isLeafChange } from '../create-active-record';


const ServerSchema = z.object({
  id: z.string(),
  name: z.string(),
  role: z.string(),
  organizationId: z.string(),
  server: z.object({
    ecoMode: z.boolean(),
    teeEnabled: z.boolean(),
    monitored: z.boolean(),
  }),
});

const MarketplaceServerSchema = z.object({
  id: z.string(),
  name: z.string(),
  role: z.string(),
  organizationId: z.string(),
  server: z.object({
    ecoMode: z.boolean(),
    teeEnabled: z.boolean(),
    monitored: z.boolean(),
    marketplaceServer: z.object({
      hourlyPrice: z.number(),
      isListed: z.boolean(),
    }),
  }),
});

function makeMockDelegate() {
  return {
    findUnique: vi.fn(),
    findUniqueOrThrow: vi.fn(),
    findFirst: vi.fn(),
    findFirstOrThrow: vi.fn(),
    findMany: vi.fn(),
    count: vi.fn(),
    aggregate: vi.fn(),
    groupBy: vi.fn(),
    create: vi.fn(),
    createMany: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    delete: vi.fn(),
    deleteMany: vi.fn(),
    upsert: vi.fn(),
  };
}

let device: ReturnType<typeof makeMockDelegate>;

beforeEach(() => {
  vi.clearAllMocks();
  device = makeMockDelegate();
  ActiveRecordRegistry.configureForTest({ device });
});

describe('extension policy — validation at class creation', () => {
  it('throws when the schema does not declare the extension relation key', () => {
    expect(() =>
      createActiveRecord(
        z.object({
          id: z.string(),
          name: z.string(),
        }),
        'device',
        { extension: { relationName: 'server' } },
      ),
    ).toThrow(/extension relation "server" is not declared in the schema/);
  });

  it('throws when the schema declares the extension key as a non-object type', () => {
    expect(() =>
      createActiveRecord(
        z.object({
          id: z.string(),
          server: z.string(),
        }),
        'device',
        { extension: { relationName: 'server' } },
      ),
    ).toThrow(/extension relation "server".*must be declared as a z.object/);
  });

  it('throws when a chained extension is not declared at the right nested path', () => {
    expect(() =>
      createActiveRecord(
        z.object({
          id: z.string(),
          server: z.object({
            ecoMode: z.boolean(),
          }),
        }),
        'device',
        {
          extension: {
            relationName: 'server',
            extension: { relationName: 'marketplaceServer' },
          },
        },
      ),
    ).toThrow(/extension relation "marketplaceServer" is not declared in the schema at device.server/);
  });

  it('accepts a valid single-level policy', () => {
    expect(() => createActiveRecord(ServerSchema, 'device', { extension: { relationName: 'server' } })).not.toThrow();
  });

  it('accepts a valid two-level chain', () => {
    expect(() =>
      createActiveRecord(MarketplaceServerSchema, 'device', {
        extension: {
          relationName: 'server',
          extension: { relationName: 'marketplaceServer' },
        },
      }),
    ).not.toThrow();
  });

  it('accepts nullable/optional wrappers around the nested object', () => {
    expect(() =>
      createActiveRecord(
        z.object({
          id: z.string(),
          server: z.object({ ecoMode: z.boolean() }).nullable(),
        }),
        'device',
        { extension: { relationName: 'server' } },
      ),
    ).not.toThrow();
  });
});

describe('extension policy — single-level chain (Device → Server)', () => {
  class ServerRecord extends createActiveRecord(ServerSchema, 'device', {
    tenantField: 'organizationId',
    extension: { relationName: 'server' },
  }) {}

  beforeEach(() => {
    ActiveRecordRegistry.configureForTest({ device }, () => ({
      organizationId: 'org-1',
      permissions: new Set<string>(),
    }));
  });

  describe('finders', () => {
    it('findById auto-includes the extension and preserves the nested shape', async () => {
      device.findFirst.mockResolvedValue({
        id: 'd1',
        name: 'host-1',
        role: 'Baremetal',
        organizationId: 'org-1',
        server: { ecoMode: true, teeEnabled: false, monitored: true },
      });

      const record = await ServerRecord.findById('d1');

      expect(device.findFirst).toHaveBeenCalledWith({
        where: { id: 'd1', organizationId: 'org-1' },
        include: { server: true },
      });
      expect(record.data).toEqual({
        id: 'd1',
        name: 'host-1',
        role: 'Baremetal',
        organizationId: 'org-1',
        server: { ecoMode: true, teeEnabled: false, monitored: true },
      });
    });

    it('Zod silently strips Prisma columns the schema did not declare', async () => {
      device.findFirst.mockResolvedValue({
        id: 'd1',
        name: 'host-1',
        role: 'Baremetal',
        organizationId: 'org-1',
        ipxeBuildTarget: 'unused-by-schema',
        server: {
          deviceId: 'd1',
          ecoMode: true,
          teeEnabled: false,
          monitored: true,
          undeclaredColumn: 'value-not-in-schema',
          createdAt: new Date(),
        },
      });

      const record = await ServerRecord.findById('d1');

      expect((record.data as Record<string, unknown>).ipxeBuildTarget).toBeUndefined();
      expect((record.data.server as Record<string, unknown>).deviceId).toBeUndefined();
      expect((record.data.server as Record<string, unknown>).undeclaredColumn).toBeUndefined();
      expect((record.data.server as Record<string, unknown>).createdAt).toBeUndefined();
    });

    it('findById throws when the extension relation is null but schema required it', async () => {
      device.findFirst.mockResolvedValue({
        id: 'd1',
        name: 'host-1',
        role: 'NetworkSwitch',
        organizationId: 'org-1',
        server: null,
      });

      await expect(ServerRecord.findById('d1')).rejects.toThrow();
    });

    it('findById returns null when the BASE row is missing (no parse attempted)', async () => {
      device.findFirst.mockResolvedValue(null);
      const record = await ServerRecord.findById('missing');
      expect(record).toBeNull();
    });

    it('findOne and findMany also auto-include the extension', async () => {
      device.findFirst.mockResolvedValue({
        id: 'd1',
        name: 'host-1',
        role: 'Baremetal',
        organizationId: 'org-1',
        server: { ecoMode: true, teeEnabled: false, monitored: true },
      });
      device.findMany.mockResolvedValue([]);

      await ServerRecord.findOne({ where: { name: 'host-1' } });
      await ServerRecord.findMany({ where: { role: 'Baremetal' } });

      expect(device.findFirst).toHaveBeenCalledWith({
        where: { name: 'host-1', organizationId: 'org-1' },
        include: { server: true },
      });
      expect(device.findMany).toHaveBeenCalledWith({
        where: { role: 'Baremetal', organizationId: 'org-1' },
        include: { server: true },
      });
    });

    it('preserves caller-supplied include keys alongside the extension', async () => {
      device.findFirst.mockResolvedValue({
        id: 'd1',
        name: 'host-1',
        role: 'Baremetal',
        organizationId: 'org-1',
        server: { ecoMode: true, teeEnabled: false, monitored: true },
      });

      await ServerRecord.findOne({
        where: { name: 'host-1' },
        include: { server: true, customRelation: true },
      });

      expect(device.findFirst).toHaveBeenCalledWith({
        where: { name: 'host-1', organizationId: 'org-1' },
        include: { server: true, customRelation: true },
      });
    });

    it('merges the extension into a caller include that omits the extension key', async () => {
      device.findFirst.mockResolvedValue({
        id: 'd1',
        name: 'host-1',
        role: 'Baremetal',
        organizationId: 'org-1',
        server: { ecoMode: true, teeEnabled: false, monitored: true },
      });

      await ServerRecord.findOne({
        where: { name: 'host-1' },
        include: { customRelation: true },
      });

      expect(device.findFirst).toHaveBeenCalledWith({
        where: { name: 'host-1', organizationId: 'org-1' },
        include: { server: true, customRelation: true },
      });
    });

    it('upgrades a caller `relation: true` to the framework chain when deeper levels are needed', async () => {
      class MarketplaceServerRecord extends createActiveRecord(MarketplaceServerSchema, 'device', {
        tenantField: 'organizationId',
        extension: {
          relationName: 'server',
          extension: { relationName: 'marketplaceServer' },
        },
      }) {}

      device.findFirst.mockResolvedValue({
        id: 'd1',
        name: 'host-1',
        role: 'Baremetal',
        organizationId: 'org-1',
        server: {
          ecoMode: false,
          teeEnabled: false,
          monitored: false,
          marketplaceServer: { hourlyPrice: 2.5, isListed: true },
        },
      });

      await MarketplaceServerRecord.findOne({
        where: { name: 'host-1' },
        include: { server: true, customRelation: true },
      });

      expect(device.findFirst).toHaveBeenCalledWith({
        where: { name: 'host-1', organizationId: 'org-1' },
        include: {
          server: { include: { marketplaceServer: true } },
          customRelation: true,
        },
      });
    });

    it('merges into a caller-supplied nested include without clobbering their extra relations', async () => {
      class MarketplaceServerRecord extends createActiveRecord(MarketplaceServerSchema, 'device', {
        tenantField: 'organizationId',
        extension: {
          relationName: 'server',
          extension: { relationName: 'marketplaceServer' },
        },
      }) {}

      device.findFirst.mockResolvedValue({
        id: 'd1',
        name: 'host-1',
        role: 'Baremetal',
        organizationId: 'org-1',
        server: {
          ecoMode: false,
          teeEnabled: false,
          monitored: false,
          marketplaceServer: { hourlyPrice: 2.5, isListed: true },
        },
      });

      await MarketplaceServerRecord.findOne({
        where: { name: 'host-1' },
        include: {
          server: { include: { someSiblingRelation: true } },
        },
      });

      expect(device.findFirst).toHaveBeenCalledWith({
        where: { name: 'host-1', organizationId: 'org-1' },
        include: {
          server: {
            include: {
              someSiblingRelation: true,
              marketplaceServer: true,
            },
          },
        },
      });
    });

    it('Unscoped finders also auto-include the extension', async () => {
      device.findUnique.mockResolvedValue({
        id: 'd1',
        name: 'host-1',
        role: 'Baremetal',
        organizationId: 'org-other',
        server: { ecoMode: false, teeEnabled: false, monitored: false },
      });

      const record = await ServerRecord.findByIdUnscoped('d1');

      expect(device.findUnique).toHaveBeenCalledWith({
        where: { id: 'd1' },
        include: { server: true },
      });
      expect(record.data.organizationId).toBe('org-other');
    });
  });

  describe('set() — deep merge with nested change tracking', () => {
    async function loaded(initialServer: { ecoMode: boolean; teeEnabled: boolean; monitored: boolean }) {
      device.findFirst.mockResolvedValue({
        id: 'd1',
        name: 'host-1',
        role: 'Baremetal',
        organizationId: 'org-1',
        server: initialServer,
      });
      const record = await ServerRecord.findById('d1');
      device.findFirst.mockReset();
      return record;
    }

    it('top-level set tracks a leaf change at the top level', async () => {
      const record = await loaded({ ecoMode: false, teeEnabled: false, monitored: false });
      record.set({ name: 'host-2' });

      expect(record.data.name).toBe('host-2');
      expect(record.changes).toEqual({
        name: { from: 'host-1', to: 'host-2' },
      });
    });

    it('nested set deep-merges into the extension and tracks a nested change', async () => {
      const record = await loaded({ ecoMode: false, teeEnabled: false, monitored: false });
      record.set({ server: { ecoMode: true } });

      expect(record.data.server).toEqual({
        ecoMode: true,
        teeEnabled: false,
        monitored: false,
      });
      expect(record.changes).toEqual({
        server: { ecoMode: { from: false, to: true } },
      });
    });

    it('combined top-level + nested set in one call', async () => {
      const record = await loaded({ ecoMode: false, teeEnabled: false, monitored: false });
      record.set({ name: 'host-2', server: { ecoMode: true, teeEnabled: true } });

      expect(record.data).toEqual({
        id: 'd1',
        name: 'host-2',
        role: 'Baremetal',
        organizationId: 'org-1',
        server: { ecoMode: true, teeEnabled: true, monitored: false },
      });
      expect(record.changes).toEqual({
        name: { from: 'host-1', to: 'host-2' },
        server: {
          ecoMode: { from: false, to: true },
          teeEnabled: { from: false, to: true },
        },
      });
    });

    it('repeated sets on the same nested leaf preserve the original `from`', async () => {
      const record = await loaded({ ecoMode: false, teeEnabled: false, monitored: false });
      record.set({ server: { ecoMode: true } });
      record.set({ server: { ecoMode: false } });

      expect(record.data.server.ecoMode).toBe(false);
      expect(record.changes).toEqual({
        server: { ecoMode: { from: false, to: false } },
      });
    });

    it('isDirty returns true only when an actual leaf change exists', async () => {
      const record = await loaded({ ecoMode: false, teeEnabled: false, monitored: false });
      expect(record.isDirty).toBe(false);

      record.set({ server: { ecoMode: true } });
      expect(record.isDirty).toBe(true);
    });
  });

  describe('save — new record (create)', () => {
    it('walks the nested _data and emits a nested create per extension level', async () => {
      device.create.mockResolvedValue({
        id: 'd1',
        name: 'host-1',
        role: 'Baremetal',
        organizationId: 'org-1',
        server: { ecoMode: false, teeEnabled: false, monitored: false },
      });

      const record = ServerRecord.build({
        id: 'd1',
        name: 'host-1',
        role: 'Baremetal',
        server: { ecoMode: false, teeEnabled: false, monitored: false },
      });
      await record.save();

      expect(device.create).toHaveBeenCalledWith({
        data: {
          id: 'd1',
          name: 'host-1',
          role: 'Baremetal',
          organizationId: 'org-1',
          server: { create: { ecoMode: false, teeEnabled: false, monitored: false } },
        },
        include: { server: true },
      });
      expect(record.state).toBe('persisted');
      expect(record.data.server.ecoMode).toBe(false);
    });
  });

  describe('save — persisted record (update)', () => {
    async function loaded(initialServer: { ecoMode: boolean; teeEnabled: boolean; monitored: boolean }) {
      const row = {
        id: 'd1',
        name: 'host-1',
        role: 'Baremetal',
        organizationId: 'org-1',
        server: initialServer,
      };
      device.findFirst.mockResolvedValue(row);
      device.update.mockResolvedValue(row);
      const record = await ServerRecord.findById('d1');
      device.findFirst.mockReset();
      return record;
    }

    it('emits a nested update when only an extension field changed', async () => {
      const record = await loaded({ ecoMode: false, teeEnabled: false, monitored: false });
      record.set({ server: { ecoMode: true } });
      await record.save();

      expect(device.update).toHaveBeenCalledWith({
        where: { id: 'd1', organizationId: 'org-1' },
        data: {
          server: { update: { ecoMode: true } },
        },
        include: { server: true },
      });
    });

    it('emits ONLY base changes (no nested update block) when no extension field changed', async () => {
      const record = await loaded({ ecoMode: false, teeEnabled: false, monitored: false });
      record.set({ name: 'host-2' });
      await record.save();

      expect(device.update).toHaveBeenCalledWith({
        where: { id: 'd1', organizationId: 'org-1' },
        data: { name: 'host-2' },
        include: { server: true },
      });
    });

    it('emits both base and extension changes in one nested update', async () => {
      const record = await loaded({ ecoMode: false, teeEnabled: false, monitored: false });
      record.set({ name: 'host-2', server: { ecoMode: true, teeEnabled: true } });
      await record.save();

      expect(device.update).toHaveBeenCalledWith({
        where: { id: 'd1', organizationId: 'org-1' },
        data: {
          name: 'host-2',
          server: { update: { ecoMode: true, teeEnabled: true } },
        },
        include: { server: true },
      });
    });

    it('clears _changes after a successful save', async () => {
      const record = await loaded({ ecoMode: false, teeEnabled: false, monitored: false });
      record.set({ server: { ecoMode: true } });
      expect(record.isDirty).toBe(true);
      await record.save();
      expect(record.isDirty).toBe(false);
    });

    it('skips save entirely when no field is dirty', async () => {
      const record = await loaded({ ecoMode: false, teeEnabled: false, monitored: false });
      await record.save();
      expect(device.update).not.toHaveBeenCalled();
    });
  });

  describe('delete', () => {
    it('deletes only the base row and relies on FK cascade for the extension', async () => {
      device.findFirst.mockResolvedValue({
        id: 'd1',
        name: 'host-1',
        role: 'Baremetal',
        organizationId: 'org-1',
        server: { ecoMode: false, teeEnabled: false, monitored: false },
      });
      device.delete.mockResolvedValue({});

      const record = await ServerRecord.findById('d1');
      await record.delete();

      expect(device.delete).toHaveBeenCalledWith({ where: { id: 'd1', organizationId: 'org-1' } });
      expect(record.isDeleted).toBe(true);
    });
  });
});

describe('extension policy — two-level chain (Device → Server → MarketplaceServer)', () => {
  class MarketplaceServerRecord extends createActiveRecord(MarketplaceServerSchema, 'device', {
    tenantField: 'organizationId',
    extension: {
      relationName: 'server',
      extension: { relationName: 'marketplaceServer' },
    },
  }) {}

  beforeEach(() => {
    ActiveRecordRegistry.configureForTest({ device }, () => ({
      organizationId: 'org-1',
      permissions: new Set<string>(),
    }));
  });

  it('findById builds a recursive include and preserves the deeply nested shape', async () => {
    device.findFirst.mockResolvedValue({
      id: 'd1',
      name: 'host-1',
      role: 'Baremetal',
      organizationId: 'org-1',
      server: {
        ecoMode: false,
        teeEnabled: false,
        monitored: false,
        marketplaceServer: { hourlyPrice: 2.5, isListed: true },
      },
    });

    const record = await MarketplaceServerRecord.findById('d1');

    expect(device.findFirst).toHaveBeenCalledWith({
      where: { id: 'd1', organizationId: 'org-1' },
      include: { server: { include: { marketplaceServer: true } } },
    });
    expect(record.data.server.marketplaceServer).toEqual({ hourlyPrice: 2.5, isListed: true });
  });

  it('create emits a doubly-nested create payload', async () => {
    device.create.mockResolvedValue({
      id: 'd1',
      name: 'host-1',
      role: 'Baremetal',
      organizationId: 'org-1',
      server: {
        ecoMode: false,
        teeEnabled: false,
        monitored: false,
        marketplaceServer: { hourlyPrice: 2.5, isListed: true },
      },
    });

    const record = MarketplaceServerRecord.build({
      id: 'd1',
      name: 'host-1',
      role: 'Baremetal',
      server: {
        ecoMode: false,
        teeEnabled: false,
        monitored: false,
        marketplaceServer: { hourlyPrice: 2.5, isListed: true },
      },
    });
    await record.save();

    expect(device.create).toHaveBeenCalledWith({
      data: {
        id: 'd1',
        name: 'host-1',
        role: 'Baremetal',
        organizationId: 'org-1',
        server: {
          create: {
            ecoMode: false,
            teeEnabled: false,
            monitored: false,
            marketplaceServer: { create: { hourlyPrice: 2.5, isListed: true } },
          },
        },
      },
      include: { server: { include: { marketplaceServer: true } } },
    });
  });

  describe('save — persisted record (update)', () => {
    async function loaded() {
      const row = {
        id: 'd1',
        name: 'host-1',
        role: 'Baremetal',
        organizationId: 'org-1',
        server: {
          ecoMode: false,
          teeEnabled: false,
          monitored: false,
          marketplaceServer: { hourlyPrice: 2.5, isListed: true },
        },
      };
      device.findFirst.mockResolvedValue(row);
      device.update.mockResolvedValue(row);
      const record = await MarketplaceServerRecord.findById('d1');
      device.findFirst.mockReset();
      return record;
    }

    it('set on the deepest level produces a nested change branch', async () => {
      const record = await loaded();
      record.set({ server: { marketplaceServer: { hourlyPrice: 5.0 } } });

      expect(record.data.server.marketplaceServer).toEqual({ hourlyPrice: 5.0, isListed: true });
      expect(record.changes).toEqual({
        server: {
          marketplaceServer: {
            hourlyPrice: { from: 2.5, to: 5.0 },
          },
        },
      });
    });

    it('update traverses through mid-level when only the deepest level changed', async () => {
      const record = await loaded();
      record.set({ server: { marketplaceServer: { hourlyPrice: 5.0 } } });
      await record.save();

      expect(device.update).toHaveBeenCalledWith({
        where: { id: 'd1', organizationId: 'org-1' },
        data: {
          server: { update: { marketplaceServer: { update: { hourlyPrice: 5.0 } } } },
        },
        include: { server: { include: { marketplaceServer: true } } },
      });
    });

    it('emits a single update covering all three levels when each had a change', async () => {
      const record = await loaded();
      record.set({
        name: 'host-2',
        server: {
          ecoMode: true,
          marketplaceServer: { hourlyPrice: 5.0 },
        },
      });
      await record.save();

      expect(device.update).toHaveBeenCalledWith({
        where: { id: 'd1', organizationId: 'org-1' },
        data: {
          name: 'host-2',
          server: {
            update: {
              ecoMode: true,
              marketplaceServer: { update: { hourlyPrice: 5.0 } },
            },
          },
        },
        include: { server: { include: { marketplaceServer: true } } },
      });
    });

    it('omits the entire extension chain when only base changed', async () => {
      const record = await loaded();
      record.set({ name: 'host-2' });
      await record.save();

      expect(device.update).toHaveBeenCalledWith({
        where: { id: 'd1', organizationId: 'org-1' },
        data: { name: 'host-2' },
        include: { server: { include: { marketplaceServer: true } } },
      });
    });
  });
});

describe('extension policy — four-layer chain (proves arbitrary depth)', () => {
  const FourLayerSchema = z.object({
    id: z.string(),
    name: z.string(),
    role: z.string(),
    organizationId: z.string(),
    server: z.object({
      ecoMode: z.boolean(),
      marketplaceServer: z.object({
        hourlyPrice: z.number(),
        auctionListing: z.object({
          minBid: z.number(),
        }),
      }),
    }),
  });

  class AuctionListingRecord extends createActiveRecord(FourLayerSchema, 'device', {
    tenantField: 'organizationId',
    extension: {
      relationName: 'server',
      extension: {
        relationName: 'marketplaceServer',
        extension: { relationName: 'auctionListing' },
      },
    },
  }) {}

  beforeEach(() => {
    ActiveRecordRegistry.configureForTest({ device }, () => ({
      organizationId: 'org-1',
      permissions: new Set<string>(),
    }));
  });

  it('finder builds a 3-deep nested include shape', async () => {
    device.findFirst.mockResolvedValue({
      id: 'd1',
      name: 'host-1',
      role: 'Baremetal',
      organizationId: 'org-1',
      server: {
        ecoMode: false,
        marketplaceServer: {
          hourlyPrice: 2.5,
          auctionListing: { minBid: 1.0 },
        },
      },
    });

    const record = await AuctionListingRecord.findById('d1');

    expect(device.findFirst).toHaveBeenCalledWith({
      where: { id: 'd1', organizationId: 'org-1' },
      include: {
        server: { include: { marketplaceServer: { include: { auctionListing: true } } } },
      },
    });
    expect(record.data.server.marketplaceServer.auctionListing.minBid).toBe(1.0);
  });

  it('create emits a 3-deep nested create', async () => {
    device.create.mockResolvedValue({
      id: 'd1',
      name: 'host-1',
      role: 'Baremetal',
      organizationId: 'org-1',
      server: {
        ecoMode: false,
        marketplaceServer: { hourlyPrice: 2.5, auctionListing: { minBid: 1.0 } },
      },
    });

    const record = AuctionListingRecord.build({
      id: 'd1',
      name: 'host-1',
      role: 'Baremetal',
      server: {
        ecoMode: false,
        marketplaceServer: {
          hourlyPrice: 2.5,
          auctionListing: { minBid: 1.0 },
        },
      },
    });
    await record.save();

    expect(device.create).toHaveBeenCalledWith({
      data: {
        id: 'd1',
        name: 'host-1',
        role: 'Baremetal',
        organizationId: 'org-1',
        server: {
          create: {
            ecoMode: false,
            marketplaceServer: {
              create: {
                hourlyPrice: 2.5,
                auctionListing: { create: { minBid: 1.0 } },
              },
            },
          },
        },
      },
      include: {
        server: { include: { marketplaceServer: { include: { auctionListing: true } } } },
      },
    });
  });

  it('update traverses three intermediate levels when only the deepest level changed', async () => {
    const row = {
      id: 'd1',
      name: 'host-1',
      role: 'Baremetal',
      organizationId: 'org-1',
      server: {
        ecoMode: false,
        marketplaceServer: { hourlyPrice: 2.5, auctionListing: { minBid: 1.0 } },
      },
    };
    device.findFirst.mockResolvedValue(row);
    device.update.mockResolvedValue(row);
    const record = await AuctionListingRecord.findById('d1');
    device.findFirst.mockReset();

    record.set({ server: { marketplaceServer: { auctionListing: { minBid: 2.0 } } } });
    await record.save();

    expect(device.update).toHaveBeenCalledWith({
      where: { id: 'd1', organizationId: 'org-1' },
      data: {
        server: {
          update: {
            marketplaceServer: {
              update: {
                auctionListing: { update: { minBid: 2.0 } },
              },
            },
          },
        },
      },
      include: {
        server: { include: { marketplaceServer: { include: { auctionListing: true } } } },
      },
    });
  });

  it('update at all four levels emits one nested write covering every level', async () => {
    const row = {
      id: 'd1',
      name: 'host-1',
      role: 'Baremetal',
      organizationId: 'org-1',
      server: {
        ecoMode: false,
        marketplaceServer: { hourlyPrice: 2.5, auctionListing: { minBid: 1.0 } },
      },
    };
    device.findFirst.mockResolvedValue(row);
    device.update.mockResolvedValue(row);
    const record = await AuctionListingRecord.findById('d1');
    device.findFirst.mockReset();

    record.set({
      name: 'host-2',
      server: {
        ecoMode: true,
        marketplaceServer: {
          hourlyPrice: 5.0,
          auctionListing: { minBid: 3.0 },
        },
      },
    });
    await record.save();

    expect(device.update).toHaveBeenCalledWith({
      where: { id: 'd1', organizationId: 'org-1' },
      data: {
        name: 'host-2',
        server: {
          update: {
            ecoMode: true,
            marketplaceServer: {
              update: {
                hourlyPrice: 5.0,
                auctionListing: { update: { minBid: 3.0 } },
              },
            },
          },
        },
      },
      include: {
        server: { include: { marketplaceServer: { include: { auctionListing: true } } } },
      },
    });
  });
});


describe('extension policy — collisions with user fields named `from` / `to`', () => {
  const DateRangeSchema = z.object({
    id: z.string(),
    name: z.string(),
    organizationId: z.string(),
    dateRange: z.object({
      from: z.date(),
      to: z.date(),
      label: z.string(),
    }),
  });

  class DateRangeRecord extends createActiveRecord(DateRangeSchema, 'device', {
    tenantField: 'organizationId',
    extension: { relationName: 'dateRange' },
  }) {}

  beforeEach(() => {
    ActiveRecordRegistry.configureForTest({ device }, () => ({
      organizationId: 'org-1',
      permissions: new Set<string>(),
    }));
  });

  async function loaded() {
    const row = {
      id: 'd1',
      name: 'host-1',
      organizationId: 'org-1',
      dateRange: {
        from: new Date('2020-01-01T00:00:00Z'),
        to: new Date('2021-01-01T00:00:00Z'),
        label: 'old',
      },
    };
    device.findFirst.mockResolvedValue(row);
    device.update.mockResolvedValue(row);
    const record = await DateRangeRecord.findById('d1');
    device.findFirst.mockReset();
    return record;
  }

  it('tracks nested `from` / `to` field changes as a branch, not a leaf', async () => {
    const record = await loaded();
    const newFrom = new Date('2022-01-01T00:00:00Z');
    const newTo = new Date('2023-01-01T00:00:00Z');

    record.set({ dateRange: { from: newFrom, to: newTo } });

    expect(record.changes).toEqual({
      dateRange: {
        from: { from: new Date('2020-01-01T00:00:00Z'), to: newFrom },
        to: { from: new Date('2021-01-01T00:00:00Z'), to: newTo },
      },
    });
  });

  it('preserves the original `from`-value of every leaf across follow-up set() calls', async () => {
    const record = await loaded();
    record.set({
      dateRange: {
        from: new Date('2022-01-01T00:00:00Z'),
        to: new Date('2023-01-01T00:00:00Z'),
      },
    });
    record.set({ dateRange: { from: new Date('2024-01-01T00:00:00Z') } });

    expect(record.changes).toEqual({
      dateRange: {
        from: {
          from: new Date('2020-01-01T00:00:00Z'),
          to: new Date('2024-01-01T00:00:00Z'),
        },
        to: {
          from: new Date('2021-01-01T00:00:00Z'),
          to: new Date('2023-01-01T00:00:00Z'),
        },
      },
    });
  });

  it('emits a Prisma-valid nested update payload (no `value.to` mis-emission)', async () => {
    const record = await loaded();
    const newFrom = new Date('2022-01-01T00:00:00Z');
    const newTo = new Date('2023-01-01T00:00:00Z');

    record.set({ dateRange: { from: newFrom, to: newTo } });
    await record.save();

    expect(device.update).toHaveBeenCalledWith({
      where: { id: 'd1', organizationId: 'org-1' },
      data: {
        dateRange: { update: { from: newFrom, to: newTo } },
      },
      include: { dateRange: true },
    });
  });

  it('still emits a leaf change shape for a top-level `from`/`to` JSON column', async () => {
    const JsonRangeSchema = z.object({
      id: z.string(),
      organizationId: z.string(),
      range: z.object({ from: z.string(), to: z.string() }),
      dateRange: z.object({ label: z.string() }),
    });

    class JsonRangeRecord extends createActiveRecord(JsonRangeSchema, 'device', {
      tenantField: 'organizationId',
      extension: { relationName: 'dateRange' },
    }) {}

    device.findFirst.mockResolvedValue({
      id: 'd1',
      organizationId: 'org-1',
      range: { from: '2020', to: '2021' },
      dateRange: { label: 'x' },
    });
    const record = await JsonRangeRecord.findById('d1');
    device.findFirst.mockReset();

    record.set({ range: { from: '2022', to: '2023' } });

    expect(record.changes).toEqual({
      range: {
        from: { from: '2020', to: '2021' },
        to: { from: '2022', to: '2023' },
      },
    });
  });

  it('the Symbol brand does not leak via JSON.stringify or property enumeration', async () => {
    const record = await loaded();
    record.set({ dateRange: { from: new Date('2022-01-01T00:00:00Z') } });

    const leaf = (record.changes as { dateRange: { from: unknown } }).dateRange.from as Record<string, unknown>;
    expect(Object.keys(leaf).sort()).toEqual(['from', 'to']);

    const round = JSON.parse(JSON.stringify(record.changes));
    expect(round).toEqual({
      dateRange: {
        from: {
          from: '2020-01-01T00:00:00.000Z',
          to: '2022-01-01T00:00:00.000Z',
        },
      },
    });
  });
});


describe('ChangeSet type honesty + isLeafChange narrow', () => {
  class ServerRecord extends createActiveRecord(ServerSchema, 'device', {
    tenantField: 'organizationId',
    extension: { relationName: 'server' },
  }) {}

  beforeEach(() => {
    ActiveRecordRegistry.configureForTest({ device }, () => ({
      organizationId: 'org-1',
      permissions: new Set<string>(),
    }));
  });

  async function loaded() {
    device.findFirst.mockResolvedValue({
      id: 'd1',
      name: 'host-1',
      role: 'Baremetal',
      organizationId: 'org-1',
      server: { ecoMode: false, teeEnabled: false, monitored: true },
    });
    const record = await ServerRecord.findById('d1');
    device.findFirst.mockReset();
    return record;
  }

  it('extension-key entries are nested branches at runtime, not leaves', async () => {
    const record = await loaded();
    record.set({ server: { ecoMode: true } });

    const entry = record.changes.server;
    expect(entry).toBeDefined();
    expect(entry).not.toHaveProperty('from');
    expect(entry).not.toHaveProperty('to');
    expect(entry).toEqual({ ecoMode: { from: false, to: true } });
  });

  it('primitive-key entries are leaf changes at runtime', async () => {
    const record = await loaded();
    record.set({ name: 'host-2' });

    const nameEntry = record.changes.name;
    expect(nameEntry).toEqual({ from: 'host-1', to: 'host-2' });
  });

  it('type-level: ChangeSet of an extension shape forces narrowing on object-valued keys', () => {
    type ServerData = {
      id: string;
      name: string;
      server: { ecoMode: boolean; teeEnabled: boolean };
    };
    const changes: ChangeSet<ServerData> = {
      name: { from: 'host-1', to: 'host-2' },
      server: { ecoMode: { from: false, to: true } },
    };
    const serverEntry = changes.server;
    expect(serverEntry).toBeDefined();

    // @ts-expect-error — `serverEntry` widens to
    void serverEntry?.from;

    const nameEntry = changes.name;
    expect(nameEntry?.from).toBe('host-1');
    expect(nameEntry?.to).toBe('host-2');
  });

  it('isLeafChange narrows the typed union to LeafChange<V> in the true branch', async () => {
    const record = await loaded();
    record.set({ name: 'host-2', server: { ecoMode: true } });

    type ServerData = {
      id: string;
      name: string;
      role: string;
      organizationId: string;
      server: { ecoMode: boolean; teeEnabled: boolean; monitored: boolean };
    };
    const changes = record.changes as ChangeSet<ServerData>;

    const nameEntry = changes.name;
    if (nameEntry && isLeafChange(nameEntry)) {
      expect(nameEntry.from).toBe('host-1');
      expect(nameEntry.to).toBe('host-2');
    } else {
      throw new Error('expected name to be a leaf change');
    }

    const serverEntry = changes.server;
    if (!serverEntry) throw new Error('expected server entry');
    if (isLeafChange(serverEntry)) {
      throw new Error('extension entry should NOT be a leaf change at runtime');
    }
    const ecoModeLeaf = serverEntry.ecoMode;
    if (!ecoModeLeaf) throw new Error('expected ecoMode entry');
    if (!isLeafChange(ecoModeLeaf)) {
      throw new Error('expected ecoMode to be a leaf change');
    }
    expect(ecoModeLeaf.from).toBe(false);
    expect(ecoModeLeaf.to).toBe(true);
  });

  it('isLeafChange returns false for plain-object branches (no brand) and true for branded leaves', () => {
    const plainBranch = { ecoMode: { from: false, to: true } };
    const plainBranchLeaf = plainBranch.ecoMode;

    expect(isLeafChange(plainBranch)).toBe(false);
    expect(isLeafChange(plainBranchLeaf)).toBe(false);
    expect(isLeafChange(null)).toBe(false);
    expect(isLeafChange(undefined)).toBe(false);
    expect(isLeafChange('not an object')).toBe(false);
    expect(isLeafChange({})).toBe(false);
  });

  it('type-level: Date-valued fields stay pure LeafChange — no spurious narrowing required', () => {
    type DateData = { id: string; lastSeen: Date };
    const changes: ChangeSet<DateData> = {
      lastSeen: { from: new Date('2020-01-01'), to: new Date('2021-01-01') },
    };
    const probe: LeafChange<Date> | undefined = changes.lastSeen;
    expect(probe?.from).toEqual(new Date('2020-01-01'));
  });

  it('type-level: a non-extension flat shape collapses to pure LeafChange entries', () => {
    type FlatData = { id: string; name: string; count: number };
    const changes: ChangeSet<FlatData> = {
      name: { from: 'a', to: 'b' },
      count: { from: 0, to: 1 },
    };
    const probe: {
      [K in keyof FlatData]?: LeafChange<FlatData[K]>;
    } = changes;
    expect(probe.name?.from).toBe('a');
    expect(probe.count?.to).toBe(1);
  });
});
