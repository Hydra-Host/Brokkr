import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@repo/database';

import type { ZoneServiceTuning } from '@repo/api-client';
import { DhcpConfigPublisherService } from 'src/brokkr-bridge/dhcp/dhcp-config-publisher.service';
import { ContextService } from 'src/common/context/context.service';
import { Logger } from 'src/common/decorators/logger.decorator';
import { LoggerService } from 'src/logger/logger.service';
import { PrismaClient } from 'src/prisma/prisma.client';

const SERVICE_TUNING_SELECT = {
  dhcpLeaderPollMs: true,
  dhcpPruneIntervalMs: true,
  dhcpDeclineBackoffSeconds: true,
  vrrpGarpCount: true,
} as const satisfies Prisma.ZoneSelect;

type ServiceTuningRow = Prisma.ZoneGetPayload<{ select: typeof SERVICE_TUNING_SELECT }>;

@Injectable()
export class ServiceTuningService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly contextService: ContextService,
    private readonly dhcpPublisher: DhcpConfigPublisherService,
    @Logger(ServiceTuningService.name) private readonly logger: LoggerService,
  ) {}

  async getZoneServiceTuning(zoneId: string): Promise<ZoneServiceTuning> {
    this.contextService.requirePermission('zone', 'read');

    const row = await this.prisma.zone.findUnique({
      where: { id: zoneId, organizationId: this.contextService.organizationId, deletedAt: null },
      select: SERVICE_TUNING_SELECT,
    });
    if (!row) {
      throw new NotFoundException('Zone not found');
    }

    return mapServiceTuning(row);
  }

  async updateZoneServiceTuning(zoneId: string, body: ZoneServiceTuning): Promise<ZoneServiceTuning> {
    this.contextService.requirePermission('zone', 'update');

    let row: ServiceTuningRow;
    try {
      row = await this.prisma.zone.update({
        where: { id: zoneId, organizationId: this.contextService.organizationId, deletedAt: null },
        data: {
          dhcpLeaderPollMs: body.dhcpLeaderPollMs,
          dhcpPruneIntervalMs: body.dhcpPruneIntervalMs,
          dhcpDeclineBackoffSeconds: body.dhcpDeclineBackoffSeconds,
          vrrpGarpCount: body.vrrpGarpCount,
        },
        select: SERVICE_TUNING_SELECT,
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
        throw new NotFoundException('Zone not found');
      }
      throw error;
    }

    const audit = this.contextService.buildAuditPayload();
    this.logger.log(
      `Service tuning updated for zone ${zoneId} | actor=${audit.triggeredByEmail} (${audit.triggeredBy})`,
    );

    // A vrrpGarpCount change has no eager path — the hub VRRP reconciler cron detects the
    // divergent atoms within a minute and republishes them.
    await this.dhcpPublisher.publishZoneOps(zoneId);

    return mapServiceTuning(row);
  }
}

function mapServiceTuning(row: ServiceTuningRow): ZoneServiceTuning {
  return {
    dhcpLeaderPollMs: row.dhcpLeaderPollMs,
    dhcpPruneIntervalMs: row.dhcpPruneIntervalMs,
    dhcpDeclineBackoffSeconds: row.dhcpDeclineBackoffSeconds,
    vrrpGarpCount: row.vrrpGarpCount,
  };
}
