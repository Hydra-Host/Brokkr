import { ActiveRecordRegistry, createActiveRecord } from '@repo/active-record';
import { type DeviceCategory } from '@repo/api-client';
import {
  DeviceRole,
  DeviceStatus,
  DeviceTestRun,
  InterruptibleClaimStatus,
  Prisma,
  ServerLifecycleStatus,
  TeeCapability,
} from '@repo/database';
import { attachLatestGpuBurnInRuns, DeviceSpecColumnsSchema, hardwareSummaryInclude } from '@repo/device-domain';
import { z } from 'zod';

export const inventoryAggregateInclude = {
  supplier: true,
  server: {
    include: {
      deployments: {
        where: { endDate: null },
        include: {
          deployer: true,
          customer: true,
        },
      },
      serversInReservationInvite: {
        where: {
          reservationInvite: {
            dateExpires: { gt: new Date() },
            dateAccepted: null,
            dateDeleted: null,
          },
        },
        include: {
          reservationInvite: {
            include: { inviteeOrganization: true },
          },
        },
      },
    },
  },
  interfaces: {
    where: { deletedAt: null },
    include: {
      ipAddresses: {
        where: { deletedAt: null },
        include: { natOutside: { where: { deletedAt: null }, select: { address: true } } },
      },
    },
  },
  zone: { select: { name: true, region: { select: { name: true } } } },
  ...hardwareSummaryInclude,
} satisfies Prisma.DeviceInclude;

type ServerInclude = NonNullable<typeof inventoryAggregateInclude.server.include>;
type DeploymentWithRelations = Prisma.DeploymentGetPayload<{
  include: NonNullable<ServerInclude['deployments']>['include'];
}>;
type ServersInReservationInviteWithRelations = Prisma.ServersInReservationInviteGetPayload<{
  include: NonNullable<ServerInclude['serversInReservationInvite']>['include'];
}>;
type SupplierPayload = Prisma.OrganizationGetPayload<Record<string, never>>;
type InterfaceWithRelations = Prisma.InterfaceGetPayload<{
  include: { ipAddresses: true };
}>;

export const InventoryPersistenceSchema = DeviceSpecColumnsSchema.extend({
  server: z.object({
    id: z.string(),
    lifecycleStatus: z.nativeEnum(ServerLifecycleStatus),
    teeEnabled: z.boolean(),
    teeCapable: z.nativeEnum(TeeCapability),
    vpcCapable: z.boolean().nullable(),
    storageLayouts: z.unknown(),
    hourlyPrice: z.unknown().nullable(),
    floorHourlyPrice: z.unknown().nullable(),
    isListed: z.boolean(),
    isInterruptible: z.boolean(),
    deployments: z.array(z.custom<DeploymentWithRelations>()),
    serversInReservationInvite: z.array(z.custom<ServersInReservationInviteWithRelations>()),
  }),

  supplier: z.custom<SupplierPayload>().nullable(),
  interfaces: z.array(z.custom<InterfaceWithRelations>()),
  deviceTestRuns: z.array(z.custom<DeviceTestRun>()).optional(),
});

type _RawInventoryAggregate = Prisma.DeviceGetPayload<{ include: typeof inventoryAggregateInclude }>;
export type InventoryAggregate = Omit<_RawInventoryAggregate, 'server'> & {
  server: NonNullable<_RawInventoryAggregate['server']>;
  deviceTestRuns: DeviceTestRun[];
};

export type CategoryPrice = { category: string; startPrice: number };

export type CategoryAvailability = {
  category: string;
  hasOnDemand: boolean;
  onDemandCount: number;
  hasReserve: boolean;
  reserveCount: number;
  hasPreorder: boolean;
  preorderCount: number;
};

// PUBLIC marketplace view — deliberately NOT tenant-scoped (per-org authz happens in the service); raw-SQL analytics bypass the framework and must pin `role = Server` + `deletedAt IS NULL` inline; mutations go through `BaremetalRecord`.
export class InventoryRecord extends createActiveRecord(InventoryPersistenceSchema, 'device', {
  actions: { read: 'inventory:read' },
  extension: { relationName: 'server' },
  discriminator: { role: DeviceRole.Server },
  softDeleteField: 'deletedAt',
  include: inventoryAggregateInclude,
}) {
  get data(): Readonly<InventoryAggregate> {
    return super.data as unknown as Readonly<InventoryAggregate>;
  }

  private static async findAggregates(args: { where?: Prisma.DeviceWhereInput } = {}): Promise<InventoryAggregate[]> {
    const records: InventoryRecord[] = await this.findMany(args.where ? { where: args.where } : {});
    const aggregates = records.map((record) => record.data);
    await attachLatestGpuBurnInRuns(aggregates);
    return aggregates;
  }

  private static async findAggregateFirst(args: {
    where: Prisma.DeviceWhereInput;
  }): Promise<InventoryAggregate | null> {
    const record: InventoryRecord | null = await this.findOne({ where: args.where });
    if (!record) return null;
    await attachLatestGpuBurnInRuns([record.data]);
    return record.data;
  }

  static findListings(category?: DeviceCategory, interruptibleReady?: boolean): Promise<InventoryAggregate[]> {
    // Read live `server.*` values (Device-side copies are a stale backfill); one `server: {}` group so Prisma emits a single Device->Server join.
    return InventoryRecord.findAggregates({
      where: {
        ...InventoryRecord.deviceFilter(category),
        server: {
          isListed: true,
          ...(interruptibleReady && { floorHourlyPrice: { not: null } }),
          AND: [
            {
              OR: [
                { deployments: { none: { endDate: null } } },
                { deployments: { some: { endDate: null, isInterruptible: true } } },
              ],
            },
            {
              serversInReservationInvite: {
                none: {
                  reservationInvite: {
                    dateExpires: { gt: new Date() },
                    dateAccepted: null,
                    dateDeleted: null,
                  },
                },
              },
            },
          ],
        },
      },
    });
  }

  static findListableById(deviceId: string): Promise<InventoryAggregate | null> {
    this.requireAction('read');
    return InventoryRecord.findAggregateFirst({
      where: {
        id: deviceId,
        OR: [
          {
            server: {
              lifecycleStatus: ServerLifecycleStatus.INVENTORY,
              deployments: { none: { endDate: null } },
            },
          },
          {
            server: {
              lifecycleStatus: {
                notIn: [ServerLifecycleStatus.INVENTORY, ServerLifecycleStatus.PROVISIONING],
              },
              deployments: { some: { endDate: null, isInterruptible: true } },
            },
          },
        ],
      },
    });
  }

  static findById(deviceId: string): Promise<InventoryAggregate | null> {
    this.requireAction('read');
    return InventoryRecord.findAggregateFirst({ where: { id: deviceId } });
  }

  static findAvailableForInviteById(deviceId: string): Promise<InventoryAggregate | null> {
    this.requireAction('read');
    return InventoryRecord.findAggregateFirst({
      where: {
        id: deviceId,
        ...InventoryRecord.availableForInviteWhere(),
      },
    });
  }

  static async getAllCategoryPrices(): Promise<CategoryPrice[]> {
    const client = ActiveRecordRegistry.client;
    // Pricing/listing columns come from the live `Server` row via the INNER JOIN (Device-side copies are a stale backfill).
    const results = await client.$queryRaw<Array<{ category: string; start_price: string }>>`
      WITH listed AS (
        SELECT
          LOWER(COALESCE(
            (SELECT g."model" FROM "Gpu" g WHERE g."deviceId" = bd."id" ORDER BY g."index" ASC LIMIT 1),
            'cpu'
          )) AS category,
          CAST(COALESCE(s."floorHourlyPrice", s."hourlyPrice") AS DECIMAL) AS price,
          (SELECT count(*)::int FROM "Gpu" g WHERE g."deviceId" = bd."id") AS gpu_count
        FROM "Device" bd
        INNER JOIN "Server" s ON s."deviceId" = bd."id"
        WHERE
          (s."floorHourlyPrice" IS NOT NULL OR s."hourlyPrice" IS NOT NULL)
          AND s."isListed" = true
          AND bd."role" = ${DeviceRole.Server}::"DeviceRole"
          AND bd."deletedAt" IS NULL
      )
      SELECT category, MIN(price / gpu_count) AS start_price
      FROM listed
      WHERE gpu_count > 0
      GROUP BY category
      ORDER BY start_price ASC
    `;

    return results.map((row) => ({
      category: row.category,
      startPrice: Number(row.start_price) / 100,
    }));
  }

  static async getCategoryAvailability(): Promise<CategoryAvailability[]> {
    const client = ActiveRecordRegistry.client;
    const results = await client.$queryRaw<Array<{ category: string; stock_status: string; device_count: bigint }>>`
      SELECT
        category,
        stock_status,
        COUNT(*) as device_count
      FROM (
        SELECT
          bd."id",
          LOWER(COALESCE(
            (SELECT g."model" FROM "Gpu" g WHERE g."deviceId" = bd."id" ORDER BY g."index" ASC LIMIT 1),
            'cpu'
          )) as category,
          CASE
            WHEN LOWER(srv."lifecycleStatus"::text) = 'inventory'
              AND NOT EXISTS (
                SELECT 1 FROM "Deployment" dep
                INNER JOIN "Server" s ON s."id" = dep."serverId"
                WHERE s."deviceId" = bd."id" AND dep."endDate" IS NULL
              )
            THEN 'on demand'
            WHEN EXISTS (
                SELECT 1 FROM "Deployment" dep
                INNER JOIN "Server" s ON s."id" = dep."serverId"
                WHERE s."deviceId" = bd."id"
                  AND dep."endDate" IS NULL
                  AND dep."isInterruptible" = true
              )
              AND NOT EXISTS (
                SELECT 1 FROM "InterruptibleClaim" ic
                INNER JOIN "Server" s ON s."id" = ic."serverId"
                WHERE s."deviceId" = bd."id"
                  AND ic."status" = ${InterruptibleClaimStatus.Pending}
              )
            THEN 'on demand'
            WHEN LOWER(srv."lifecycleStatus"::text) IN ('provisioned', 'deprovisioning', 'offline', 'provisioning', 'failed')
            THEN 'reserve'
            ELSE 'preorder'
          END as stock_status
        FROM "Device" bd
        INNER JOIN "Server" srv ON srv."deviceId" = bd."id"
        WHERE
          srv."isListed" = true
          AND bd."role" = ${DeviceRole.Server}::"DeviceRole"
          AND bd."deletedAt" IS NULL
          AND (SELECT count(*) FROM "Gpu" g WHERE g."deviceId" = bd."id") > 0
      ) device_statuses
      GROUP BY category, stock_status
      ORDER BY category ASC
    `;

    const categoryMap = new Map<string, { onDemandCount: number; reserveCount: number; preorderCount: number }>();

    for (const row of results) {
      if (!categoryMap.has(row.category)) {
        categoryMap.set(row.category, { onDemandCount: 0, reserveCount: 0, preorderCount: 0 });
      }
      const entry = categoryMap.get(row.category)!;
      const count = Number(row.device_count);

      switch (row.stock_status) {
        case 'on demand':
          entry.onDemandCount = count;
          break;
        case 'reserve':
          entry.reserveCount = count;
          break;
        case 'preorder':
          entry.preorderCount = count;
          break;
      }
    }

    return Array.from(categoryMap.entries()).map(([category, counts]) => ({
      category,
      hasOnDemand: counts.onDemandCount > 0,
      onDemandCount: counts.onDemandCount,
      hasReserve: counts.reserveCount > 0,
      reserveCount: counts.reserveCount,
      hasPreorder: counts.preorderCount > 0,
      preorderCount: counts.preorderCount,
    }));
  }

  /** DCIM invite-create predicate. Does not require `isListed`; marketplace `findListings` is the listed catalog. */
  private static availableForInviteWhere(): Prisma.DeviceWhereInput {
    return {
      server: {
        lifecycleStatus: ServerLifecycleStatus.INVENTORY,
        deployments: { none: { endDate: null } },
        serversInReservation: {
          none: { reservation: { endDate: null } },
        },
        serversInReservationInvite: {
          none: {
            reservationInvite: {
              dateExpires: { gt: new Date() },
              dateAccepted: null,
              dateDeleted: null,
            },
          },
        },
      },
    };
  }

  private static deviceFilter(category?: DeviceCategory) {
    const baseFilter: Record<string, unknown> = {
      status: DeviceStatus.ACTIVE,
    };

    const mappedCategory = InventoryRecord.categoryMapper(category);

    switch (mappedCategory) {
      case undefined:
        return baseFilter;
      case 'cpu':
        return {
          ...baseFilter,
          gpus: { none: {} },
        };
      default:
        return {
          ...baseFilter,
          gpus: {
            some: {
              model: {
                contains: mappedCategory,
                mode: Prisma.QueryMode.insensitive,
              },
            },
          },
        };
    }
  }

  private static categoryMapper(category?: DeviceCategory) {
    switch (category) {
      case 'rtx6000':
        return 'RTX PRO 6000';
      default:
        return category;
    }
  }
}
