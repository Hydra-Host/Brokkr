import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@repo/database';
import { PrismaClient } from '../../prisma/prisma.client';
import {
  deviceContextGatewayInclude,
  deviceContextInclude,
  deviceContextPrefixInclude,
  deviceContextTagAssignmentInclude,
  type BridgeDeviceIp,
  type DeviceContext,
  type DeviceWithRelations,
  type L3RouteIp,
  type PrefixWithRelations,
  type RawPrefixWithRelations,
} from './device-context.types';

@Injectable()
export class DeviceContextBuilder {
  constructor(private readonly prisma: PrismaClient) {}

  async build(deviceId: string): Promise<DeviceContext> {
    const device = await this.prisma.device.findUnique({
      where: { id: deviceId },
      include: deviceContextInclude,
    });
    if (!device) {
      throw new NotFoundException(`Device ${deviceId} not found`);
    }

    // VRFs the device's own IPs sit in. VPC routing resolves against these
    // (customer VRFs), which the supplier-scoped IPAM below cannot see.
    const ipVrfIds = [
      ...new Set(
        device.interfaces.flatMap((i) => i.ipAddresses.map((ip) => ip.vrfId).filter((id): id is string => id !== null)),
      ),
    ];

    const [rawIpam, rawVrfIpam] = await Promise.all([this.loadOrgIpam(device.supplierId), this.loadVrfIpam(ipVrfIds)]);

    const [rawPrefixByIpId, l3RouteIps, bridgeDeviceIps, tagAssignments, cabledInterfaceIds] = await Promise.all([
      this.resolvePrefixByIp(device, rawIpam.prefixes),
      this.loadL3RouteIps(device.supplierId),
      this.loadBridgeDeviceIps(device.supplierId),
      // Second batch because PREFIX-scoped assignments need the prefix ids the first batch resolves.
      this.loadTagAssignments(device, [
        ...new Set([...rawIpam.prefixes.map((p) => p.id), ...rawVrfIpam.prefixes.map((p) => p.id)]),
      ]),
      this.loadCabledInterfaceIds(device.interfaces.map((i) => i.id)),
    ]);

    const allPrefixIds = [
      ...rawIpam.prefixes.map((p) => p.id),
      ...rawVrfIpam.prefixes.map((p) => p.id),
      ...Object.values(rawPrefixByIpId)
        .filter((p): p is NonNullable<typeof p> => p !== null)
        .map((p) => p.id),
    ];
    const prefixCidrs = await this.fetchPrefixCidrs([...new Set(allPrefixIds)]);

    for (const prefix of rawIpam.prefixes) {
      (prefix as Record<string, unknown>)['prefix'] = prefixCidrs.get(prefix.id) ?? '';
    }
    for (const gw of rawIpam.gateways) {
      (gw.prefix as Record<string, unknown>)['prefix'] = prefixCidrs.get(gw.prefix.id) ?? '';
    }
    for (const [, prefix] of Object.entries(rawPrefixByIpId)) {
      if (prefix) {
        (prefix as Record<string, unknown>)['prefix'] = prefixCidrs.get(prefix.id) ?? '';
      }
    }

    const allIpIds = device.interfaces.flatMap((i) => i.ipAddresses.map((ip) => ip.id));
    const routingPrefixes = await this.fetchIpRoutingPrefixes(allIpIds);
    for (const iface of device.interfaces) {
      for (const ip of iface.ipAddresses) {
        (ip as Record<string, unknown>)['routingPrefix'] = routingPrefixes.get(ip.id) ?? null;
      }
    }
    for (const gw of rawIpam.gateways) {
      (gw.gatewayIp as Record<string, unknown>)['routingPrefix'] = routingPrefixes.get(gw.gatewayIp.id) ?? null;
    }

    const ipam: DeviceContext['ipam'] = {
      prefixes: rawIpam.prefixes as unknown as DeviceContext['ipam']['prefixes'],
      gateways: rawIpam.gateways as unknown as DeviceContext['ipam']['gateways'],
      vlans: rawIpam.vlans,
      vrfs: rawIpam.vrfs,
      l3RouteIps,
      bridgeDeviceIps,
      // Fresh objects, not enriched in place like the sets above: nothing else
      // holds a reference, so the cidr merge is a typed map, not an assertion.
      vrfPrefixes: withPrefixCidr(rawVrfIpam.prefixes, prefixCidrs),
    };
    const prefixByIpId = rawPrefixByIpId as unknown as DeviceContext['prefixByIpId'];
    const enrichedDevice = device as unknown as DeviceWithRelations;

    return { device: enrichedDevice, ipam, tagAssignments, prefixByIpId, cabledInterfaceIds };
  }

  private async resolvePrefixByIp<P extends { id: string }>(
    device: { supplierId: string | null; interfaces: Array<{ ipAddresses: Array<{ id: string }> }> },
    prefixes: P[],
  ): Promise<Record<string, P | null>> {
    const ipIds = device.interfaces.flatMap((i) => i.ipAddresses.map((ip) => ip.id));
    const result: Record<string, P | null> = Object.fromEntries(ipIds.map((id) => [id, null]));
    if (ipIds.length === 0 || !device.supplierId) return result;

    const rows = await this.prisma.$queryRaw<Array<{ ip_id: string; prefix_id: string }>>(Prisma.sql`
      SELECT DISTINCT ON (ip.id)
        ip.id AS ip_id,
        p.id AS prefix_id
      FROM "IpAddress" ip
      JOIN "Prefix" p
        ON p."organizationId" = ${device.supplierId}
        AND p."deletedAt" IS NULL
        AND family(p.prefix) = 4
        AND p.prefix >>= ip.address::inet
      LEFT JOIN "Gateway" g ON g."prefixId" = p.id
      WHERE ip.id IN (${Prisma.join(ipIds)})
        AND family(ip.address) = 4
      ORDER BY ip.id, (g.id IS NOT NULL) DESC, masklen(p.prefix) DESC
    `);

    const prefixById = new Map(prefixes.map((p) => [p.id, p]));
    for (const r of rows) {
      result[r.ip_id] = prefixById.get(r.prefix_id) ?? null;
    }
    return result;
  }

  private async loadOrgIpam(organizationId: string | null) {
    const where = organizationId ? { organizationId } : { id: '__no_org__' };
    const [prefixes, gateways, vlans, vrfs] = await Promise.all([
      this.prisma.prefix.findMany({ where, include: deviceContextPrefixInclude }),
      this.prisma.gateway.findMany({
        where: organizationId ? { prefix: { organizationId } } : { id: '__no_org__' },
        include: deviceContextGatewayInclude,
      }),
      this.prisma.vlan.findMany({ where }),
      this.prisma.vrf.findMany({ where }),
    ]);
    return { prefixes, gateways, vlans, vrfs };
  }

  /** VPC routing resolves against the VRF on the IP itself — a customer VRF owned by a different
   * org than the device's supplier — so this cannot fold into the org-scoped `loadOrgIpam`. */
  private async loadVrfIpam(vrfIds: string[]) {
    if (vrfIds.length === 0) return { prefixes: [] };
    // `deviceContextPrefixInclude` already pulls each prefix's gateways, which is
    // how the VPC renderers reach them — no separate gateway query.
    const prefixes = await this.prisma.prefix.findMany({
      where: { vrfId: { in: vrfIds } },
      include: deviceContextPrefixInclude,
    });
    return { prefixes };
  }

  /** Interfaces terminating a cable with status=CONNECTED — distinct from `Interface.markConnected`,
   * which is the operator's "pretend it is cabled" override. */
  private async loadCabledInterfaceIds(interfaceIds: string[]): Promise<string[]> {
    if (interfaceIds.length === 0) return [];
    const terminations = await this.prisma.cableTermination.findMany({
      where: {
        terminationType: 'INTERFACE',
        terminationId: { in: interfaceIds },
        cable: { status: 'CONNECTED' },
      },
      select: { terminationId: true },
    });
    return [...new Set(terminations.map((t) => t.terminationId))];
  }

  private async loadL3RouteIps(organizationId: string | null): Promise<L3RouteIp[]> {
    if (!organizationId) return [];
    const rows = await this.prisma.$queryRaw<
      Array<{ id: string; address: string; routing_prefix: string; containing_prefix_id: string }>
    >(Prisma.sql`
      SELECT DISTINCT ON (ip.id)
        ip.id,
        host(ip.address) AS address,
        ip."routingPrefix"::text AS routing_prefix,
        p.id AS containing_prefix_id
      FROM "IpAddress" ip
      JOIN "TagAssignment" ta
        ON ta."objectType" = 'IP_ADDRESS'
        AND ta."objectId" = ip.id
      JOIN "Tag" t
        ON t.id = ta."tagId"
        AND t.slug = 'l3-route'
      JOIN "Prefix" p
        ON p."organizationId" = ${organizationId}
        AND p."deletedAt" IS NULL
        AND family(p.prefix) = 4
        AND p.prefix >>= ip.address
      WHERE ip."organizationId" = ${organizationId}
        AND ip."deletedAt" IS NULL
        AND ip."routingPrefix" IS NOT NULL
        AND family(ip.address) = 4
      ORDER BY ip.id, masklen(p.prefix) DESC
    `);
    return rows.map((r) => ({
      id: r.id,
      address: r.address,
      routingPrefix: r.routing_prefix,
      containingPrefixId: r.containing_prefix_id,
    }));
  }

  private async loadBridgeDeviceIps(organizationId: string | null): Promise<BridgeDeviceIp[]> {
    if (!organizationId) return [];
    const rows = await this.prisma.$queryRaw<Array<{ id: string; address: string; containing_prefix_id: string }>>(
      Prisma.sql`
        SELECT DISTINCT ON (ip.id)
          ip.id,
          host(ip.address) AS address,
          p.id AS containing_prefix_id
        FROM "IpAddress" ip
        JOIN "Interface" iface
          ON iface.id = ip."interfaceId"
          AND iface."deletedAt" IS NULL
        JOIN "Device" d
          ON d.id = iface."deviceId"
          AND d.role = 'Bridge'
          AND d."supplierId" = ${organizationId}
        JOIN "Prefix" p
          ON p."organizationId" = ${organizationId}
          AND p."deletedAt" IS NULL
          AND family(p.prefix) = 4
          AND p.prefix >>= ip.address
        WHERE ip."organizationId" = ${organizationId}
          AND ip."deletedAt" IS NULL
          AND family(ip.address) = 4
        ORDER BY ip.id, masklen(p.prefix) DESC
      `,
    );
    return rows.map((r) => ({
      id: r.id,
      address: r.address,
      containingPrefixId: r.containing_prefix_id,
    }));
  }

  private async loadTagAssignments(
    device: {
      id: string;
      interfaces: Array<{ id: string; ipAddresses: Array<{ id: string }> }>;
    },
    prefixIds: string[],
  ) {
    const interfaceIds = device.interfaces.map((i) => i.id);
    const ipIds = device.interfaces.flatMap((i) => i.ipAddresses.map((ip) => ip.id));
    return this.prisma.tagAssignment.findMany({
      where: {
        OR: [
          { objectType: 'DEVICE', objectId: device.id },
          ...(interfaceIds.length > 0 ? [{ objectType: 'INTERFACE' as const, objectId: { in: interfaceIds } }] : []),
          ...(ipIds.length > 0 ? [{ objectType: 'IP_ADDRESS' as const, objectId: { in: ipIds } }] : []),
          // PREFIX scope: `oob-upstream`, read by the sans-VRF bridge renderer.
          ...(prefixIds.length > 0 ? [{ objectType: 'PREFIX' as const, objectId: { in: prefixIds } }] : []),
        ],
      },
      include: deviceContextTagAssignmentInclude,
    });
  }

  private async fetchPrefixCidrs(prefixIds: string[]): Promise<Map<string, string>> {
    if (prefixIds.length === 0) return new Map();
    const rows = await this.prisma.$queryRaw<Array<{ id: string; cidr: string }>>(
      Prisma.sql`SELECT id, prefix::text AS cidr FROM "Prefix" WHERE id IN (${Prisma.join(prefixIds)})`,
    );
    return new Map(rows.map((r) => [r.id, r.cidr]));
  }

  private async fetchIpRoutingPrefixes(ipIds: string[]): Promise<Map<string, string | null>> {
    if (ipIds.length === 0) return new Map();
    const rows = await this.prisma.$queryRaw<Array<{ id: string; routing_prefix: string | null }>>(
      Prisma.sql`SELECT id, "routingPrefix"::text AS routing_prefix FROM "IpAddress" WHERE id IN (${Prisma.join(ipIds)})`,
    );
    return new Map(rows.map((r) => [r.id, r.routing_prefix]));
  }
}

// `Prefix.prefix` is `Unsupported("cidr")`, so Prisma omits it and returns undefined; merging the
// fetched cidr text back in builds the `*WithRelations` intersection without an assertion.
function withPrefixCidr(prefixes: RawPrefixWithRelations[], cidrs: Map<string, string>): PrefixWithRelations[] {
  return prefixes.map((prefix) => ({ ...prefix, prefix: cidrs.get(prefix.id) ?? '' }));
}
