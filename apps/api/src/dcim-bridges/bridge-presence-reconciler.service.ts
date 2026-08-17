import { isIP } from 'node:net';

import { Inject, Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DeviceRole, DeviceStatus, InterfaceType, Prisma } from '@repo/database';
import { formatMacAddress } from '@repo/database/extensions/mac-address';
import Redis from 'ioredis';
import { uuidv5 } from 'src/brokkr-bridge/device-record/placeholder-id';
import { Logger } from 'src/common/decorators/logger.decorator';
import { getErrorMessage } from 'src/common/error-utils';
import { ipv4InCidr } from 'src/common/ip-utils';
import { ensureIpAddress } from 'src/common/ipam/ensure-ip-address';
import { REDIS_CLIENT, scanKeys } from 'src/common/redis';
import { REDIS_KEYS } from 'src/common/redis/redis-keys';
import { isValidInterfaceName } from 'src/dcim/interface/interface.record';
import { LoggerService } from 'src/logger/logger.service';
import { PrismaClient } from 'src/prisma/prisma.client';
import { z } from 'zod';
import { BridgePresenceHashSchema, BridgePresenceInterfaceSchema } from './bridge-presence.schema';

const BRIDGE_DEVICE_NAMESPACE = 'b1d6e0c2-7a3f-5e64-9c18-2f4a6b8d0e11';

const bridgeDeviceId = (zoneId: string, instanceId: string): string =>
  uuidv5(`${zoneId}:${instanceId}`, BRIDGE_DEVICE_NAMESPACE);

// A single assigned IP: the host address to persist (ip/prefixlen) plus the connected network CIDR it sits in (for Prefix find/create), or null when the presence entry carried no mask.
interface LiveIp {
  address: string;
  subnet: string | null;
}

// One NIC coalesced from the presence entries: stable identity (MAC when usable, else name) plus its unique assigned IPs.
interface LiveNic {
  name: string;
  /** Lowercased MAC, or null for NICs without a usable one (overlay/tunnel, e.g. wt0). */
  mac: string | null;
  ips: LiveIp[];
}

interface LiveGateway {
  subnet: string;
  gatewayIp: string;
}

// Canonicalize a stored MAC via the shared formatMacAddress for comparison against live MACs (already normalized by usableMac) — legacy DB rows may hold hyphen/uppercase forms.
const normalizeDbMac = (mac: string | null): string | null => (mac == null ? null : formatMacAddress(mac));

function masklenOf(cidr: string): number | null {
  const slash = cidr.indexOf('/');
  if (slash === -1) return null;
  const len = cidr.slice(slash + 1);
  return /^\d{1,3}$/.test(len) ? Number(len) : null;
}

function isNetworkSubnet(subnet: string): boolean {
  if (!subnet.includes('/')) return false;
  const host = subnet.split('/')[0];
  if (isIP(host) === 0) return false;
  const masklen = masklenOf(subnet);
  const maxLen = isIP(host) === 6 ? 128 : 32;
  return masklen !== null && masklen > 0 && masklen < maxLen;
}

const dbInterfaceSelect = {
  id: true,
  name: true,
  macAddress: true,
  type: true,
  enabled: true,
  markConnected: true,
  ipAddresses: { where: { deletedAt: null }, select: { id: true, address: true } },
} satisfies Prisma.InterfaceSelect;

type DbInterface = Prisma.InterfaceGetPayload<{ select: typeof dbInterfaceSelect }>;

// Empty / all-zero MACs (loopback, WireGuard/NetBird tunnels) can't disambiguate interfaces, so those NICs key on name.
function usableMac(mac: string): string | null {
  // Shared canonicaliser (colon-lowercase) — the same form the DB write extension and normalizeDbMac use, so live↔DB MAC matching stays consistent.
  const normalized = formatMacAddress(mac);
  if (!/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(normalized)) return null;
  if (normalized === '00:00:00:00:00:00') return null;
  return normalized;
}

type ParsedPresenceEntry = z.infer<typeof BridgePresenceInterfaceSchema>;

function parseInterfacesJson(interfacesJson: string): ParsedPresenceEntry[] | null {
  let raw: unknown;
  try {
    raw = JSON.parse(interfacesJson);
  } catch {
    return null;
  }
  const parsed = z.array(BridgePresenceInterfaceSchema).safeParse(raw);
  return parsed.success ? parsed.data : null;
}

function coalesceNics(entries: ParsedPresenceEntry[]): LiveNic[] {
  const byKey = new Map<string, { name: string; mac: string | null; ips: Map<string, LiveIp> }>();
  for (const entry of entries) {
    if (isIP(entry.ip) === 0) continue;
    const mac = usableMac(entry.mac);
    const key = mac ?? `name:${entry.iface}`;
    let nic = byKey.get(key);
    if (!nic) {
      nic = { name: entry.iface, mac, ips: new Map() };
      byKey.set(key, nic);
    }
    // First occurrence wins: connected entries precede the enumerator's L3-routed pseudo-entries that reuse this (iface, ip), so the dupes drop and the connected subnet's real mask is kept.
    if (!nic.ips.has(entry.ip)) {
      // Host IP rendered as ip/prefixlen (borrowing the connected subnet's mask), matching how netplan/UFW read IPs.
      const len = masklenOf(entry.subnet);
      nic.ips.set(entry.ip, {
        address: len !== null ? `${entry.ip}/${len}` : entry.ip,
        subnet: entry.subnet.includes('/') ? entry.subnet : null,
      });
    }
  }
  return [...byKey.values()].map((nic) => ({ name: nic.name, mac: nic.mac, ips: [...nic.ips.values()] }));
}

function extractLiveGateways(entries: ParsedPresenceEntry[]): LiveGateway[] {
  const seen = new Set<string>();
  const result: LiveGateway[] = [];
  for (const entry of entries) {
    // Routed entries carry the next-hop used to REACH the subnet, not a gateway FOR it.
    // The in-subnet check also drops routed entries from pre-marker agents.
    if (entry.routed === true) continue;
    if (!isValidInterfaceName(entry.iface)) continue;
    if (!entry.gateway || isIP(entry.gateway) !== 4) continue;
    if (!isNetworkSubnet(entry.subnet)) continue;
    if (!ipv4InCidr(entry.gateway, entry.subnet)) continue;
    const key = `${entry.subnet}|${entry.gateway}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ subnet: entry.subnet, gatewayIp: entry.gateway });
  }
  return result;
}

// Reflects live bridge presence (Redis-only — the spoke's leader-election registry) into durable Device(role=Bridge)/Bridge rows and their Interface/IpAddress inventory, because the UI and netplan/UFW renderers read the DB, not Redis.
// Liveness (online/leader) is NOT persisted — BridgesService derives it from Redis at read time. NICs match by MAC (live name/IP set wins, absent NICs disabled); background job → no request context → unscoped raw Prisma with an explicit organizationId (the zone's owner).
@Injectable()
export class BridgePresenceReconcilerService {
  private running = false;
  // deviceId -> last persisted signature (version + interfaces_json); an unchanged signature short-circuits the tick before any DB read.
  private readonly known = new Map<string, string>();

  constructor(
    private readonly prisma: PrismaClient,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Logger(BridgePresenceReconcilerService.name) private readonly logger: LoggerService,
  ) {}

  @Cron(CronExpression.EVERY_30_SECONDS, { name: 'bridge-presence-reconciler' })
  async handleCron(): Promise<void> {
    if (this.running) {
      this.logger.warn('Skipping bridge-presence reconcile — previous run still in flight');
      return;
    }
    this.running = true;
    try {
      await this.reconcile();
    } catch (error) {
      this.logger.error(`Bridge-presence reconcile failed: ${getErrorMessage(error)}`);
    } finally {
      this.running = false;
    }
  }

  private async reconcile(): Promise<void> {
    const keys = await scanKeys(this.redis, REDIS_KEYS.bridgeInstanceScanAll);
    if (keys.length === 0) return;

    const keysByZone = new Map<string, string[]>();
    for (const key of keys) {
      const zoneId = key.split(':bridge:instance:')[0];
      if (!zoneId) continue;
      const existing = keysByZone.get(zoneId);
      if (existing) existing.push(key);
      else keysByZone.set(zoneId, [key]);
    }

    const zones = await this.prisma.zone.findMany({
      where: { id: { in: [...keysByZone.keys()] }, deletedAt: null },
      select: { id: true, organizationId: true },
    });
    const orgByZone = new Map(zones.map((z) => [z.id, z.organizationId]));

    for (const [zoneId, zoneKeys] of keysByZone) {
      const organizationId = orgByZone.get(zoneId);
      if (!organizationId) {
        this.logger.warn(`Zone ${zoneId} not found (or deleted) — skipping its bridges`);
        continue;
      }
      for (const key of zoneKeys) {
        // Per-instance isolation: one bridge's reconcile throwing (tx/DB error) must not abort the
        // whole cron run and starve every later bridge until the next tick. Log and carry on.
        try {
          await this.reconcileInstance(zoneId, organizationId, key);
        } catch (error) {
          this.logger.error(`Bridge reconcile failed for ${key}: ${getErrorMessage(error)}`);
        }
      }
    }
  }

  private async reconcileInstance(zoneId: string, organizationId: string, key: string): Promise<void> {
    const parsed = BridgePresenceHashSchema.safeParse(await this.redis.hgetall(key));
    if (!parsed.success) {
      this.logger.warn(`Malformed bridge presence hash at ${key} — skipping`);
      return;
    }
    const {
      instance_id: instanceId,
      brokkr_worker_version: bridgeVersion,
      interfaces_json: interfacesJson,
    } = parsed.data;
    const deviceId = bridgeDeviceId(zoneId, instanceId);
    const version = bridgeVersion ?? '';
    // `\x01` sentinel: absent interfaces_json (cacheable) vs empty/"" (retry-worthy) — a bare
    // `?? ''` collapses both and can silently skip the malformed-JSON retry on the next tick.
    const signature = `${version}\x00${interfacesJson ?? '\x01'}`;

    if (this.known.get(deviceId) === signature) return;

    await this.prisma.device.upsert({
      where: { id: deviceId },
      create: {
        id: deviceId,
        name: instanceId,
        role: DeviceRole.Bridge,
        status: DeviceStatus.ACTIVE,
        organizationId,
        zoneId,
        bridge: { create: { redisQueuePrefix: zoneId, bridgeVersion: version, lastSeenAt: new Date() } },
      },
      update: {
        bridge: {
          upsert: {
            create: { redisQueuePrefix: zoneId, bridgeVersion: version, lastSeenAt: new Date() },
            update: { bridgeVersion: version, lastSeenAt: new Date() },
          },
        },
      },
    });

    // Absent/malformed interfaces_json means "no data this tick", not "no NICs" — skip NIC
    // sync rather than disabling the bridge's whole interface set.
    let nicSyncCompleted = interfacesJson === undefined; // no NIC data this tick → nothing to sync, cacheable
    if (interfacesJson !== undefined) {
      const entries = parseInterfacesJson(interfacesJson);
      if (entries === null) {
        this.logger.warn(`Malformed interfaces_json for bridge ${instanceId} (zone ${zoneId}) — skipping NIC sync`);
      } else if (entries.length === 0) {
        this.logger.warn(`Empty interfaces_json for bridge ${instanceId} (zone ${zoneId}) — skipping NIC sync`);
      } else {
        const liveNics = coalesceNics(entries);
        const liveGateways = extractLiveGateways(entries);
        const synced = await this.prisma.$transaction((tx) =>
          this.reconcileInterfaces(tx, deviceId, zoneId, organizationId, liveNics, liveGateways),
        );
        nicSyncCompleted = synced;
      }
    }

    // Cache stays stale on a skipped sync so the next tick retries rather than trusting bad input.
    if (nicSyncCompleted) {
      this.known.set(deviceId, signature);
    }
    this.logger.debug(`Reconciled bridge ${instanceId} (zone ${zoneId})`);
  }

  // MAC-less NICs are stored VIRTUAL so UFW's overlay derivation finds them; connected subnets
  // become zone Prefixes first so the netplan/UFW containment queries can classify the IPs.
  private async reconcileInterfaces(
    tx: Prisma.TransactionClient,
    deviceId: string,
    zoneId: string,
    organizationId: string,
    liveNics: LiveNic[],
    liveGateways: LiveGateway[],
  ): Promise<boolean> {
    // A forged presence hash could plant shell metacharacters that reach the UFW iptables
    // renderer via Interface.name — drop unsafe names (mirrors assertValidInterfaceName).
    const safeNics = liveNics.filter((nic) => {
      if (isValidInterfaceName(nic.name)) return true;
      this.logger.warn(`Skipping NIC with an unsafe name on device ${deviceId}`);
      return false;
    });

    // Every name unsafe (wholly forged hash): skip, or the absent-NIC cleanup below would
    // disable the entire existing inventory off untrustworthy input.
    if (safeNics.length === 0) {
      this.logger.warn(`No usable NICs for device ${deviceId} — skipping NIC sync`);
      return false;
    }

    await this.ensurePrefixes(tx, zoneId, organizationId, safeNics);
    await this.ensureGateways(tx, zoneId, organizationId, liveGateways);

    const dbIfaces = await tx.interface.findMany({
      where: { deviceId, deletedAt: null },
      select: dbInterfaceSelect,
    });

    const matched = new Set<string>();
    // In-place renames/creates can transiently collide on the partial unique index (deviceId,
    // name WHERE deletedAt IS NULL) — defer them to teardown → park → create → finalize below.
    const renames: Array<{ id: string; name: string }> = [];
    const toCreate: LiveNic[] = [];
    for (const nic of safeNics) {
      const dbIface = this.matchInterface(dbIfaces, nic, matched);
      if (!dbIface) {
        toCreate.push(nic);
        continue;
      }
      matched.add(dbIface.id);
      const data: Prisma.InterfaceUncheckedUpdateInput = {};
      if (nic.mac && normalizeDbMac(dbIface.macAddress) !== nic.mac) data.macAddress = nic.mac;
      if (!nic.mac && dbIface.type !== InterfaceType.VIRTUAL) data.type = InterfaceType.VIRTUAL;
      if (!dbIface.enabled) data.enabled = true; // re-enable a NIC that came back
      if (!dbIface.markConnected) data.markConnected = true;
      if (Object.keys(data).length > 0) await tx.interface.update({ where: { id: dbIface.id }, data });
      if (dbIface.name !== nic.name) renames.push({ id: dbIface.id, name: nic.name }); // live name wins
      // IPs key off interfaceId, not name, so reconcile matched NICs inline (before teardown): a card
      // swap that moves an IP onto a matched NIC then guards the absent NIC's IP retirement below.
      await this.reconcileIps(tx, {
        interfaceId: dbIface.id,
        deviceId,
        organizationId,
        existingIps: dbIface.ipAddresses,
        ips: nic.ips,
      });
    }

    // A partially-forged hash must not tear down or rename real inventory; a rename onto a
    // name a not-yet-torn-down NIC still holds would also wedge reconcile in a retry loop.
    if (safeNics.length === liveNics.length) {
      // Teardown first: soft-delete evicts each departing name from the partial-unique index,
      // freeing it for a survivor's rename or a new NIC.
      for (const dbIface of dbIfaces) {
        if (matched.has(dbIface.id)) continue;
        await tx.interface.update({ where: { id: dbIface.id }, data: { enabled: false, deletedAt: new Date() } });
        for (const ip of dbIface.ipAddresses) {
          await tx.ipAddress.updateMany({
            where: { id: ip.id, interfaceId: dbIface.id, deletedAt: null },
            data: { deletedAt: new Date() },
          });
        }
      }
      // Phase 1: park each renamed survivor on a temp name, freeing its OLD name.
      for (const r of renames) await tx.interface.update({ where: { id: r.id }, data: { name: `__tmp__${r.id}` } });
      // Creates are now safe: every conflicting name (departing + vacated-by-rename) has been freed.
      for (const nic of toCreate) await this.createLiveNic(tx, deviceId, organizationId, nic);
      // Phase 2: survivors take their final live names.
      for (const r of renames) await tx.interface.update({ where: { id: r.id }, data: { name: r.name } });
    } else {
      // Unsafe tick: teardown + renames are skipped, so only create NICs whose name isn't already held
      // by a current DB interface — a colliding create waits for a clean tick rather than aborting the tx.
      const held = new Set(dbIfaces.map((i) => i.name));
      for (const nic of toCreate) {
        if (held.has(nic.name)) continue;
        await this.createLiveNic(tx, deviceId, organizationId, nic);
      }
    }

    return true;
  }

  private async createLiveNic(
    tx: Prisma.TransactionClient,
    deviceId: string,
    organizationId: string,
    nic: LiveNic,
  ): Promise<void> {
    const created = await tx.interface.create({
      data: {
        deviceId,
        name: nic.name,
        macAddress: nic.mac,
        enabled: true,
        markConnected: true,
        type: nic.mac ? null : InterfaceType.VIRTUAL,
      },
      select: { id: true },
    });
    await this.reconcileIps(tx, { interfaceId: created.id, deviceId, organizationId, existingIps: [], ips: nic.ips });
  }

  // DB rows may hold hyphen/uppercase MACs (the API's normalizeMac only trims) — canonicalize
  // the DB side before comparing or a hyphen-MAC row is missed and duplicated.
  private matchInterface(dbIfaces: DbInterface[], nic: LiveNic, matched: Set<string>): DbInterface | null {
    if (nic.mac) {
      const byMac = dbIfaces.find((i) => !matched.has(i.id) && normalizeDbMac(i.macAddress) === nic.mac);
      if (byMac) return byMac;
    }
    return dbIfaces.find((i) => !matched.has(i.id) && i.name === nic.name) ?? null;
  }

  private async reconcileIps(
    tx: Prisma.TransactionClient,
    params: {
      interfaceId: string;
      deviceId: string;
      organizationId: string;
      existingIps: Array<{ id: string; address: string }>;
      ips: LiveIp[];
    },
  ): Promise<void> {
    const { interfaceId, deviceId, organizationId, existingIps, ips } = params;
    // Host portion of each CIDR ("10.0.0.1/24" -> "10.0.0.1"); the mask isn't part of the identity.
    const liveHosts = new Set(ips.map((ip) => ip.address.split('/')[0]));

    for (const ip of ips) {
      const outcome = await ensureIpAddress(tx, { address: ip.address, interfaceId, deviceId, organizationId });
      // `invalid`/`assigned-elsewhere` mean the live IP couldn't be reflected —
      // log it rather than let Redis and the DB silently diverge.
      if (outcome === 'invalid' || outcome === 'assigned-elsewhere') {
        this.logger.warn(`Skipped IP ${ip.address} on interface ${interfaceId} (${outcome})`);
      }
    }

    for (const ip of existingIps) {
      if (!liveHosts.has(ip.address.split('/')[0])) {
        // interfaceId guard: skip if an earlier ensureIpAddress moved this IP to
        // another NIC in this same pass (snapshot still lists it here).
        await tx.ipAddress.updateMany({
          where: { id: ip.id, interfaceId, deletedAt: null },
          data: { deletedAt: new Date() },
        });
      }
    }
  }

  // A containing live prefix wins — inserting anyway would let a roleless connected /24 shadow
  // a roled supernet; the advisory lock (IPAM org-prefix scope) closes the NOT-EXISTS TOCTOU.
  private async ensurePrefixes(
    tx: Prisma.TransactionClient,
    zoneId: string,
    organizationId: string,
    liveNics: LiveNic[],
  ): Promise<void> {
    const subnets = new Set<string>();
    for (const nic of liveNics) {
      for (const ip of nic.ips) {
        if (ip.subnet && isNetworkSubnet(ip.subnet)) subnets.add(ip.subnet);
      }
    }
    if (subnets.size === 0) return;

    await tx.$executeRaw(
      Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${`ipam:prefix:${organizationId}:default`}))`,
    );

    for (const subnet of subnets) {
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO "Prefix" (id, prefix, status, "isPool", "enableVlanTag", "organizationId", "zoneId", "createdAt", "updatedAt")
        SELECT gen_random_uuid(), ${subnet}::cidr, 'ACTIVE'::"PrefixStatus", false, false, ${organizationId}, ${zoneId}, now(), now()
        WHERE NOT EXISTS (
          SELECT 1 FROM "Prefix"
          WHERE "zoneId" = ${zoneId}
            AND "deletedAt" IS NULL
            AND family(prefix) = family(${subnet}::cidr)
            AND prefix >>= ${subnet}::cidr
        )
        AND NOT EXISTS (
          SELECT 1 FROM "Prefix"
          WHERE "organizationId" = ${organizationId}
            AND "deletedAt" IS NULL
            AND "vrfId" IS NULL
            AND prefix = ${subnet}::cidr
        )
      `);
    }
  }

  private async ensureGateways(
    tx: Prisma.TransactionClient,
    zoneId: string,
    organizationId: string,
    gateways: LiveGateway[],
  ): Promise<void> {
    if (gateways.length === 0) return;

    for (const gw of gateways) {
      // Exact-CIDR match only: a bridge's default gateway is valid for its connected L2
      // domain, nothing broader — binding it to a containing supernet would hand sibling
      // child subnets a router they cannot reach.
      const prefixRows = await tx.$queryRaw<Array<{ id: string; gatewayIpId: string | null; vrfId: string | null }>>(
        Prisma.sql`
          SELECT id, "gatewayIpId", "vrfId" FROM "Prefix"
          WHERE "zoneId" = ${zoneId} AND "deletedAt" IS NULL AND prefix = ${gw.subnet}::cidr
          ORDER BY "vrfId" ASC NULLS FIRST, id ASC
          LIMIT 1
        `,
      );
      let prefix = prefixRows[0];
      if (!prefix) {
        // ensurePrefixes creates the exact prefix when nothing covers it, so a miss here means
        // only a covering supernet exists. Materialize the exact child (inheriting the
        // supernet's VRF) so the gateway binds to its own L2 scope — never to the supernet,
        // where sibling child subnets would inherit an unreachable router.
        const supernetRows = await tx.$queryRaw<Array<{ id: string; vrfId: string | null }>>(
          Prisma.sql`
            SELECT id, "vrfId" FROM "Prefix"
            WHERE "zoneId" = ${zoneId} AND "deletedAt" IS NULL AND prefix >>= ${gw.subnet}::cidr
            ORDER BY masklen(prefix) DESC, "vrfId" ASC NULLS FIRST, id ASC
            LIMIT 1
          `,
        );
        const supernet = supernetRows[0];
        if (!supernet) continue;
        await tx.$executeRaw(
          Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${`ipam:prefix:${organizationId}:default`}))`,
        );
        // Inherit the supernet's L2/metadata (vlan, tagging, prefix role, parent) so the child
        // never shadows operator configuration; the NOT-EXISTS mirrors Prefix_active_unique
        // (org + vrf + prefix) so a same-CIDR prefix elsewhere in the org cannot abort the sync.
        await tx.$executeRaw(Prisma.sql`
          INSERT INTO "Prefix" (id, prefix, status, "isPool", "enableVlanTag", "organizationId", "zoneId", "vrfId", "vlanId", "prefixRoleId", "parentId", "createdAt", "updatedAt")
          SELECT gen_random_uuid(), ${gw.subnet}::cidr, 'ACTIVE'::"PrefixStatus", false, s."enableVlanTag", ${organizationId}, ${zoneId}, s."vrfId", s."vlanId", s."prefixRoleId", s.id, now(), now()
          FROM "Prefix" s
          WHERE s.id = ${supernet.id}
            AND NOT EXISTS (
              SELECT 1 FROM "Prefix"
              WHERE "organizationId" = ${organizationId}
                AND "deletedAt" IS NULL
                AND "vrfId" IS NOT DISTINCT FROM s."vrfId"
                AND prefix = ${gw.subnet}::cidr
            )
        `);
        const createdRows = await tx.$queryRaw<Array<{ id: string; gatewayIpId: string | null; vrfId: string | null }>>(
          Prisma.sql`
            SELECT id, "gatewayIpId", "vrfId" FROM "Prefix"
            WHERE "zoneId" = ${zoneId} AND "deletedAt" IS NULL AND prefix = ${gw.subnet}::cidr
            ORDER BY "vrfId" ASC NULLS FIRST, id ASC
            LIMIT 1
          `,
        );
        prefix = createdRows[0];
        if (!prefix) {
          this.logger.log(
            `Gateway ${gw.gatewayIp} for ${gw.subnet}: exact prefix exists outside zone ${zoneId} ` +
              `(org/vrf unique) — not binding a zone-scoped gateway across zones`,
          );
          continue;
        }
      }
      if (prefix.gatewayIpId) continue;
      // Any existing Gateway row — operator-created or a prior derivation — parks the prefix:
      // auto-derivation is bootstrap-only, so a cleared gatewayIpId is never re-imposed and
      // operator Gateway rows (which don't set gatewayIpId) are never contested.
      const existingRows = await tx.gateway.findFirst({ where: { prefixId: prefix.id }, select: { id: true } });
      if (existingRows) continue;

      // Lock scope matches IpAddress dedup scope (org + VRF), not prefix — two prefixes
      // sharing a VRF must not race on the same gateway IP.
      const vrfKey = prefix.vrfId ?? 'null';
      await tx.$executeRaw(
        Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${`ipam:gateway:${organizationId}:${vrfKey}`}))`,
      );

      // Re-check under lock: an operator may have set gatewayIpId between the initial
      // SELECT and the lock acquisition.
      const freshPrefix = await tx.$queryRaw<Array<{ gatewayIpId: string | null }>>(
        Prisma.sql`SELECT "gatewayIpId" FROM "Prefix" WHERE id = ${prefix.id} FOR UPDATE`,
      );
      if (freshPrefix[0]?.gatewayIpId) {
        this.logger.log(`Prefix ${prefix.id} already has an operator-set gateway — skipping auto-derived gateway`);
        continue;
      }
      const gwUnderLock = await tx.gateway.findFirst({ where: { prefixId: prefix.id }, select: { id: true } });
      if (gwUnderLock) {
        this.logger.log(`Prefix ${prefix.id} gained a gateway row concurrently — skipping auto-derived gateway`);
        continue;
      }

      // Atomic upsert: INSERT ... ON CONFLICT DO NOTHING eliminates the SELECT-then-INSERT
      // race between concurrent reconcilers in the same org/VRF.
      const ipRows = await tx.$queryRaw<Array<{ id: string }>>(
        Prisma.sql`
          INSERT INTO "IpAddress" (id, address, status, "organizationId", "vrfId", "createdAt", "updatedAt")
          SELECT gen_random_uuid(), ${gw.gatewayIp}::inet, 'ACTIVE'::"IpStatus", ${organizationId}, ${prefix.vrfId}, now(), now()
          WHERE NOT EXISTS (
            SELECT 1 FROM "IpAddress"
            WHERE "organizationId" = ${organizationId}
              AND "deletedAt" IS NULL
              AND "vrfId" IS NOT DISTINCT FROM ${prefix.vrfId}
              AND host(address) = host(${gw.gatewayIp}::inet)
          )
          RETURNING id
        `,
      );
      let gatewayIpId: string;
      if (ipRows[0]) {
        gatewayIpId = ipRows[0].id;
      } else {
        const existing = await tx.$queryRaw<Array<{ id: string }>>(
          Prisma.sql`
            SELECT id FROM "IpAddress"
            WHERE "organizationId" = ${organizationId}
              AND "deletedAt" IS NULL
              AND "vrfId" IS NOT DISTINCT FROM ${prefix.vrfId}
              AND host(address) = host(${gw.gatewayIp}::inet)
            LIMIT 1
          `,
        );
        if (!existing[0]) continue;
        gatewayIpId = existing[0].id;
      }

      await tx.gateway.create({
        data: { prefixId: prefix.id, gatewayIpId, vrfId: prefix.vrfId, routingPriority: 100 },
      });

      const { count } = await tx.prefix.updateMany({
        where: { id: prefix.id, gatewayIpId: null },
        data: { gatewayIpId },
      });
      if (count === 0) {
        this.logger.log(`Prefix ${prefix.id} gateway was set concurrently — auto-derived ${gatewayIpId} not applied`);
      }
    }
  }
}
