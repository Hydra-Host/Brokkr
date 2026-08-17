/**
 * Typed Prisma client for direct Hub Postgres reads/writes in e2e tests.
 *
 * TypeScript port of `scripts/local/stores.py:HubDB`. The Python version uses
 * raw psycopg SQL; this version uses the Prisma typed query API from
 * `@repo/database`.
 */

import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@repo/database';

const DEFAULT_DATABASE_URL = 'postgresql://brokkr:password@127.0.0.1:5432/brokkr';

export interface ServerState {
  lifecycleStatus: string | null;
  deviceStatus: string | null;
}

export interface PrefixDhcpPolicy {
  id: string;
  prefix: string;
  dhcpMode: string | null;
  ipxeBuildTarget: string | null;
  dhcpProxyAllowedMacs: string[];
}

export interface DeviceIdentityAndZone {
  id: string | null;
  zoneId: string | null;
}

export class HubDB {
  readonly prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  static fromEnv(): HubDB {
    const connectionString = process.env.HUB_DATABASE_URL ?? DEFAULT_DATABASE_URL;
    const adapter = new PrismaPg({ connectionString });
    return new HubDB(new PrismaClient({ adapter }));
  }

  /**
   * Return `{lifecycleStatus, deviceStatus}` -- the two lifecycle axes the
   * provision/deprovision sagas drive. Both null if the device doesn't exist.
   */
  async getServerState(deviceId: string): Promise<ServerState> {
    const device = await this.prisma.device.findUnique({
      where: { id: deviceId },
      select: {
        status: true,
        server: {
          select: { lifecycleStatus: true },
        },
      },
    });

    if (!device) {
      return { lifecycleStatus: null, deviceStatus: null };
    }

    return {
      lifecycleStatus: device.server?.lifecycleStatus ?? null,
      deviceStatus: device.status,
    };
  }

  /**
   * True if a Deployment row exists for the device with no endDate. The admin
   * `/deprovision` endpoint rejects devices in this state; callers must
   * end-rental instead, which closes the deployment then decoms.
   *
   * `Deployment` links to a `Server` (`serverId`), not the `Device` directly,
   * so we join through `Server.deviceId`.
   */
  async hasActiveDeployment(deviceId: string): Promise<boolean> {
    const server = await this.prisma.server.findUnique({
      where: { deviceId },
      select: { id: true },
    });

    if (!server) return false;

    const deployment = await this.prisma.deployment.findFirst({
      where: {
        serverId: server.id,
        endDate: null,
      },
      select: { id: true },
    });

    return deployment !== null;
  }

  /**
   * Return the active Deployment ID for a device, or null.
   */
  async getActiveDeploymentId(deviceId: string): Promise<string | null> {
    const server = await this.prisma.server.findUnique({
      where: { deviceId },
      select: { id: true },
    });

    if (!server) return null;

    const deployment = await this.prisma.deployment.findFirst({
      where: {
        serverId: server.id,
        endDate: null,
      },
      orderBy: { startDate: 'desc' },
      select: { id: true },
    });

    return deployment?.id ?? null;
  }

  /** The installed/rescue slugs the hub renders into device_record, from the open deployment. */
  async getChainBootOs(deviceId: string): Promise<{ installed: string | null; rescue: string | null }> {
    const deployment = await this.prisma.deployment.findFirst({
      where: { server: { deviceId }, endDate: null },
      orderBy: { startDate: 'desc' },
      select: {
        baseLayer: { select: { slug: true } },
        rescueLayer: { select: { slug: true } },
      },
    });
    if (!deployment) return { installed: null, rescue: null };
    return {
      installed: deployment.baseLayer?.slug ?? null,
      rescue: deployment.rescueLayer?.slug ?? null,
    };
  }

  /**
   * Read `Server.storageLayouts` -- the seeded disk catalog a provision
   * request's `diskLayouts` must agree with.
   */
  async getStorageLayouts(deviceId: string): Promise<Record<string, unknown> | null> {
    const server = await this.prisma.server.findUnique({
      where: { deviceId },
      select: { storageLayouts: true },
    });

    if (!server?.storageLayouts) return null;

    const layouts = server.storageLayouts;
    if (typeof layouts === 'object' && layouts !== null) {
      return layouts as Record<string, unknown>;
    }
    if (typeof layouts === 'string') {
      return JSON.parse(layouts) as Record<string, unknown>;
    }
    return null;
  }

  /**
   * Return all SshKeys IDs, excluding Vault-signed cert pubkeys
   * (`*-cert-v01@openssh.com`) which auth against a CA the deployed sshd
   * doesn't trust.
   */
  async listSshKeyIds(): Promise<string[]> {
    const keys = await this.prisma.sshKeys.findMany({
      where: {
        NOT: {
          key: { contains: '-cert-v01@openssh.com ' },
        },
      },
      orderBy: { name: 'asc' },
      select: { id: true },
    });

    return keys.map((k: { id: string }) => k.id);
  }

  /**
   * Return `{id, zoneId}` for a Device -- the identity the commission request is
   * built from. Post-NetBox-removal the commission endpoint resolves devices by
   * `Device.id`; the commissioning record IS a role=null Device.
   */
  async getDeviceIdentityAndZone(deviceId: string): Promise<DeviceIdentityAndZone> {
    const device = await this.prisma.device.findUnique({
      where: { id: deviceId },
      select: {
        id: true,
        zoneId: true,
      },
    });

    if (!device) {
      return { id: null, zoneId: null };
    }

    return {
      id: device.id,
      zoneId: device.zoneId,
    };
  }

  /**
   * Return the most recent Job ID for a device. May return null since the main
   * API doesn't create Job rows -- the bridge saga does.
   */
  async getLatestJobId(deviceId: string): Promise<string | null> {
    const job = await this.prisma.job.findFirst({
      where: { deviceId },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });

    return job?.id ?? null;
  }

  /** Resolve seeded Device ids by their IPMI/BMC plane address -- the fleet.yml <-> Hub join the smoke test asserts. */
  async getDeviceIdsByBmcIps(bmcIps: string[]): Promise<{ id: string; ipmiIp: string }[]> {
    if (bmcIps.length === 0) return [];
    return this.prisma.$queryRaw<{ id: string; ipmiIp: string }[]>`
      SELECT d.id, host(ipmi.address) AS "ipmiIp"
      FROM "Device" d
      JOIN "Interface" ii ON ii."deviceId" = d.id AND ii.name = 'IPMI'
      JOIN "IpAddress" ipmi ON ipmi."interfaceId" = ii.id
      WHERE host(ipmi.address) = ANY(${bmcIps})
    `;
  }

  /** Resolve a Device by one of its interface MACs. */
  async getDeviceIdByMac(mac: string): Promise<string | null> {
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT d.id
      FROM "Device" d
      JOIN "Interface" ii ON ii."deviceId" = d.id
      WHERE lower(ii."macAddress") = lower(${mac})
        AND ii."deletedAt" IS NULL
        AND d."deletedAt" IS NULL
      ORDER BY ii."createdAt" ASC
      LIMIT 1
    `;
    return rows[0]?.id ?? null;
  }

  /** Per-prefix DHCP policy for the prefix containing `ip` (longest match), or null. */
  async getDhcpPolicyForIp(ip: string): Promise<PrefixDhcpPolicy | null> {
    const rows = await this.prisma.$queryRaw<PrefixDhcpPolicy[]>`
      SELECT p.id,
             p.prefix::text AS prefix,
             p."dhcpMode"::text AS "dhcpMode",
             p."ipxeBuildTarget"::text AS "ipxeBuildTarget",
             p."dhcpProxyAllowedMacs" AS "dhcpProxyAllowedMacs"
      FROM "Prefix" p
      WHERE p."deletedAt" IS NULL
        AND ${ip}::inet <<= p.prefix
      ORDER BY masklen(p.prefix) DESC
      LIMIT 1
    `;
    return rows[0] ?? null;
  }

  /** True when the device's effective layer build is READY and carries a BASE artifact for slug/arch. */
  async hasBaseArtifact(slug: string, arch: string, deviceId: string): Promise<boolean> {
    // Resolved first so an unconfigured build is distinguishable: folded into the COUNT it would
    // compare against NULL, return 0, and be reported as a missing artifact.
    const build = await this.prisma.$queryRaw<{ id: string | null }[]>`
      SELECT COALESCE(
        (SELECT z."layerBuildId" FROM "Device" d JOIN "Zone" z ON z.id = d."zoneId" WHERE d.id = ${deviceId}),
        (SELECT s."defaultLayerBuildId" FROM "PlatformSettings" s WHERE s.id = 'singleton')
      ) AS id
    `;
    const buildId = build[0]?.id ?? null;
    if (buildId === null) {
      throw new Error(
        `no effective LayerBuild for device ${deviceId}: Zone.layerBuildId and ` +
          'PlatformSettings.defaultLayerBuildId are both null — configure a default build in hub Settings',
      );
    }
    const rows = await this.prisma.$queryRaw<{ count: bigint }[]>`
      SELECT count(*) AS count
      FROM "LayerArtifact" a
      JOIN "Layer" l ON l.id = a."layerId"
      JOIN "LayerBuild" b ON b.id = a."layerBuildId"
      WHERE l.slug = ${slug}
        AND l.kind = 'BASE'
        AND a.arch = ${arch}
        AND b.status = 'READY'
        AND b.id = ${buildId}
    `;
    return (rows[0]?.count ?? 0n) > 0n;
  }

  async getDataIpByBootMac(bootMac: string): Promise<string | null> {
    const rows = await this.prisma.$queryRaw<{ dataIp: string }[]>`
      SELECT host(ip.address) AS "dataIp"
      FROM "Interface" ii
      JOIN "IpAddress" ip ON ip."interfaceId" = ii.id
      WHERE lower(ii."macAddress") = lower(${bootMac})
        AND ii."deletedAt" IS NULL
        AND ip."deletedAt" IS NULL
        AND ip.status = 'ACTIVE'
        AND family(ip.address) = 4
      ORDER BY ip."createdAt" DESC
      LIMIT 1
    `;
    return rows[0]?.dataIp ?? null;
  }
}
