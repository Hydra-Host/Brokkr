import { HttpException, HttpStatus, NotFoundException } from '@nestjs/common';
import { ActiveRecordRegistry, createActiveRecord, TenantContextRequiredError } from '@repo/active-record';
import type { CommissionServerRequest, UpdateListingRequest } from '@repo/api-client';
import {
  DeviceRole,
  DeviceStatus,
  DeviceTestRun,
  DeviceTestStatus,
  DeviceTestType,
  JobStatus,
  JobType,
  Prisma,
  ServerLifecycleStatus,
  ServerPowerStatus,
  TeeCapability,
} from '@repo/database';
import type { PaginatedResult, PaginationQuery } from '@repo/database/pagination';
import { paginateQuery } from '@repo/database/pagination';
import { attachLatestGpuBurnInRuns, DeviceSpecColumnsSchema, hardwareSummaryInclude } from '@repo/device-domain';
import { devicesPaginationConfig } from 'src/devices/baremetal.pagination';
import { z } from 'zod';

const baremetalAggregateInclude = {
  supplier: true,
  server: {
    include: {
      deployments: {
        where: { endDate: null },
        include: {
          deployer: true,
          customer: true,
          reservation: { include: { reservationInvite: true } },
        },
      },
      serversInReservationInvite: {
        where: {
          reservationInvite: {
            dateAccepted: null,
            dateDeleted: null,
            dateExpires: { gt: new Date() },
          },
        },
        include: {
          reservationInvite: { include: { inviteeOrganization: true } },
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

type ServerInclude = NonNullable<typeof baremetalAggregateInclude.server.include>;
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

export const BaremetalPersistenceSchema = DeviceSpecColumnsSchema.extend({
  server: z.object({
    id: z.string(),
    lifecycleStatus: z.nativeEnum(ServerLifecycleStatus),
    updatedAt: z.date(),
    powerStatus: z.nativeEnum(ServerPowerStatus).nullable(),
    ipxeBuildTarget: z.string().nullable(),
    ipxeBuildVersion: z.string().nullable(),
    purgeTtys: z.boolean().nullable(),
    storageLayouts: z.unknown(),
    netplanOverride: z.string().nullable(),
    kernelCmdline: z.string().nullable(),
    vpcCapable: z.boolean().nullable(),
    teeEnabled: z.boolean(),
    teeCapable: z.nativeEnum(TeeCapability),
    ecoMode: z.boolean(),
    configTemplateId: z.string().nullable(),

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

type _RawBaremetalAggregate = Prisma.DeviceGetPayload<{ include: typeof baremetalAggregateInclude }>;
export type BaremetalAggregate = Omit<_RawBaremetalAggregate, 'server'> & {
  server: NonNullable<_RawBaremetalAggregate['server']>;
  deviceTestRuns?: DeviceTestRun[];
};

type HealthValue = 'Healthy' | 'Unhealthy';

const VALID_GPU_COUNT_OPS = new Set(['eq', 'neq', 'gt', 'gte', 'lt', 'lte']);
const GPU_COUNT_COMPARISONS: Record<string, string> = {
  neq: '<>',
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
};

export class BaremetalRecord extends createActiveRecord(BaremetalPersistenceSchema, 'device', {
  tenantField: 'supplierId',
  extension: { relationName: 'server' },
  discriminator: { role: DeviceRole.Server },
  softDeleteField: 'deletedAt',
  include: baremetalAggregateInclude,
  actions: {
    read: 'device:read',
    updateNickname: 'device:update',
    updateListing: 'device:update',
    decommission: 'device:delete',
  },
}) {
  static async findByDeviceId(
    deviceId: string,
    opts?: { tx?: Prisma.TransactionClient; includeDeleted?: boolean },
  ): Promise<BaremetalRecord | null> {
    this.requireAction('read');
    return this.findById(deviceId, opts);
  }

  static async findByDeviceIdOrThrow(
    deviceId: string,
    opts?: { tx?: Prisma.TransactionClient; includeDeleted?: boolean },
  ): Promise<BaremetalRecord> {
    const record = await BaremetalRecord.findByDeviceId(deviceId, opts);
    if (!record) throw new NotFoundException('Device not found');
    return record;
  }

  // Cross-tenant by intent (saga/billing paths run without a request context); the returned Server.id string carries no tenant-leak risk.
  static async serverIdByDeviceId(deviceId: string): Promise<string | null> {
    const row = await ActiveRecordRegistry.client.server.findUnique({
      where: { deviceId },
      select: { id: true },
    });
    return row?.id ?? null;
  }

  static async serverIdByDeviceIdOrThrow(deviceId: string): Promise<string> {
    const id = await BaremetalRecord.serverIdByDeviceId(deviceId);
    if (!id) throw new NotFoundException('Server not found');
    return id;
  }

  get data(): Readonly<BaremetalAggregate> {
    return super.data as unknown as Readonly<BaremetalAggregate>;
  }

  get serverId(): string {
    return this.data.server.id;
  }

  setEcoMode(value: boolean): this {
    return this.set({ server: { ecoMode: value } });
  }

  setTeeEnabled(value: boolean): this {
    return this.set({ server: { teeEnabled: value } });
  }

  setVpcCapable(value: boolean | null): this {
    return this.set({ server: { vpcCapable: value } });
  }

  setConfigTemplate(configTemplateId: string | null): this {
    return this.set({ server: { configTemplateId } });
  }

  setIpxeBuild(target: string | null, version: string | null): this {
    return this.set({ server: { ipxeBuildTarget: target, ipxeBuildVersion: version } });
  }

  setNetplanOverride(yaml: string | null): this {
    return this.set({ server: { netplanOverride: yaml } });
  }

  setStorageLayouts(layouts: Prisma.InputJsonValue): this {
    return this.set({ server: { storageLayouts: layouts } });
  }

  get isListable(): boolean {
    return Boolean(this.data.server.hourlyPrice && this.data.server.isListed);
  }

  updateListing(updateFields: UpdateListingRequest): this {
    const floorPrice = updateFields.floorHourlyPrice ?? this.data.server.floorHourlyPrice ?? updateFields.hourlyPrice;
    const floorDecimal = new Prisma.Decimal(Number(floorPrice));
    const onDemandDecimal = new Prisma.Decimal(updateFields.hourlyPrice);
    if (floorDecimal.greaterThan(onDemandDecimal)) {
      throw new HttpException('Floor price cannot be greater than on demand price', HttpStatus.BAD_REQUEST);
    }
    return this.set({
      server: {
        hourlyPrice: onDemandDecimal,
        floorHourlyPrice: floorDecimal,
        isListed: updateFields.isListed,
        isInterruptible: updateFields.isInterruptibleOnly ?? false,
      },
    });
  }

  unlist(): this {
    return this.set({ server: { isListed: false } });
  }

  decommission(): this {
    return this.set({
      deletedAt: new Date(),
      status: DeviceStatus.MAINTENANCE,
      server: { lifecycleStatus: ServerLifecycleStatus.OFFLINE },
    });
  }

  // Strips HTML / Unicode-direction chars usable for UI spoofing; empty input clears the nickname.
  updateNickname(nickname: string): this {
    const sanitized = nickname
      .replace(/[<>"'/\\]/g, '')
      .replace(/&(?:[a-zA-Z]+|#\d+|#x[0-9a-fA-F]+);/g, '')
      .replace(/[\u202E\u202D\u200E\u200F]/g, '');
    return this.set({ nickname: sanitized });
  }

  static async findPaginated(
    query: PaginationQuery,
    opts?: { decommissioned?: boolean },
  ): Promise<PaginatedResult<BaremetalAggregate>> {
    this.requireAction('read');
    const ctx = ActiveRecordRegistry.context;
    if (!ctx) throw new TenantContextRequiredError('device', 'supplierId');
    const supplierId = ctx.organizationId;

    const baseWhere: Prisma.DeviceWhereInput = {};

    if (!opts?.decommissioned) {
      baseWhere.status = DeviceStatus.ACTIVE;
    }

    const { adjustedFilters: afterHealth, healthValues } = BaremetalRecord.extractHealthFilter(query.filters);
    const { adjustedFilters, gpuCountFilters } = BaremetalRecord.extractGpuCountFilter(afterHealth);

    const idConstraints: string[][] = [];
    if (healthValues.length === 1) {
      idConstraints.push(await BaremetalRecord.getDeviceIdsForHealthFilter(supplierId, healthValues[0]));
    }
    if (gpuCountFilters.length > 0) {
      idConstraints.push(
        await BaremetalRecord.getDeviceIdsForGpuCountFilter(supplierId, gpuCountFilters, {
          decommissioned: opts?.decommissioned ?? false,
        }),
      );
    }
    if (idConstraints.length > 0) {
      const intersected = idConstraints.reduce<Set<string>>(
        (acc, ids, index) => (index === 0 ? new Set(ids) : new Set([...acc].filter((id) => ids.includes(id)))),
        new Set<string>(),
      );
      baseWhere.id = { in: Array.from(intersected) };
    }

    const searchWhere = BaremetalRecord.buildSearchWhere(query.search);
    const where: Prisma.DeviceWhereInput = searchWhere ? { AND: [baseWhere, searchWhere] } : baseWhere;

    return BaremetalRecord.paginateAggregates(
      where,
      { ...query, filters: adjustedFilters, search: undefined },
      { decommissioned: opts?.decommissioned ?? false },
    );
  }

  private static async paginateAggregates(
    baseWhere: Prisma.DeviceWhereInput,
    query: PaginationQuery,
    opts: { decommissioned: boolean },
  ): Promise<PaginatedResult<BaremetalAggregate>> {
    const where: Prisma.DeviceWhereInput = opts.decommissioned ? { ...baseWhere, deletedAt: { not: null } } : baseWhere;

    const result = await paginateQuery<BaremetalAggregate>(
      this._paginationDelegate<BaremetalAggregate>({ includeDeleted: opts.decommissioned }),
      query,
      devicesPaginationConfig,
      { where },
    );
    await attachLatestGpuBurnInRuns(result.data);
    return result;
  }

  static async getServerFilterOptionsRaw(
    supplierId: string,
    role?: string,
  ): Promise<{
    gpuCounts: number[];
    gpuModels: string[];
    memorySizes: number[];
    statuses: string[];
  }> {
    const client = ActiveRecordRegistry.client;

    const roleClause = role
      ? Prisma.sql`d."role" = ${role}::"DeviceRole"`
      : Prisma.sql`d."role" = ${DeviceRole.Server}::"DeviceRole"`;

    type Row = {
      gpu_counts: number[];
      gpu_models: string[];
      memory_sizes: number[];
      statuses: string[];
    };

    const [direct] = await client.$queryRaw<Row[]>`
      WITH base AS (
        SELECT
          d."id"           AS "id",
          d."status"::text AS "status",
          mc."totalSizeMb" AS "memory",
          (SELECT count(*)::int FROM "Gpu" g WHERE g."deviceId" = d."id") AS "gpuCount"
        FROM "Device" d
        LEFT JOIN "MemoryConfig" mc ON mc."deviceId" = d."id"
        WHERE d."supplierId" = ${supplierId}
          AND d."deletedAt" IS NULL
          AND ${roleClause}
      ),
      models AS (
        SELECT DISTINCT g."model" AS gpu_model
        FROM "Gpu" g
        JOIN "Device" d ON d."id" = g."deviceId"
        WHERE d."supplierId" = ${supplierId}
          AND d."deletedAt" IS NULL
          AND ${roleClause}
          AND g."model" IS NOT NULL AND g."model" <> ''
      )
      SELECT
        (SELECT COALESCE(array_agg(DISTINCT "gpuCount")
          FILTER (WHERE "gpuCount" IS NOT NULL AND "gpuCount" > 0), ARRAY[]::int[]) FROM base) AS gpu_counts,
        (SELECT COALESCE(array_agg(gpu_model), ARRAY[]::text[]) FROM models) AS gpu_models,
        (SELECT COALESCE(array_agg(DISTINCT "memory")
          FILTER (WHERE "memory" IS NOT NULL), ARRAY[]::int[]) FROM base) AS memory_sizes,
        (SELECT COALESCE(array_agg(DISTINCT "status")
          FILTER (WHERE "status" IS NOT NULL AND "status" <> ''), ARRAY[]::text[]) FROM base) AS statuses
    `;

    return {
      gpuCounts: (direct?.gpu_counts ?? []).map((n) => Number(n)),
      gpuModels: direct?.gpu_models ?? [],
      memorySizes: (direct?.memory_sizes ?? []).map((n) => Number(n)),
      statuses: direct?.statuses ?? [],
    };
  }

  // Must mirror `ServerSpecHelper.isHealthy`: a device with no completed run is null there, so it matches neither filter value here.
  static async getDeviceIdsForHealthFilter(supplierId: string, healthValue: HealthValue): Promise<string[]> {
    const client = ActiveRecordRegistry.client;

    const rows = await client.$queryRaw<{ id: string }[]>`
      WITH latest_completed AS (
        SELECT DISTINCT ON ("deviceId") "deviceId", "testPassed"
        FROM "DeviceTestRun"
        WHERE "type" = ${DeviceTestType.GpuBurnIn}::"DeviceTestType"
          AND "status" = ${DeviceTestStatus.Completed}::"DeviceTestStatus"
        ORDER BY "deviceId", "endTime" DESC NULLS LAST
      )
      SELECT d."id"
      FROM "Device" d
      LEFT JOIN latest_completed lc ON lc."deviceId" = d."id"
      WHERE d."supplierId" = ${supplierId}
        AND d."deletedAt" IS NULL
        AND (
          (${healthValue} = 'Healthy' AND lc."deviceId" IS NOT NULL AND lc."testPassed" = true)
          OR (${healthValue} = 'Unhealthy' AND lc."deviceId" IS NOT NULL AND lc."testPassed" IS DISTINCT FROM true)
        )
    `;
    return rows.map((r) => r.id);
  }

  private static extractHealthFilter(filters: unknown): {
    adjustedFilters: string | undefined;
    healthValues: HealthValue[];
  } {
    if (typeof filters !== 'string' || filters.length === 0) {
      return { adjustedFilters: undefined, healthValues: [] };
    }

    const tuples = filters.split('|');
    const kept: string[] = [];
    const healthValues: HealthValue[] = [];

    for (const tuple of tuples) {
      const [field, operator, ...rest] = tuple.split(':');
      const value = rest.join(':');
      if (field === 'isHealthy' && operator === 'eq' && (value === 'Healthy' || value === 'Unhealthy')) {
        healthValues.push(value);
        continue;
      }
      kept.push(tuple);
    }

    return {
      adjustedFilters: kept.length > 0 ? kept.join('|') : undefined,
      healthValues,
    };
  }

  private static extractGpuCountFilter(filters: string | undefined): {
    adjustedFilters: string | undefined;
    gpuCountFilters: Array<{ operator: string; value: number }>;
  } {
    if (typeof filters !== 'string' || filters.length === 0) {
      return { adjustedFilters: filters ?? undefined, gpuCountFilters: [] };
    }

    const kept: string[] = [];
    const gpuCountFilters: Array<{ operator: string; value: number }> = [];

    for (const tuple of filters.split('|')) {
      const [field, operator, ...rest] = tuple.split(':');
      const raw = rest.join(':');
      if (field === 'gpuCount' && VALID_GPU_COUNT_OPS.has(operator)) {
        const value = Number(raw);
        if (Number.isInteger(value)) {
          gpuCountFilters.push({ operator, value });
          continue;
        }
      }
      kept.push(tuple);
    }

    return { adjustedFilters: kept.length > 0 ? kept.join('|') : undefined, gpuCountFilters };
  }

  static async getDeviceIdsForGpuCountFilter(
    supplierId: string,
    filters: Array<{ operator: string; value: number }>,
    opts?: { decommissioned?: boolean },
  ): Promise<string[]> {
    const eqValues = filters.filter((f) => f.operator === 'eq').map((f) => f.value);
    const comparisons = filters.filter((f) => f.operator !== 'eq');

    const predicates: Prisma.Sql[] = [];
    if (eqValues.length > 0) {
      predicates.push(Prisma.sql`COALESCE(g.cnt, 0) IN (${Prisma.join(eqValues)})`);
    }
    for (const c of comparisons) {
      const op = GPU_COUNT_COMPARISONS[c.operator];
      if (!op) continue;
      predicates.push(Prisma.sql`COALESCE(g.cnt, 0) ${Prisma.raw(op)} ${c.value}`);
    }
    if (predicates.length === 0) return [];
    const predicate = predicates.reduce((acc, p, index) => (index === 0 ? p : Prisma.sql`${acc} AND ${p}`));

    const softDeleteClause = opts?.decommissioned
      ? Prisma.sql`d."deletedAt" IS NOT NULL`
      : Prisma.sql`d."deletedAt" IS NULL`;

    const client = ActiveRecordRegistry.client;
    const rows = await client.$queryRaw<{ id: string }[]>`
      SELECT d."id"
      FROM "Device" d
      LEFT JOIN (
        SELECT "deviceId", count(*)::int AS cnt FROM "Gpu" GROUP BY "deviceId"
      ) g ON g."deviceId" = d."id"
      WHERE d."supplierId" = ${supplierId}
        AND ${softDeleteClause}
        AND (${predicate})
    `;
    return rows.map((r) => r.id);
  }

  private static buildSearchWhere(search: unknown): Prisma.DeviceWhereInput | undefined {
    if (typeof search !== 'string' || search.length === 0) return undefined;
    const contains = { contains: search, mode: Prisma.QueryMode.insensitive } as const;
    return {
      OR: [
        { id: contains },
        { nickname: contains },
        { name: contains },
        { serial: contains },
        { gpus: { some: { model: contains } } },
        { cpus: { some: { model: contains } } },
      ],
    };
  }

  static async createJob(params: { deviceId: string; jobType: JobType; job: Prisma.JsonValue; status?: JobStatus }) {
    const client = ActiveRecordRegistry.client;
    return client.job.create({
      data: {
        job: params.job,
        jobType: params.jobType,
        status: params.status ?? JobStatus.Completed,
        device: { connect: { id: params.deviceId } },
      },
    });
  }

  // IPMI credentials are stripped from the persisted job payload — only needed transiently by the bridge, and must not survive in the audit log.
  static async createCommissionJob(commissionDTO: CommissionServerRequest, jobId: string) {
    const client = ActiveRecordRegistry.client;
    const ctx = ActiveRecordRegistry.context;
    if (!ctx) throw new TenantContextRequiredError('device', 'supplierId');
    const supplierId = ctx.organizationId;

    return client.$transaction(async (tx) => {
      const device = await tx.device.findUnique({
        where: { id: commissionDTO.id, supplierId, deletedAt: null },
        select: { id: true },
      });

      if (!device) {
        throw new NotFoundException(`Device ${commissionDTO.id} not found`);
      }

      await tx.device.update({
        where: { id: device.id },
        data: { status: DeviceStatus.STAGED },
      });

      const { ipmiLogin: _ipmiLogin, ipmiPassword: _ipmiPassword, ...commissionSafeDTO } = commissionDTO;

      return tx.job.create({
        data: {
          id: jobId,
          job: JSON.stringify({ commission: commissionSafeDTO }),
          jobType: JobType.Commission,
          status: JobStatus.Completed,
          device: { connect: { id: device.id } },
        },
      });
    });
  }
}
