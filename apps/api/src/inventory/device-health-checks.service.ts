import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  type DeviceHealthChecksListResponse,
  type DeviceHealthSnapshot,
  type DeviceHealthSummary,
  HEALTH_CHECK_RETENTION_DAYS,
} from '@repo/api-client';
import type { DeviceHealthCheck } from '@repo/database';
import {
  createPaginationConfig,
  type ModelFieldPaths,
  paginateQuery,
  type PaginationQuery,
} from '@repo/database/pagination';
import {
  HealthSnapshotReader,
  type HealthView,
  presentHealthSummary,
  snapshotChecks,
  type SnapshotRedis,
  toHealthCheckRow,
} from '@repo/device-domain';
import { DeviceContextService } from 'src/brokkr-bridge/device-context.service';
import { ContextService } from 'src/common/context/context.service';
import { REDIS_CLIENT } from 'src/common/redis';
import { BaremetalRecord } from 'src/devices/baremetal.record';
import { PrismaClient } from 'src/prisma/prisma.client';

type HealthCheckField = ModelFieldPaths<DeviceHealthCheck>;

const healthChecksPaginationConfig = createPaginationConfig<HealthCheckField>({
  searchableFields: [],
  sortableFields: { testedAt: 'testedAt' },
  defaultSort: [
    { field: 'testedAt', direction: 'desc' },
    { field: 'id', direction: 'desc' },
  ],
  defaultPageSize: 25,
});

@Injectable()
export class DeviceHealthChecksService {
  private readonly snapshots: HealthSnapshotReader;

  constructor(
    @Inject(PrismaClient) private readonly prisma: Pick<PrismaClient, 'deviceHealthCheck' | 'device'>,
    @Inject(REDIS_CLIENT) redis: SnapshotRedis,
    @Inject(DeviceContextService) private readonly deviceContext: Pick<DeviceContextService, 'resolveZoneContext'>,
    @Inject(ContextService) private readonly contextService: Pick<ContextService, 'organizationId'>,
  ) {
    this.snapshots = new HealthSnapshotReader(redis);
  }

  async list(deviceId: string, query: PaginationQuery): Promise<DeviceHealthChecksListResponse> {
    await BaremetalRecord.findByDeviceIdOrThrow(deviceId);
    const result = await paginateQuery<DeviceHealthCheck>(
      this.prisma.deviceHealthCheck,
      query,
      healthChecksPaginationConfig,
      { where: { deviceId } },
    );
    return {
      data: result.data.map(toHealthCheckRow),
      meta: result.meta,
      retentionDays: HEALTH_CHECK_RETENTION_DAYS,
      edgeTriggered: true,
    };
  }

  async summary(deviceId: string): Promise<DeviceHealthSummary> {
    const organizationId = this.contextService.organizationId;
    // the netplan shape: the supplier or the active customer may read; missing and inaccessible both 404
    const device = await this.prisma.device.findUnique({
      where: {
        id: deviceId,
        deletedAt: null,
        OR: [
          { supplierId: organizationId },
          { server: { deployments: { some: { customerId: organizationId, endDate: null } } } },
        ],
      },
      select: { id: true, supplierId: true, server: { select: { ecoMode: true } } },
    });
    if (!device) throw new NotFoundException('Server not found');
    const view: HealthView = device.supplierId === organizationId ? 'owner' : 'customer';
    const ecoMode = device.server?.ecoMode ?? false;

    const snapshot = await this.readSnapshot(deviceId);
    if (snapshot !== null) {
      return presentHealthSummary(
        {
          source: 'snapshot',
          checkedAt: new Date(snapshot.checked_at * 1000).toISOString(),
          checks: snapshotChecks(snapshot),
          ecoMode,
        },
        view,
      );
    }

    const latest = await this.prisma.deviceHealthCheck.findFirst({
      where: { deviceId },
      orderBy: { testedAt: 'desc' },
    });
    if (latest) {
      return presentHealthSummary(
        { source: 'history', checkedAt: latest.testedAt.toISOString(), checks: latest, ecoMode },
        view,
      );
    }

    return presentHealthSummary(null, view);
  }

  // a device with no zone or an unreadable snapshot has no live value; the history row is the next source
  private async readSnapshot(deviceId: string): Promise<DeviceHealthSnapshot | null> {
    try {
      const { zoneId } = await this.deviceContext.resolveZoneContext(deviceId);
      return await this.snapshots.read(zoneId, deviceId);
    } catch {
      return null;
    }
  }
}
