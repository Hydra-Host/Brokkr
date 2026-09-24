import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import {
  AllocateNextPrefixRequest,
  DetectPrefixOverlapRequest,
  type DhcpMode,
  DhcpOptionSchema,
  IpAddress,
  IpamPrefix,
  type IpxeBuildTarget,
  PrefixDhcpConfig,
  PrefixDnsOverride,
  PrefixListQuery,
  PrefixUtilization,
  UpdatePrefixDhcpConfig,
  ValidatePrefixGatewayRequest,
  ValidatePrefixGatewayResult,
} from '@repo/api-client';
import { Prisma } from '@repo/database';
import {
  type BootIdentity,
  type BootPrefixSelection,
  DHCP_CONFIG_COLUMNS,
  type DhcpConfigRow,
  findBootPrefixForDevice,
  readDhcpConfig,
  readProxyAllowlist,
  resolveBootIdentity,
  toDhcpConfig,
} from '@repo/device-domain';
import { intToIpv4 } from '@repo/utils';
import { ContextService } from 'src/common/context/context.service';
import { PrismaClient } from 'src/prisma/prisma.client';
import { z } from 'zod';
import { getBridgesInZoneFromPrisma } from '../../zones/bridge-zone-adapter';
import { zoneAclLockKey } from '../../zones/zone-redis-acl.util';
import { BaseIpamRepository, type IpamQueryExecutor } from '../shared/base-ipam.repository';
import { IpAddressRow, PrefixOverlapRow, PrefixRow, PrefixUtilizationRow } from '../shared/ipam.types';
import { PrefixEntity } from './prefix.entity';

// Must match the default the bridge-presence reconciler's ensureGateways writes: it is the only
// ownership signal — a Gateway row at this priority is auto-managed, any other value is operator-set.
const AUTO_MANAGED_ROUTING_PRIORITY = 100;

export interface GatewaySyncResult {
  action: 'created' | 'updated' | 'removed' | 'noop';
  customRowPreserved: boolean;
}

export type DhcpAutoEnableOutcome = 'enabled' | 'already-configured' | 'ineligible' | 'not-found';

// Never throws: the audit must not fail an update that already committed, so malformed stored dhcpOptions is captured raw.
function toDhcpConfigForAudit(row: DhcpConfigRow): Record<string, unknown> {
  const rawOptions = Array.isArray(row.dhcpOptions) ? row.dhcpOptions : [];
  const parsed = z.array(DhcpOptionSchema).safeParse(rawOptions);
  return {
    ...row,
    dhcpOptions: parsed.success ? parsed.data : rawOptions,
    dhcpProxyAllowedMacs: row.dhcpProxyAllowedMacs ?? [],
  };
}

@Injectable()
export class PrefixRepository extends BaseIpamRepository {
  constructor(prisma: PrismaClient, contextService: ContextService) {
    super(prisma, contextService);
  }

  async listPrefixes(query: PrefixListQuery): Promise<IpamPrefix[]> {
    const clauses: Prisma.Sql[] = [Prisma.sql`p."organizationId" = ${this.contextService.organizationId}`];
    if (!query.includeArchived) {
      clauses.push(Prisma.sql`p."deletedAt" IS NULL`);
    }
    if (query.vrfId) {
      clauses.push(Prisma.sql`p."vrfId" = ${query.vrfId}`);
    }
    if (query.status) {
      clauses.push(Prisma.sql`p.status = ${query.status}::"PrefixStatus"`);
    }
    if (query.parentId) {
      clauses.push(Prisma.sql`p."parentId" = ${query.parentId}`);
    }
    if (query.vlanId) {
      clauses.push(Prisma.sql`p."vlanId" = ${query.vlanId}`);
    }
    if (query.search) {
      clauses.push(Prisma.sql`p.prefix::text ILIKE ${`%${query.search}%`}`);
    }

    const rows = await this.queryRaw<PrefixRow[]>`
      SELECT
        p.id,
        p.prefix::text AS prefix,
        p.status,
        p."isPool",
        p.role,
        p."zoneId",
        p."organizationId",
        p."vrfId",
        p."parentId",
        p."vlanId",
        p."gatewayIpId",
        p."vrrpVipId",
        p."prefixRoleId",
        p."enableVlanTag",
        p."bondParameters",
        p."createdAt",
        p."updatedAt",
        p."deletedAt"
      FROM "Prefix" p
      WHERE ${Prisma.join(clauses, ' AND ')}
      ORDER BY p.prefix::text ASC
    `;
    return rows.map((row) => this.toPrefix(row));
  }

  async normalizePrefix(input: string): Promise<string> {
    const normalized = await this.normalizeCidr(input);
    if (normalized.endsWith('/0')) {
      throw new BadRequestException('Prefix cannot have a /0 mask');
    }
    return normalized;
  }

  async restore(id: string): Promise<IpamPrefix> {
    return this.requirePrefix(id);
  }

  async ensureVrf(entity: PrefixEntity): Promise<void> {
    if (!entity.shouldValidateVrf) {
      return;
    }

    await this.requireVrf(entity.state.vrfId);
  }

  async ensurePrefixRole(entity: PrefixEntity): Promise<void> {
    const roleId = entity.state.prefixRoleId;
    // roleId === null is redundant with shouldValidatePrefixRole (which already requires non-null) but
    // narrows the type for requirePrefixRole without a non-null assertion.
    if (!entity.shouldValidatePrefixRole || roleId === null) {
      return;
    }
    await this.requirePrefixRole(roleId);
  }

  async ensureParent(
    entity: PrefixEntity,
    currentId: string | null,
    executor: IpamQueryExecutor = this,
  ): Promise<void> {
    if (!entity.shouldValidateParent) {
      return;
    }

    await this.validatePrefixParent(
      entity.state.parentId,
      entity.state.prefix,
      entity.state.vrfId,
      entity.state.organizationId,
      currentId ?? undefined,
      executor,
    );
  }

  async ensureVlanCompatibility(entity: PrefixEntity, executor: IpamQueryExecutor = this): Promise<void> {
    if (!entity.shouldValidateVlanCompatibility) {
      return;
    }

    await this.validatePrefixVlanCompatibility(
      entity.state.vrfId,
      entity.state.vlanId,
      entity.state.organizationId,
      executor,
    );
  }

  async ensureGateway(entity: PrefixEntity, prefixId: string, executor: IpamQueryExecutor = this): Promise<void> {
    if (!entity.shouldValidateGateway) {
      return;
    }

    await this.validatePrefixGateway({
      prefixId,
      gatewayIpId: entity.state.gatewayIpId,
      candidatePrefix: entity.state.prefix,
      candidateVrfId: entity.state.vrfId,
      executor,
    });
  }

  async ensureVrrpVip(entity: PrefixEntity, prefixId: string, executor: IpamQueryExecutor = this): Promise<void> {
    // Invariants (VIP-bearing prefix must be PRIMARY-role; VIP's IP must share the prefix's VRF) can only break on a VIP (re)assign, role change, or VRF move — gate on those three.
    const vrfMoving = entity.changes.vrfId;
    const vipAssigned = entity.changes.vrrpVipId;
    const roleChanging = entity.changes.role;
    if (!vrfMoving && !vipAssigned && !roleChanging) {
      return;
    }

    // Global lock order scope→prefix→ip; serializes against a VRF-changing updatePrefix that locks a different scope key. Re-entrant with the guard's own lockIpamPrefix.
    await this.lockIpamPrefix(executor, entity.state.organizationId, prefixId);

    // Re-read the VIP under the lock when not assigned here — gating on the stale snapshot would skip validation after a concurrent VIP-assign.
    const effectiveVrrpVipId = vipAssigned
      ? entity.state.vrrpVipId
      : await this.readPrefixVrrpVipId(prefixId, executor);
    if (effectiveVrrpVipId === null) {
      return;
    }

    const committed = await this.readPrefixVrfAndRole(prefixId, executor);

    const effectiveRole = roleChanging ? entity.state.role : committed.role;
    if (effectiveRole !== 'PRIMARY') {
      throw new BadRequestException(
        `VRRP VIP requires a PRIMARY-role prefix (prefix role: ${effectiveRole ?? 'none'})`,
      );
    }

    await this.lockIpamIp(executor, entity.state.organizationId, effectiveVrrpVipId);

    // Validate against the post-save VRF so committed state can never have ip.vrfId !== prefix.vrfId.
    const candidateVrfId = vrfMoving ? entity.state.vrfId : committed.vrfId;

    await this.validatePrefixVrrpVip({
      prefixId,
      vrrpVipId: effectiveVrrpVipId,
      candidatePrefix: entity.state.prefix,
      candidateVrfId,
      executor,
    });
  }

  async ensureZone(entity: PrefixEntity, executor: IpamQueryExecutor = this): Promise<void> {
    if (!((entity.isNew || entity.changes.zoneId) && entity.state.zoneId !== null)) {
      return;
    }
    await this.requireLiveZone(entity.state.zoneId, executor);
  }

  // The VIP-set path must re-check even when zoneId is unchanged: zone tombstones don't null Prefix.zoneId, and ensureZone is skipped when zoneId isn't changing.
  async requireLiveZone(zoneId: string, executor: IpamQueryExecutor = this): Promise<void> {
    const rows = await executor.queryRaw<Array<{ id: string }>>`
      SELECT z.id
      FROM "Zone" z
      WHERE z.id = ${zoneId}
        AND z."organizationId" = ${this.contextService.organizationId}
        AND z."deletedAt" IS NULL
      LIMIT 1
    `;
    if (rows.length === 0) {
      throw new NotFoundException('Zone not found');
    }
  }

  async composeVrrpVip(
    prefixId: string,
  ): Promise<{ vip: string; ifaceByBridge: Record<string, string>; garpCount: number } | null> {
    // INNER JOINs: no live-bridge binding → null (mirrors listAllVrrpVipBearingPrefixes); the Device join filters soft-deleted bridges so a deprovisioned bridge's iface is never published.
    const rows = await this.queryRaw<Array<{ vip: string; ifaceByBridge: Record<string, string>; garpCount: number }>>`
      SELECT
        (host(ip.address) || '/' || masklen(p.prefix)::text) AS vip,
        jsonb_object_agg(d.name, b.iface) AS "ifaceByBridge",
        z."vrrpGarpCount" AS "garpCount"
      FROM "Prefix" p
      JOIN "IpAddress" ip ON ip.id = p."vrrpVipId"
      JOIN "Zone" z ON z.id = p."zoneId"
      JOIN "PrefixVrrpBinding" b ON b."prefixId" = p.id
      JOIN "Device" d ON d.id = b."bridgeId" AND d."deletedAt" IS NULL
      WHERE p.id = ${prefixId}
        AND p."organizationId" = ${this.contextService.organizationId}
        AND p."deletedAt" IS NULL
        AND ip."deletedAt" IS NULL
      GROUP BY ip.address, p.prefix, z."vrrpGarpCount"
      LIMIT 1
    `;
    return rows[0] ?? null;
  }

  async loadDhcpServingAddresses(prefix: {
    vrrpVipId: string | null;
    zoneId: string | null;
    vrfId: string | null;
    cidr: string;
  }): Promise<{ vipAddress: string | null; bridgeIps: string[] }> {
    // Path 1: VRRP VIP takes precedence as the single serving address — but only when it resolves to a
    // live IPv4 row; a stale/missing/non-IPv4 vrrpVipId falls through to the bridge-NIC query below.
    if (prefix.vrrpVipId) {
      const rows = await this.queryRaw<Array<{ ip: string }>>`
        SELECT host(ip.address) AS ip
        FROM "IpAddress" ip
        WHERE ip.id = ${prefix.vrrpVipId}
          AND ip."organizationId" = ${this.contextService.organizationId}
          AND ip."deletedAt" IS NULL
          AND family(ip.address) = 4
        LIMIT 1
      `;
      const vipAddress = rows[0]?.ip ?? null;
      if (vipAddress) return { vipAddress, bridgeIps: [] };
    }

    // Path 2: no usable VIP — find bridge NIC IPs within this prefix, matching the reservation
    // derivation's IPAM scope (org + VRF + ACTIVE) so out-of-scope IPs never leak into next-server/DNS.
    if (!prefix.zoneId) return { vipAddress: null, bridgeIps: [] };

    const rows = await this.queryRaw<Array<{ ip: string }>>`
      SELECT host(ip.address) AS ip
      FROM "IpAddress" ip
      JOIN "Interface" iface
        ON iface.id = ip."interfaceId"
        AND iface."deletedAt" IS NULL
      JOIN "Device" dev
        ON dev.id = iface."deviceId"
        AND dev."deletedAt" IS NULL
        AND dev.role = 'Bridge'
        AND dev."supplierId" = ${this.contextService.organizationId}
        AND dev."zoneId" = ${prefix.zoneId}
      WHERE ip.address <<= ${prefix.cidr}::cidr
        AND ip."organizationId" = ${this.contextService.organizationId}
        AND ip."vrfId" IS NOT DISTINCT FROM ${prefix.vrfId}
        AND ip.status = 'ACTIVE'
        AND ip."deletedAt" IS NULL
        AND family(ip.address) = 4
      ORDER BY ip.address
    `;
    return { vipAddress: null, bridgeIps: rows.map((r) => r.ip) };
  }

  // Excludes soft-deleted bridge Devices (matching composeVrrpVip) so a stale binding doesn't prefill a row that assertBridgesInZone would 400 on save.
  async listPrefixVrrpBindings(prefixId: string): Promise<Array<{ bridgeId: string; iface: string }>> {
    return this.queryRaw<Array<{ bridgeId: string; iface: string }>>`
      SELECT b."bridgeId", b.iface
      FROM "PrefixVrrpBinding" b
      JOIN "Prefix" p ON p.id = b."prefixId"
      JOIN "Device" d ON d.id = b."bridgeId" AND d."deletedAt" IS NULL
      WHERE b."prefixId" = ${prefixId}
        AND p."organizationId" = ${this.contextService.organizationId}
    `;
  }

  // Atom map keys must be live bridges serving this zone — a cross-zone id would publish an iface no bridge reads; the zone is already org-validated by requireLiveZone.
  async assertBridgesInZone(zoneId: string, bridgeIds: string[]): Promise<void> {
    if (bridgeIds.length === 0) return;
    const zoneBridges = await getBridgesInZoneFromPrisma(this.prisma, zoneId);
    const valid = new Set(zoneBridges.map((bridge) => bridge.id));
    const invalid = bridgeIds.filter((id) => !valid.has(id));
    if (invalid.length > 0) {
      throw new BadRequestException('One or more VRRP bindings reference a bridge not in this prefix’s zone');
    }
  }

  async replacePrefixVrrpBindings(
    prefixId: string,
    bindings: Array<{ bridgeId: string; iface: string }>,
    executor: IpamQueryExecutor,
  ): Promise<void> {
    await executor.executeRaw`DELETE FROM "PrefixVrrpBinding" WHERE "prefixId" = ${prefixId}`;
    for (const binding of bindings) {
      await executor.executeRaw`
        INSERT INTO "PrefixVrrpBinding" (id, "prefixId", "bridgeId", iface, "createdAt", "updatedAt")
        VALUES (gen_random_uuid(), ${prefixId}, ${binding.bridgeId}, ${binding.iface}, now(), now())
      `;
    }
  }

  async listVrrpVipBearingPrefixIdsInZone(zoneId: string): Promise<string[]> {
    const rows = await this.queryRaw<Array<{ id: string }>>`
      SELECT p.id
      FROM "Prefix" p
      WHERE p."zoneId" = ${zoneId}
        AND p."organizationId" = ${this.contextService.organizationId}
        AND p."vrrpVipId" IS NOT NULL
        AND p."deletedAt" IS NULL
    `;
    return rows.map((row) => row.id);
  }

  async listAllVrrpVipBearingPrefixes(): Promise<
    Array<{ prefixId: string; zoneId: string; vip: string; ifaceByBridge: Record<string, string>; garpCount: number }>
  > {
    return this.prisma.$queryRaw<
      Array<{
        prefixId: string;
        zoneId: string;
        vip: string;
        ifaceByBridge: Record<string, string>;
        garpCount: number;
      }>
    >`
      SELECT
        p.id AS "prefixId",
        p."zoneId",
        (host(ip.address) || '/' || masklen(p.prefix)::text) AS vip,
        jsonb_object_agg(d.name, b.iface) AS "ifaceByBridge",
        z."vrrpGarpCount" AS "garpCount"
      FROM "Prefix" p
      JOIN "IpAddress" ip ON ip.id = p."vrrpVipId"
      JOIN "Zone" z ON z.id = p."zoneId"
      JOIN "PrefixVrrpBinding" b ON b."prefixId" = p.id
      JOIN "Device" d ON d.id = b."bridgeId" AND d."deletedAt" IS NULL
      WHERE p."vrrpVipId" IS NOT NULL
        AND p."zoneId" IS NOT NULL
        AND p."deletedAt" IS NULL
        AND ip."deletedAt" IS NULL
        -- Exclude prefixes pointing at a soft-deleted zone: a VIP set racing a
        -- zone delete (zones are tombstoned, so ON DELETE SET NULL never fires and
        -- prefix.zoneId still points at the dead zone) must NOT be republished —
        -- dropping it from the desired set makes the reconcile sweep clear the
        -- orphaned atom instead of advertising a VIP for a gone data center.
        AND z."deletedAt" IS NULL
      GROUP BY p.id, p."zoneId", ip.address, p.prefix, z."vrrpGarpCount"
    `;
  }

  async getDhcpConfig(prefixId: string): Promise<PrefixDhcpConfig> {
    const config = await readDhcpConfig(this.prisma, { prefixId, organizationId: this.contextService.organizationId });
    if (!config) {
      throw new NotFoundException('Prefix not found');
    }
    return config;
  }

  async getProxyAllowlist(prefixId: string): Promise<string[]> {
    return readProxyAllowlist(this.prisma, { prefixId, organizationId: this.contextService.organizationId });
  }

  async getAssociatedPrefixId(prefixId: string): Promise<string | null> {
    const rows = await this.queryRaw<Array<{ associatedPrefixId: string | null }>>`
      SELECT p."associatedPrefixId"
      FROM "Prefix" p
      WHERE p.id = ${prefixId}
        AND p."organizationId" = ${this.contextService.organizationId}
        AND p."deletedAt" IS NULL
      LIMIT 1
    `;
    if (rows.length === 0) {
      throw new NotFoundException('Prefix not found');
    }
    return rows[0].associatedPrefixId;
  }

  async resolveBootIdentity(mac: string, bmcAddress: string): Promise<BootIdentity> {
    return resolveBootIdentity(this.prisma, { mac, bmcAddress, organizationId: this.contextService.organizationId });
  }

  async findBootPrefixForDevice(deviceId: string, zoneId: string): Promise<BootPrefixSelection | null> {
    return findBootPrefixForDevice(this.prisma, {
      deviceId,
      zoneId,
      organizationId: this.contextService.organizationId,
    });
  }

  async updateDhcpConfig(
    prefixId: string,
    input: UpdatePrefixDhcpConfig,
    executor?: IpamQueryExecutor,
  ): Promise<PrefixDhcpConfig> {
    // Standalone: the UPDATE and writeAudit must share a tx so an audit failure rolls back the
    // mode write — else the DB shows DHCP-off while the bridge keeps serving the stale enabled atom.
    if (!executor) {
      return this.transaction((tx) => this.updateDhcpConfigInner(prefixId, input, tx));
    }
    return this.updateDhcpConfigInner(prefixId, input, executor);
  }

  private async updateDhcpConfigInner(
    prefixId: string,
    input: UpdatePrefixDhcpConfig,
    executor: IpamQueryExecutor,
  ): Promise<PrefixDhcpConfig> {
    const optionsJson = input.dhcpOptions.length > 0 ? JSON.stringify(input.dhcpOptions) : null;
    // Snapshot + UPDATE in one statement via CTE so they see the same row version (atomic).
    let rows: Array<
      DhcpConfigRow & {
        before_dhcpMode: DhcpMode | null;
        before_dhcpLeaseTtlSeconds: number | null;
        before_ipxeBuildTarget: IpxeBuildTarget | null;
        before_dhcpOptions: unknown;
        before_dhcpProxyAllowedMacs: string[];
        before_dhcpProxyPeerAuthoritative: boolean;
        before_dhcpRelayAgentIp: string | null;
      }
    >;
    try {
      rows = await executor.queryRaw`
        WITH before AS (
          SELECT ${DHCP_CONFIG_COLUMNS}
          FROM "Prefix" p
          WHERE p.id = ${prefixId}
            AND p."organizationId" = ${this.contextService.organizationId}
            AND p."deletedAt" IS NULL
          LIMIT 1
          FOR UPDATE
        ),
        updated AS (
          UPDATE "Prefix" p
          SET
            "dhcpMode" = ${input.dhcpMode}::"DhcpMode",
            "dhcpLeaseTtlSeconds" = ${input.dhcpLeaseTtlSeconds},
            "ipxeBuildTarget" = ${input.ipxeBuildTarget}::"IpxeBuildTarget",
            "dhcpOptions" = ${optionsJson}::jsonb,
            "dhcpProxyAllowedMacs" = ${input.dhcpProxyAllowedMacs}::text[],
            "dhcpProxyPeerAuthoritative" = ${input.dhcpProxyPeerAuthoritative},
            "dhcpRelayAgentIp" = ${input.dhcpRelayAgentIp}::inet,
            "updatedAt" = now()
          FROM before
          WHERE p.id = ${prefixId}
            AND p."organizationId" = ${this.contextService.organizationId}
            AND p."deletedAt" IS NULL
          RETURNING
            ${DHCP_CONFIG_COLUMNS},
            before."dhcpMode" AS "before_dhcpMode",
            before."dhcpLeaseTtlSeconds" AS "before_dhcpLeaseTtlSeconds",
            before."ipxeBuildTarget" AS "before_ipxeBuildTarget",
            before."dhcpOptions" AS "before_dhcpOptions",
            before."dhcpProxyAllowedMacs" AS "before_dhcpProxyAllowedMacs",
            before."dhcpProxyPeerAuthoritative" AS "before_dhcpProxyPeerAuthoritative",
            before."dhcpRelayAgentIp" AS "before_dhcpRelayAgentIp"
        )
        SELECT * FROM updated
      `;
    } catch (error) {
      // Concurrent writes can trip a CHECK (23514) or the relay unique index (23505) → 4xx, not 500.
      // Only the raw message carries the constraint name, so dispatch on it.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2010') {
        const sqlState = error.meta?.['code'];
        const message = typeof error.meta?.['message'] === 'string' ? error.meta['message'] : '';
        if (sqlState === '23514') {
          if (message.includes('Prefix_active_relay_requires_agent_ip_check')) {
            throw new BadRequestException(
              'This prefix became a relayed prefix (an associated prefix was set) while DHCP was being enabled. An active relayed prefix requires a DHCP relay agent IP — set one or disable DHCP, then retry.',
            );
          }
          if (message.includes('Prefix_dhcpRelayAgentIp')) {
            throw new BadRequestException('The DHCP relay agent IP must be a routable unicast IPv4 address.');
          }
          throw new BadRequestException(
            'This prefix became DHCP-ineligible (its zone was removed or its role changed) while DHCP was being enabled. Reload the prefix, re-check its zone and role, then retry.',
          );
        }
        if (sqlState === '23505' && message.includes('Prefix_zone_dhcpRelayAgentIp_enabled_key')) {
          throw new ConflictException(
            `Another DHCP-enabled prefix in this zone already uses relay agent IP ${input.dhcpRelayAgentIp}. Relay agent IPs must be unique per zone.`,
          );
        }
      }
      throw error;
    }
    if (rows.length === 0) {
      throw new NotFoundException('Prefix not found');
    }

    const row = rows[0];
    const beforeRow: DhcpConfigRow = {
      dhcpMode: row.before_dhcpMode,
      dhcpLeaseTtlSeconds: row.before_dhcpLeaseTtlSeconds,
      ipxeBuildTarget: row.before_ipxeBuildTarget,
      dhcpOptions: row.before_dhcpOptions,
      dhcpProxyAllowedMacs: row.before_dhcpProxyAllowedMacs,
      dhcpProxyPeerAuthoritative: row.before_dhcpProxyPeerAuthoritative,
      dhcpRelayAgentIp: row.before_dhcpRelayAgentIp,
    };
    const afterRow: DhcpConfigRow = {
      dhcpMode: row.dhcpMode,
      dhcpLeaseTtlSeconds: row.dhcpLeaseTtlSeconds,
      ipxeBuildTarget: row.ipxeBuildTarget,
      dhcpOptions: row.dhcpOptions,
      dhcpProxyAllowedMacs: row.dhcpProxyAllowedMacs,
      dhcpProxyPeerAuthoritative: row.dhcpProxyPeerAuthoritative,
      dhcpRelayAgentIp: row.dhcpRelayAgentIp,
    };

    await this.writeAudit(
      'Prefix',
      prefixId,
      this.toJsonObject(toDhcpConfigForAudit(beforeRow)),
      this.toJsonObject(toDhcpConfigForAudit(afterRow)),
      executor,
    );

    return toDhcpConfig(afterRow);
  }

  // Takes deleteZone's per-zone advisory lock, closing the TOCTOU window where an enable could
  // commit between deleteZone's in-tx DHCP count (sees 0) and its soft-delete.
  async updateDhcpConfigUnderZoneLock(
    prefixId: string,
    zoneId: string,
    input: UpdatePrefixDhcpConfig,
  ): Promise<PrefixDhcpConfig> {
    return this.transaction(async (tx) => {
      const lockKey = zoneAclLockKey(zoneId);
      await tx.executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
      // If deleteZone won the lock and committed its tombstone, reject the enable.
      await this.requireLiveZone(zoneId, tx);
      return this.updateDhcpConfig(prefixId, input, tx);
    });
  }

  // Auto-enable: UNSET dhcpMode → AUTHORITATIVE only. NULL guard is never-override;
  // concurrent operator write wins. Zone lock + CHECKs fail-close races.
  async autoEnableAuthoritativeDhcp(prefixId: string, zoneId: string): Promise<DhcpAutoEnableOutcome> {
    try {
      return await this.transaction(async (tx): Promise<DhcpAutoEnableOutcome> => {
        const lockKey = zoneAclLockKey(zoneId);
        await tx.executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
        await this.requireLiveZone(zoneId, tx);
        const rows = await tx.queryRaw<DhcpConfigRow[]>`
          UPDATE "Prefix" p
          SET "dhcpMode" = 'AUTHORITATIVE', "updatedAt" = now()
          WHERE p.id = ${prefixId}
            AND p."organizationId" = ${this.contextService.organizationId}
            AND p."deletedAt" IS NULL
            AND p."dhcpMode" IS NULL
          RETURNING ${DHCP_CONFIG_COLUMNS}
        `;
        if (rows.length === 0) {
          const existing = await tx.queryRaw<Array<{ id: string }>>`
            SELECT p.id
            FROM "Prefix" p
            WHERE p.id = ${prefixId}
              AND p."organizationId" = ${this.contextService.organizationId}
              AND p."deletedAt" IS NULL
            LIMIT 1
          `;
          return existing.length > 0 ? 'already-configured' : 'not-found';
        }
        const after = rows[0];
        await this.writeAudit(
          'Prefix',
          prefixId,
          this.toJsonObject(toDhcpConfigForAudit({ ...after, dhcpMode: null })),
          this.toJsonObject(toDhcpConfigForAudit(after)),
          tx,
        );
        return 'enabled';
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2010' &&
        (error.meta?.['code'] === '23514' || error.meta?.['code'] === '23505')
      ) {
        return 'ineligible';
      }
      throw error;
    }
  }

  async getDnsOverride(prefixId: string): Promise<PrefixDnsOverride> {
    const rows = await this.queryRaw<Array<{ dnsServeDns: boolean | null; dnsUpstreamOverride: string[] }>>`
      SELECT p."dnsServeDns", p."dnsUpstreamOverride"
      FROM "Prefix" p
      WHERE p.id = ${prefixId}
        AND p."organizationId" = ${this.contextService.organizationId}
        AND p."deletedAt" IS NULL
      LIMIT 1
    `;
    if (rows.length === 0) {
      throw new NotFoundException('Prefix not found');
    }
    return { serveDns: rows[0].dnsServeDns, upstreamOverride: rows[0].dnsUpstreamOverride };
  }

  async updateDnsOverrideUnderZoneLock(
    prefixId: string,
    zoneId: string,
    input: PrefixDnsOverride,
  ): Promise<PrefixDnsOverride> {
    return this.transaction(async (tx) => {
      const lockKey = zoneAclLockKey(zoneId);
      await tx.executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
      // If deleteZone won the lock and committed, reject the write — its override reset is final.
      await this.requireLiveZone(zoneId, tx);
      return this.updateDnsOverride(prefixId, input, tx);
    });
  }

  async updateDnsOverride(
    prefixId: string,
    input: PrefixDnsOverride,
    executor?: IpamQueryExecutor,
  ): Promise<PrefixDnsOverride> {
    if (!executor) {
      return this.transaction((tx) => this.updateDnsOverrideInner(prefixId, input, tx));
    }
    return this.updateDnsOverrideInner(prefixId, input, executor);
  }

  private async updateDnsOverrideInner(
    prefixId: string,
    input: PrefixDnsOverride,
    executor: IpamQueryExecutor,
  ): Promise<PrefixDnsOverride> {
    const rows = await executor.queryRaw<
      Array<{
        dnsServeDns: boolean | null;
        dnsUpstreamOverride: string[];
        before_dnsServeDns: boolean | null;
        before_dnsUpstreamOverride: string[];
      }>
    >`
      WITH before AS (
        SELECT p."dnsServeDns", p."dnsUpstreamOverride"
        FROM "Prefix" p
        WHERE p.id = ${prefixId}
          AND p."organizationId" = ${this.contextService.organizationId}
          AND p."deletedAt" IS NULL
        LIMIT 1
        FOR UPDATE
      ),
      updated AS (
        UPDATE "Prefix" p
        SET
          "dnsServeDns" = ${input.serveDns},
          "dnsUpstreamOverride" = ${input.upstreamOverride}::text[],
          "updatedAt" = now()
        FROM before
        WHERE p.id = ${prefixId}
          AND p."organizationId" = ${this.contextService.organizationId}
          AND p."deletedAt" IS NULL
        RETURNING
          p."dnsServeDns", p."dnsUpstreamOverride",
          before."dnsServeDns" AS "before_dnsServeDns",
          before."dnsUpstreamOverride" AS "before_dnsUpstreamOverride"
      )
      SELECT * FROM updated
    `;
    if (rows.length === 0) {
      throw new NotFoundException('Prefix not found');
    }

    const row = rows[0];
    await this.writeAudit(
      'Prefix',
      prefixId,
      this.toJsonObject({ serveDns: row.before_dnsServeDns, upstreamOverride: row.before_dnsUpstreamOverride }),
      this.toJsonObject({ serveDns: row.dnsServeDns, upstreamOverride: row.dnsUpstreamOverride }),
      executor,
    );

    return { serveDns: row.dnsServeDns, upstreamOverride: row.dnsUpstreamOverride };
  }

  async ensureNoCreateConflict(entity: PrefixEntity, executor: IpamQueryExecutor = this): Promise<void> {
    const overlap = await this.detectPrefixOverlapForNormalizedPrefix(
      entity.state.prefix,
      entity.state.vrfId,
      null,
      executor,
    );
    if (overlap.hasOverlap) {
      throw new ConflictException(`Prefix overlaps existing prefix ${overlap.conflictingPrefix}`);
    }

    const duplicate = await executor.queryRaw<PrefixOverlapRow[]>`
      SELECT p.id, p.prefix::text AS prefix
      FROM "Prefix" p
      WHERE p."organizationId" = ${entity.state.organizationId}
        AND p."deletedAt" IS NULL
        AND (p."vrfId" IS NOT DISTINCT FROM ${entity.state.vrfId})
        AND p.prefix = ${entity.state.prefix}::cidr
      LIMIT 1
    `;
    if (duplicate.length > 0) {
      throw new ConflictException('Prefix already exists in this VRF');
    }
  }

  async createWithConflictGuard(entity: PrefixEntity): Promise<IpamPrefix> {
    try {
      return await this.transaction(async (tx) => {
        await this.lockIpamScope(tx, 'prefix', entity.state.organizationId, entity.state.vrfId);
        await this.ensureParent(entity, null, tx);
        await this.ensureNoCreateConflict(entity, tx);
        await this.ensureZone(entity, tx);
        return this.save(entity, null, tx);
      });
    } catch (error) {
      this.throwConflictOnConstraintError(error, 'Prefix already exists or overlaps another prefix in this VRF');
    }
  }

  async updateWithConflictGuard(
    entity: PrefixEntity,
    before: IpamPrefix,
    vrfChanged = false,
    // Runs after save in the same locked tx, so vrrpVipId and bindings update atomically and a concurrent reconcile never sees a half-updated pair.
    afterSave?: (updated: IpamPrefix, tx: IpamQueryExecutor) => Promise<void>,
  ): Promise<IpamPrefix> {
    try {
      return await this.transaction(async (tx) => {
        await this.lockIpamScope(tx, 'prefix', entity.state.organizationId, entity.state.vrfId);
        // A VRF change moves the prefix between scope keys, so lockIpamScope alone can't serialize with a concurrent VIP-assign — take the prefix-id lock explicitly (scope→prefix→ip order).
        if (vrfChanged) {
          await this.lockIpamPrefix(tx, entity.state.organizationId, entity.state.id);
        }
        await this.ensureParent(entity, entity.state.id, tx);
        await this.ensureVlanCompatibility(entity, tx);
        await this.ensureGateway(entity, entity.state.id, tx);
        await this.ensureVrrpVip(entity, entity.state.id, tx);
        await this.ensureZone(entity, tx);
        const updated = await this.save(entity, before, tx);
        if (afterSave) {
          await afterSave(updated, tx);
        }
        return updated;
      });
    } catch (error) {
      this.throwConflictOnConstraintError(error, 'Prefix update conflicts with another active prefix');
    }
  }

  async persistUnderLock(
    entity: PrefixEntity,
    before: IpamPrefix,
    afterSave?: (row: IpamPrefix, tx: IpamQueryExecutor) => Promise<void>,
  ): Promise<IpamPrefix> {
    return this.transaction(async (tx) => {
      await this.lockIpamScope(tx, 'prefix', entity.state.organizationId, entity.state.vrfId);
      const row = await this.save(entity, before, tx);
      if (afterSave) {
        await afterSave(row, tx);
      }
      return row;
    });
  }

  async save(entity: PrefixEntity, before: IpamPrefix | null, executor: IpamQueryExecutor = this): Promise<IpamPrefix> {
    if (entity.isNew) {
      const createdRows = await executor.queryRaw<PrefixRow[]>`
        INSERT INTO "Prefix" (
          id,
          prefix,
          status,
          "isPool",
          role,
          "zoneId",
          "organizationId",
          "vrfId",
          "parentId",
          "vlanId",
          "gatewayIpId",
          "prefixRoleId",
          "enableVlanTag",
          "bondParameters",
          "createdAt",
          "updatedAt"
        )
        VALUES (
          gen_random_uuid(),
          ${entity.state.prefix}::cidr,
          ${entity.state.status}::"PrefixStatus",
          ${entity.state.isPool},
          ${entity.state.role}::"IpamRole",
          ${entity.state.zoneId},
          ${entity.state.organizationId},
          ${entity.state.vrfId},
          ${entity.state.parentId},
          ${entity.state.vlanId},
          ${entity.state.gatewayIpId},
          ${entity.state.prefixRoleId},
          ${entity.state.enableVlanTag},
          ${entity.state.bondParameters === null ? null : JSON.stringify(entity.state.bondParameters)}::jsonb,
          now(),
          now()
        )
        RETURNING
          id,
          prefix::text AS prefix,
          status,
          "isPool",
          role,
          "zoneId",
          "organizationId",
          "vrfId",
          "parentId",
          "vlanId",
          "gatewayIpId",
          "vrrpVipId",
          "prefixRoleId",
          "enableVlanTag",
          "bondParameters",
          "createdAt",
          "updatedAt",
          "deletedAt"
      `;

      const created = createdRows[0];
      await this.writeAudit('Prefix', created.id, null, this.toJsonObject(created), executor);
      return this.toPrefix(created);
    }

    if (entity.isArchived) {
      const rows = await executor.queryRaw<PrefixRow[]>`
        UPDATE "Prefix" p
        SET "deletedAt" = now(), "updatedAt" = now()
        WHERE p.id = ${entity.state.id}
          AND p."organizationId" = ${this.contextService.organizationId}
          AND p."deletedAt" IS NULL
        RETURNING
          p.id,
          p.prefix::text AS prefix,
          p.status,
          p."isPool",
          p.role,
          p."zoneId",
          p."organizationId",
          p."vrfId",
          p."parentId",
          p."vlanId",
          p."gatewayIpId",
          p."vrrpVipId",
          p."prefixRoleId",
          p."enableVlanTag",
          p."bondParameters",
          p."createdAt",
          p."updatedAt",
          p."deletedAt"
      `;
      if (rows.length === 0) {
        throw new NotFoundException('Prefix not found');
      }
      const archived = rows[0];
      await this.writeAudit(
        'Prefix',
        entity.state.id,
        this.toJsonObject(before),
        this.toJsonObject(archived),
        executor,
      );
      return this.toPrefix(archived);
    }

    const updatedRows = await executor.queryRaw<PrefixRow[]>`
      UPDATE "Prefix" p
      SET
        status = CASE
          WHEN ${entity.changes.status}
          THEN ${entity.state.status}::"PrefixStatus"
          ELSE p.status
        END,
        "isPool" = CASE
          WHEN ${entity.changes.isPool}
          THEN ${entity.state.isPool}
          ELSE p."isPool"
        END,
        role = CASE
          WHEN ${entity.changes.role}
          THEN ${entity.state.role}::"IpamRole"
          ELSE p.role
        END,
        "zoneId" = CASE
          WHEN ${entity.changes.zoneId}
          THEN ${entity.state.zoneId}
          ELSE p."zoneId"
        END,
        "vrfId" = CASE
          WHEN ${entity.changes.vrfId}
          THEN ${entity.state.vrfId}
          ELSE p."vrfId"
        END,
        "parentId" = CASE
          WHEN ${entity.changes.parentId}
          THEN ${entity.state.parentId}
          ELSE p."parentId"
        END,
        "vlanId" = CASE
          WHEN ${entity.changes.vlanId}
          THEN ${entity.state.vlanId}
          ELSE p."vlanId"
        END,
        "gatewayIpId" = CASE
          WHEN ${entity.changes.gatewayIpId}
          THEN ${entity.state.gatewayIpId}
          ELSE p."gatewayIpId"
        END,
        "vrrpVipId" = CASE
          WHEN ${entity.changes.vrrpVipId}
          THEN ${entity.state.vrrpVipId}
          ELSE p."vrrpVipId"
        END,
        "prefixRoleId" = CASE
          WHEN ${entity.changes.prefixRoleId}
          THEN ${entity.state.prefixRoleId}
          ELSE p."prefixRoleId"
        END,
        "enableVlanTag" = CASE
          WHEN ${entity.changes.enableVlanTag}
          THEN ${entity.state.enableVlanTag}
          ELSE p."enableVlanTag"
        END,
        "bondParameters" = CASE
          WHEN ${entity.changes.bondParameters}
          THEN ${entity.state.bondParameters === null ? null : JSON.stringify(entity.state.bondParameters)}::jsonb
          ELSE p."bondParameters"
        END,
        "updatedAt" = now()
      WHERE p.id = ${entity.state.id}
        AND p."organizationId" = ${this.contextService.organizationId}
        AND p."deletedAt" IS NULL
      RETURNING
        p.id,
        p.prefix::text AS prefix,
        p.status,
        p."isPool",
        p.role,
        p."zoneId",
        p."organizationId",
        p."vrfId",
        p."parentId",
        p."vlanId",
        p."gatewayIpId",
        p."vrrpVipId",
        p."prefixRoleId",
        p."enableVlanTag",
        p."bondParameters",
        p."createdAt",
        p."updatedAt",
        p."deletedAt"
    `;
    if (updatedRows.length === 0) {
      throw new NotFoundException('Prefix not found');
    }
    const updated = updatedRows[0];
    await this.writeAudit('Prefix', entity.state.id, this.toJsonObject(before), this.toJsonObject(updated), executor);
    return this.toPrefix(updated);
  }

  async listChildPrefixes(id: string): Promise<IpamPrefix[]> {
    const parent = await this.requirePrefix(id);
    const rows = await this.queryRaw<PrefixRow[]>`
      SELECT
        p.id,
        p.prefix::text AS prefix,
        p.status,
        p."isPool",
        p.role,
        p."zoneId",
        p."organizationId",
        p."vrfId",
        p."parentId",
        p."vlanId",
        p."gatewayIpId",
        p."vrrpVipId",
        p."prefixRoleId",
        p."enableVlanTag",
        p."bondParameters",
        p."createdAt",
        p."updatedAt",
        p."deletedAt"
      FROM "Prefix" p
      WHERE p."organizationId" = ${this.contextService.organizationId}
        AND p."deletedAt" IS NULL
        AND (p."vrfId" IS NOT DISTINCT FROM ${parent.vrfId})
        AND p.id <> ${id}
        AND p.prefix << ${parent.prefix}::cidr
      ORDER BY masklen(p.prefix) ASC, p.prefix::text ASC
    `;
    return rows.map((row) => this.toPrefix(row));
  }

  async listIpsInPrefix(id: string): Promise<IpAddress[]> {
    const prefix = await this.requirePrefix(id);
    const rows = await this.queryRaw<IpAddressRow[]>`
      SELECT
        ip.id,
        ip.address::text AS address,
        ip.status,
        ip."dnsName",
        ip."organizationId",
        ip."vrfId",
        ip."assignedObjectType",
        ip."assignedObjectId",
        ip."interfaceId",
        ip."createdAt",
        ip."updatedAt",
        ip."deletedAt"
      FROM "IpAddress" ip
      WHERE ip."organizationId" = ${this.contextService.organizationId}
        AND ip."deletedAt" IS NULL
        AND (ip."vrfId" IS NOT DISTINCT FROM ${prefix.vrfId})
        -- <<= not <<: IP rows carry the subnet's mask (10.0.1.2/24), which strict containment misses
        AND ip.address <<= ${prefix.prefix}::cidr
      ORDER BY ip.address::text ASC
    `;
    return rows.map((row) => this.toIpAddress(row));
  }

  async getPrefixUtilization(id: string): Promise<PrefixUtilization> {
    await this.requirePrefix(id);
    const rows = await this.queryRaw<PrefixUtilizationRow[]>`
      SELECT
        p.id AS "prefixId",
        p.prefix::text AS prefix,
        family(p.prefix)::int AS family,
        p."isPool" AS "isPool",
        CASE
          WHEN family(p.prefix) = 4 THEN
            GREATEST(
              (
                power(2::numeric, (32 - masklen(p.prefix))::numeric) -
                CASE WHEN masklen(p.prefix) <= 30 THEN 2 ELSE 0 END
              )::bigint,
              0
            )
          ELSE 0::bigint
        END AS "poolCapacity",
        (
          SELECT COUNT(*)::bigint
          FROM "IpAddress" ip
          WHERE ip."organizationId" = p."organizationId"
            AND ip."deletedAt" IS NULL
            AND (ip."vrfId" IS NOT DISTINCT FROM p."vrfId")
            AND ip.address <<= p.prefix
        ) AS "assignedIps"
      FROM "Prefix" p
      WHERE p.id = ${id}
        AND p."organizationId" = ${this.contextService.organizationId}
        AND p."deletedAt" IS NULL
      LIMIT 1
    `;
    if (rows.length === 0) {
      throw new NotFoundException('Prefix not found');
    }
    const row = rows[0];
    const assignedIps = this.toInt(row.assignedIps);
    const poolCapacity = this.toInt(row.poolCapacity);
    const availableIps = Math.max(poolCapacity - assignedIps, 0);
    const utilizationPercent = poolCapacity > 0 ? Number(((assignedIps / poolCapacity) * 100).toFixed(2)) : 0;

    return {
      prefixId: row.prefixId,
      prefix: row.prefix,
      family: row.family,
      isPool: row.isPool,
      assignedIps,
      poolCapacity,
      availableIps,
      utilizationPercent,
    };
  }

  async allocateNextPrefix(parentPrefixId: string, input: AllocateNextPrefixRequest): Promise<IpamPrefix> {
    return this.transaction(async (tx) => {
      await tx.executeRaw`
        SELECT pg_advisory_xact_lock(hashtext(${`ipam-allocate-prefix:${parentPrefixId}`}))
      `;

      const parentRows = await tx.queryRaw<Array<{ prefix: string; vrfId: string | null; organizationId: string }>>`
        SELECT p.prefix::text AS prefix, p."vrfId", p."organizationId"
        FROM "Prefix" p
        WHERE p.id = ${parentPrefixId}
          AND p."organizationId" = ${this.contextService.organizationId}
          AND p."deletedAt" IS NULL
        LIMIT 1
      `;
      if (parentRows.length === 0) {
        throw new NotFoundException('Parent prefix not found');
      }

      const parent = parentRows[0];
      const parentInfo = this.parseIpv4Prefix(parent.prefix);
      if (parentInfo === null) {
        throw new BadRequestException('Automatic prefix allocation currently supports IPv4 prefixes only');
      }
      if (input.targetMask <= parentInfo.mask) {
        throw new BadRequestException('Target mask must be more specific than the parent prefix mask');
      }
      if (input.targetMask > 32) {
        throw new BadRequestException('IPv4 target mask cannot be greater than /32');
      }

      const existingRows = await tx.queryRaw<Array<{ prefix: string }>>`
        SELECT p.prefix::text AS prefix
        FROM "Prefix" p
        WHERE p."organizationId" = ${parent.organizationId}
          AND p."deletedAt" IS NULL
          AND (p."vrfId" IS NOT DISTINCT FROM ${parent.vrfId})
          AND p.id <> ${parentPrefixId}
          AND p.prefix << ${parent.prefix}::cidr
        ORDER BY p.prefix::text ASC
      `;

      const existingRanges = existingRows
        .map((row) => this.parseIpv4Prefix(row.prefix))
        .filter((value): value is { network: number; broadcast: number; mask: number } => value !== null);

      const blockSize = 2 ** (32 - input.targetMask);
      let candidateNetwork = parentInfo.network;
      let selectedPrefix: string | null = null;

      while (candidateNetwork + blockSize - 1 <= parentInfo.broadcast) {
        const candidateRange = {
          start: candidateNetwork,
          end: candidateNetwork + blockSize - 1,
        };
        const overlaps = existingRanges.some(
          (range) => !(candidateRange.end < range.network || candidateRange.start > range.broadcast),
        );
        if (!overlaps) {
          selectedPrefix = `${intToIpv4(candidateNetwork)}/${input.targetMask}`;
          break;
        }
        candidateNetwork += blockSize;
      }

      if (!selectedPrefix) {
        throw new ConflictException('No available child prefix found for requested mask');
      }

      const insertedRows = await tx.queryRaw<PrefixRow[]>`
        INSERT INTO "Prefix" (
          id,
          prefix,
          status,
          "isPool",
          role,
          "zoneId",
          "organizationId",
          "vrfId",
          "parentId",
          "vlanId",
          "gatewayIpId",
          "createdAt",
          "updatedAt"
        )
        VALUES (
          gen_random_uuid(),
          ${selectedPrefix}::cidr,
          ${input.status ?? 'ACTIVE'}::"PrefixStatus",
          ${input.isPool ?? false},
          ${null}::"IpamRole",
          ${null},
          ${parent.organizationId},
          ${parent.vrfId},
          ${parentPrefixId},
          ${null},
          ${null},
          now(),
          now()
        )
        RETURNING
          id,
          prefix::text AS prefix,
          status,
          "isPool",
          role,
          "zoneId",
          "organizationId",
          "vrfId",
          "parentId",
          "vlanId",
          "gatewayIpId",
          "vrrpVipId",
          "prefixRoleId",
          "enableVlanTag",
          "bondParameters",
          "createdAt",
          "updatedAt",
          "deletedAt"
      `;
      const created = insertedRows[0];
      const { actorId, actorType } = this.contextService.resolveActor();
      await tx.createChangelog({
        data: {
          tableName: 'Prefix',
          pk: created.id,
          before: Prisma.JsonNull,
          after: this.toJsonObject(created),
          diff: this.diffRecords(null, this.toJsonObject(created)),
          organizationId: created.organizationId,
          actorId,
          actorType,
        },
      });
      return this.toPrefix(created);
    });
  }

  async detectPrefixOverlap(input: DetectPrefixOverlapRequest): Promise<{
    hasOverlap: boolean;
    conflictingPrefixId: string | null;
    conflictingPrefix: string | null;
  }> {
    const normalizedPrefix = await this.normalizeCidr(input.prefix);
    if (input.vrfId) {
      await this.requireVrf(input.vrfId);
    }
    return this.detectPrefixOverlapForNormalizedPrefix(
      normalizedPrefix,
      input.vrfId ?? null,
      input.excludePrefixId ?? null,
      this,
    );
  }

  private async detectPrefixOverlapForNormalizedPrefix(
    normalizedPrefix: string,
    vrfId: string | null,
    excludePrefixId: string | null,
    executor: IpamQueryExecutor,
  ): Promise<{
    hasOverlap: boolean;
    conflictingPrefixId: string | null;
    conflictingPrefix: string | null;
  }> {
    const clauses: Prisma.Sql[] = [
      Prisma.sql`p."organizationId" = ${this.contextService.organizationId}`,
      Prisma.sql`p."deletedAt" IS NULL`,
      Prisma.sql`(p."vrfId" IS NOT DISTINCT FROM ${vrfId})`,
      Prisma.sql`p.prefix && ${normalizedPrefix}::cidr`,
    ];
    if (excludePrefixId !== null) {
      clauses.push(Prisma.sql`p.id <> ${excludePrefixId}`);
    }

    const rows = await executor.queryRaw<PrefixOverlapRow[]>`
      SELECT p.id, p.prefix::text AS prefix
      FROM "Prefix" p
      WHERE ${Prisma.join(clauses, ' AND ')}
      ORDER BY masklen(p.prefix) DESC
      LIMIT 1
    `;

    if (rows.length === 0) {
      return {
        hasOverlap: false,
        conflictingPrefixId: null,
        conflictingPrefix: null,
      };
    }

    return {
      hasOverlap: true,
      conflictingPrefixId: rows[0].id,
      conflictingPrefix: rows[0].prefix,
    };
  }

  async validatePrefixGatewayRequest(input: ValidatePrefixGatewayRequest): Promise<ValidatePrefixGatewayResult> {
    const prefix = await this.requirePrefix(input.prefixId);
    try {
      await this.validatePrefixGateway({
        prefixId: prefix.id,
        gatewayIpId: input.gatewayIpId,
        candidatePrefix: prefix.prefix,
        candidateVrfId: prefix.vrfId,
      });
      return { valid: true, reason: null };
    } catch (error) {
      if (error instanceof BadRequestException || error instanceof NotFoundException) {
        return { valid: false, reason: error.message };
      }
      throw error;
    }
  }

  // Keeps the Gateway table coherent with Prefix.gatewayIpId. Auto-managed-priority rows sync in
  // lockstep; any other priority is operator-customized — never touched, only reported via customRowPreserved.
  async syncGatewayRecordOnSet(
    prefixId: string,
    gatewayIpId: string,
    previousGatewayIpId: string | null,
    vrfId: string | null,
    executor: IpamQueryExecutor = this,
  ): Promise<GatewaySyncResult> {
    const rowsForNew = await executor.queryRaw<Array<{ id: string }>>`
      SELECT id FROM "Gateway"
      WHERE "prefixId" = ${prefixId} AND "gatewayIpId" = ${gatewayIpId}
      LIMIT 1
    `;
    const changingFrom =
      previousGatewayIpId !== null && previousGatewayIpId !== gatewayIpId ? previousGatewayIpId : null;
    let customRowPreserved = false;
    if (changingFrom !== null) {
      const customRows = await executor.queryRaw<Array<{ id: string }>>`
        SELECT id FROM "Gateway"
        WHERE "prefixId" = ${prefixId} AND "gatewayIpId" = ${changingFrom}
          AND "routingPriority" IS DISTINCT FROM ${AUTO_MANAGED_ROUTING_PRIORITY}
        LIMIT 1
      `;
      customRowPreserved = customRows.length > 0;
    }
    if (rowsForNew.length > 0) {
      if (changingFrom !== null) {
        await executor.executeRaw`
          DELETE FROM "Gateway"
          WHERE "prefixId" = ${prefixId} AND "gatewayIpId" = ${changingFrom}
            AND "routingPriority" = ${AUTO_MANAGED_ROUTING_PRIORITY}
        `;
      }
      return { action: 'noop', customRowPreserved };
    }
    if (changingFrom !== null) {
      const updatedCount = await executor.executeRaw`
        UPDATE "Gateway"
        SET "gatewayIpId" = ${gatewayIpId}, "vrfId" = ${vrfId}, "updatedAt" = now()
        WHERE "prefixId" = ${prefixId} AND "gatewayIpId" = ${changingFrom}
          AND "routingPriority" = ${AUTO_MANAGED_ROUTING_PRIORITY}
      `;
      if (updatedCount > 0) {
        return { action: 'updated', customRowPreserved };
      }
    }
    await executor.executeRaw`
      INSERT INTO "Gateway" (id, "gatewayIpId", "prefixId", "vrfId", "routingPriority", "createdAt", "updatedAt")
      VALUES (gen_random_uuid(), ${gatewayIpId}, ${prefixId}, ${vrfId}, ${AUTO_MANAGED_ROUTING_PRIORITY}, now(), now())
    `;
    return { action: 'created', customRowPreserved };
  }

  async syncGatewayRecordOnClear(
    prefixId: string,
    previousGatewayIpId: string | null,
    executor: IpamQueryExecutor = this,
  ): Promise<GatewaySyncResult> {
    if (previousGatewayIpId === null) {
      return { action: 'noop', customRowPreserved: false };
    }
    const removedCount = await executor.executeRaw`
      DELETE FROM "Gateway"
      WHERE "prefixId" = ${prefixId} AND "gatewayIpId" = ${previousGatewayIpId}
        AND "routingPriority" = ${AUTO_MANAGED_ROUTING_PRIORITY}
    `;
    // No (prefixId, gatewayIpId) unique constraint: a custom row can coexist with the auto-managed
    // one, so probe for survivors even after a successful delete.
    const customRows = await executor.queryRaw<Array<{ id: string }>>`
      SELECT id FROM "Gateway"
      WHERE "prefixId" = ${prefixId} AND "gatewayIpId" = ${previousGatewayIpId}
      LIMIT 1
    `;
    return {
      action: removedCount > 0 ? 'removed' : 'noop',
      customRowPreserved: customRows.length > 0,
    };
  }
}
