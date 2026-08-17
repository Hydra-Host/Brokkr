import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@repo/database';

import type { ZoneDnsConfig } from '@repo/api-client';
import { DnsConfigPublisherService } from 'src/brokkr-bridge/dns/dns-config-publisher.service';
import { DNS_ZONE_BASE_SELECT, type DnsZoneBaseRow } from 'src/brokkr-bridge/dns/dns-zone-select.constants';
import { ContextService } from 'src/common/context/context.service';
import { Logger } from 'src/common/decorators/logger.decorator';
import { LoggerService } from 'src/logger/logger.service';
import { PrismaClient } from 'src/prisma/prisma.client';

@Injectable()
export class DnsConfigService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly contextService: ContextService,
    private readonly dnsPublisher: DnsConfigPublisherService,
    @Logger(DnsConfigService.name) private readonly logger: LoggerService,
  ) {}

  async getZoneDnsConfig(zoneId: string): Promise<ZoneDnsConfig> {
    this.contextService.requirePermission('zone', 'read');

    const row = await this.prisma.zone.findUnique({
      where: { id: zoneId, organizationId: this.contextService.organizationId, deletedAt: null },
      select: DNS_ZONE_BASE_SELECT,
    });
    if (!row) {
      throw new NotFoundException('Zone not found');
    }

    return mapZoneDnsConfig(row);
  }

  async updateZoneDnsConfig(zoneId: string, body: ZoneDnsConfig): Promise<ZoneDnsConfig> {
    this.contextService.requirePermission('zone', 'update');

    let row: DnsZoneBaseRow;
    try {
      row = await this.prisma.zone.update({
        where: { id: zoneId, organizationId: this.contextService.organizationId, deletedAt: null },
        data: {
          dnsEnabled: body.enabled,
          dnsUpstreamResolvers: body.upstreamResolvers,
          dnsTtlSeconds: body.ttlSeconds,
          dnsCacheSize: body.cacheSize,
          dnsOwnedDomain: body.ownedDomain,
          dnsUpstreamTimeoutMs: body.upstreamTimeoutMs,
          dnsPollMs: body.pollMs,
          dnsTcpMaxConnections: body.tcpMaxConnections,
          dnsTcpMaxQueriesPerConn: body.tcpMaxQueriesPerConn,
          dnsTcpIdleTimeoutMs: body.tcpIdleTimeoutMs,
          dnsTcpMaxMessageBytes: body.tcpMaxMessageBytes,
          dnsMaxTtlSeconds: body.maxTtlSeconds,
          dnsMaxCacheTtlSeconds: body.maxCacheTtlSeconds,
          dnsMinCacheTtlSeconds: body.minCacheTtlSeconds,
          dnsNegTtlSeconds: body.negTtlSeconds,
        },
        select: DNS_ZONE_BASE_SELECT,
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
        throw new NotFoundException('Zone not found');
      }
      throw error;
    }

    const audit = this.contextService.buildAuditPayload();
    this.logger.log(`DNS config updated for zone ${zoneId} | actor=${audit.triggeredByEmail} (${audit.triggeredBy})`);

    await this.dnsPublisher.publishZoneDnsConfig(zoneId);

    return mapZoneDnsConfig(row);
  }
}

function mapZoneDnsConfig(row: DnsZoneBaseRow): ZoneDnsConfig {
  return {
    enabled: row.dnsEnabled,
    upstreamResolvers: row.dnsUpstreamResolvers,
    ttlSeconds: row.dnsTtlSeconds,
    cacheSize: row.dnsCacheSize,
    ownedDomain: row.dnsOwnedDomain,
    upstreamTimeoutMs: row.dnsUpstreamTimeoutMs,
    pollMs: row.dnsPollMs,
    tcpMaxConnections: row.dnsTcpMaxConnections,
    tcpMaxQueriesPerConn: row.dnsTcpMaxQueriesPerConn,
    tcpIdleTimeoutMs: row.dnsTcpIdleTimeoutMs,
    tcpMaxMessageBytes: row.dnsTcpMaxMessageBytes,
    maxTtlSeconds: row.dnsMaxTtlSeconds,
    maxCacheTtlSeconds: row.dnsMaxCacheTtlSeconds,
    minCacheTtlSeconds: row.dnsMinCacheTtlSeconds,
    negTtlSeconds: row.dnsNegTtlSeconds,
  };
}
