import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { BridgeResponse } from '@repo/api-client';
import { DeviceRole, Prisma } from '@repo/database';
import { buildPaginatedResponse, paginateArray, type PaginationQuery } from '@repo/database/pagination';
import { deviceStatusToSlug } from '@repo/device-domain';
import Redis from 'ioredis';
import { ContextService } from 'src/common/context/context.service';
import { Logger } from 'src/common/decorators/logger.decorator';
import { getErrorMessage } from 'src/common/error-utils';
import { toInterfaceResponse } from 'src/common/interface-response.utils';
import { REDIS_CLIENT } from 'src/common/redis';
import { LoggerService } from 'src/logger/logger.service';
import { PrismaClient } from 'src/prisma/prisma.client';
import { type BridgePresence, lookupBridgePresence, OFFLINE_PRESENCE } from './bridge-presence.overlay';
import { bridgesPaginationConfig } from './bridges.pagination';

const bridgeInclude = {
  zone: { select: { name: true } },
  interfaces: { where: { deletedAt: null }, include: { ipAddresses: { where: { deletedAt: null } } } },
} satisfies Prisma.DeviceInclude;

type BridgeDevice = Prisma.DeviceGetPayload<{ include: typeof bridgeInclude }>;

const bridgeSummarySelect = {
  id: true,
  name: true,
  status: true,
  zone: { select: { name: true } },
} satisfies Prisma.DeviceSelect;

type BridgeSummary = Prisma.DeviceGetPayload<{ select: typeof bridgeSummarySelect }>;

type BridgeSortable = Pick<BridgeResponse, 'id' | 'name' | 'status' | 'type'> & {
  datacenter: { name: string };
  zone: { name: string };
};

@Injectable()
export class BridgesService {
  constructor(
    private readonly contextService: ContextService,
    private readonly prisma: PrismaClient,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Logger(BridgesService.name) private readonly logger: LoggerService,
  ) {}

  private async presenceFor(devices: BridgeDevice[]): Promise<Map<string, BridgePresence>> {
    try {
      return await lookupBridgePresence(this.redis, devices);
    } catch (error) {
      this.logger.warn(`Redis presence lookup failed, falling back to offline: ${getErrorMessage(error)}`);
      return new Map();
    }
  }

  private get organizationId(): string {
    return this.contextService.requireIdentity.organization.id;
  }

  private mapBridge(device: BridgeDevice, presence: BridgePresence): BridgeResponse {
    return {
      id: device.id,
      name: device.name,
      status: deviceStatusToSlug(device.status).toLowerCase(),
      type: 'managed',
      datacenter: { id: device.zoneId ?? '', name: device.zone?.name ?? '' },
      zone: device.zone ? { id: device.zoneId ?? '', name: device.zone.name } : { id: '', name: '' },
      // NICs come from the durable DB inventory (BridgePresenceReconcilerService syncs it from spoke presence); presence supplies only liveness (online/leader) below.
      interfaces: device.interfaces.map(toInterfaceResponse),
      online: presence.online,
      is_leader: presence.isLeader,
      active_plugins: presence.activePlugins,
    };
  }

  private mapSummary(device: BridgeSummary): BridgeSortable {
    return {
      id: device.id,
      name: device.name,
      status: deviceStatusToSlug(device.status).toLowerCase(),
      type: 'managed',
      datacenter: { name: device.zone?.name ?? '' },
      zone: { name: device.zone?.name ?? '' },
    };
  }

  async getBridgesPaginated(query: PaginationQuery & { zoneId?: string }) {
    const summaries = await this.prisma.device.findMany({
      where: {
        role: DeviceRole.Bridge,
        supplierId: this.organizationId,
        deletedAt: null,
        ...(query.zoneId ? { zoneId: query.zoneId } : {}),
      },
      select: bridgeSummarySelect,
      orderBy: { name: 'asc' },
    });

    const page = paginateArray(
      summaries.map((device) => this.mapSummary(device)) as (BridgeSortable & Record<string, unknown>)[],
      query,
      bridgesPaginationConfig,
    );

    const pageIds = page.data.map((bridge) => bridge.id);
    const devices = await this.prisma.device.findMany({
      where: { id: { in: pageIds }, role: DeviceRole.Bridge, supplierId: this.organizationId, deletedAt: null },
      include: bridgeInclude,
    });

    const presence = await this.presenceFor(devices);
    const byId = new Map(devices.map((device) => [device.id, device]));
    const data = pageIds.flatMap((id) => {
      const device = byId.get(id);
      return device ? [this.mapBridge(device, presence.get(device.id) ?? OFFLINE_PRESENCE)] : [];
    });

    return buildPaginatedResponse(data, page.meta.totalItems, query, bridgesPaginationConfig.defaultPageSize);
  }

  async getBridgeById(bridgeId: string): Promise<BridgeResponse> {
    const device = await this.prisma.device.findUnique({
      where: { id: bridgeId, role: DeviceRole.Bridge, supplierId: this.organizationId, deletedAt: null },
      include: bridgeInclude,
    });

    if (!device) {
      throw new NotFoundException('Bridge not found');
    }

    const presence = await this.presenceFor([device]);
    const bridge = this.mapBridge(device, presence.get(device.id) ?? OFFLINE_PRESENCE);
    await this.enrichInterfacePrefixes(device.zoneId, bridge);
    return bridge;
  }

  // Role is lowercased to match the web's `role === 'management'` check. Best-effort: a DB
  // failure leaves IPs without prefix info rather than 500ing the bridge detail view.
  private async enrichInterfacePrefixes(zoneId: string | null, bridge: BridgeResponse): Promise<void> {
    if (!zoneId) return;
    // Exclude IPv6 up front so those IPs keep `prefix` absent (not null, matching the list
    // endpoint) and an IPv6-only bridge skips the round-trip.
    const ipv4Ips = bridge.interfaces.flatMap((i) => i.ip_addresses).filter((ip) => !ip.address.includes(':'));
    if (ipv4Ips.length === 0) return;

    try {
      const rows = await this.prisma.$queryRaw<
        Array<{ ipId: string; prefixId: string; prefix: string; role: string | null }>
      >`
        SELECT DISTINCT ON (ip.id)
          ip.id AS "ipId", p.id AS "prefixId", p.prefix::text AS prefix, lower(p.role::text) AS role
        FROM "IpAddress" ip
        JOIN "Prefix" p
          ON p."deletedAt" IS NULL
         AND p."zoneId" = ${zoneId}
         AND family(p.prefix) = 4
         -- host() strips any connected subnet mask the reconciler stored (e.g. 10.0.0.5/24) so we
         -- test HOST containment, not network containment: a more-specific prefix that holds the
         -- host but not the wider stored network must still match for longest-prefix role enrichment.
         AND p.prefix >>= host(ip.address::inet)::inet
        WHERE ip.id IN (${Prisma.join(ipv4Ips.map((ip) => ip.id))})
          AND family(ip.address) = 4
        ORDER BY ip.id, masklen(p.prefix) DESC
      `;
      const byId = new Map(rows.map((r) => [r.ipId, { id: r.prefixId, prefix: r.prefix, role: r.role }]));
      for (const ip of ipv4Ips) {
        ip.prefix = byId.get(ip.id) ?? null;
      }
    } catch (error) {
      this.logger.warn(
        `enrichInterfacePrefixes failed for zone ${zoneId}, prefixes omitted: ${getErrorMessage(error)}`,
      );
    }
  }
}
