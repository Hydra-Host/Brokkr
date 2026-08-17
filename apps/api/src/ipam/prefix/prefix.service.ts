import { isIPv4 } from 'node:net';

import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  AllocateNextPrefixRequest,
  CreatePrefixRequest,
  DetectPrefixOverlapRequest,
  DhcpLease,
  DhcpReservation,
  IpAddress,
  IpamPrefix,
  MAX_DHCP_DNS_SERVERS,
  PrefixDhcpConfig,
  PrefixDhcpServing,
  PrefixDnsOverride,
  PrefixListQuery,
  PrefixUtilization,
  RESERVED_DHCP_OPTION_CODES,
  RESERVED_DHCP_OPTIONS,
  UpdatePrefixDhcpConfig,
  UpdatePrefixRequest,
  ValidatePrefixGatewayRequest,
  ValidatePrefixGatewayResult,
  VrrpBinding,
} from '@repo/api-client';
import { DhcpConfigPublisherService } from 'src/brokkr-bridge/dhcp/dhcp-config-publisher.service';
import { DhcpConfigRedisWriterService } from 'src/brokkr-bridge/dhcp/dhcp-config-redis-writer.service';
import { DhcpDerivationService } from 'src/brokkr-bridge/dhcp/dhcp-derivation.service';
import { DhcpLeaseReaderService } from 'src/brokkr-bridge/dhcp/dhcp-lease-reader.service';
import { DnsConfigPublisherService } from 'src/brokkr-bridge/dns/dns-config-publisher.service';
import { VrrpRedisWriterService } from 'src/brokkr-bridge/vrrp/vrrp-redis-writer.service';
import { ContextService } from 'src/common/context/context.service';
import { Logger } from 'src/common/decorators/logger.decorator';
import { getErrorMessage } from 'src/common/error-utils';
import { LoggerService } from 'src/logger/logger.service';
import { PrefixEntity } from './prefix.entity';
import { type GatewaySyncResult, PrefixRepository } from './prefix.repository';

// Maintainer ruling: assigning role PRIMARY or MANAGEMENT is the explicit "bridge serves this
// subnet" signal, so an unset dhcpMode auto-enables AUTHORITATIVE. A blanket default is hazardous
// (the presence reconciler auto-creates LAN uplink prefixes); the deliberate role assignment is
// the trigger instead — a MANAGEMENT prefix left unconfigured PXE-boots into the void.
const DHCP_AUTO_ENABLE_ROLES: ReadonlySet<IpamPrefix['role']> = new Set(['PRIMARY', 'MANAGEMENT']);

@Injectable()
export class PrefixService {
  constructor(
    private readonly prefixRepository: PrefixRepository,
    private readonly contextService: ContextService,
    private readonly vrrpWriter: VrrpRedisWriterService,
    private readonly dhcpWriter: DhcpConfigRedisWriterService,
    private readonly dhcpPublisher: DhcpConfigPublisherService,
    private readonly dhcpLeaseReader: DhcpLeaseReaderService,
    private readonly dhcpDerivation: DhcpDerivationService,
    private readonly dnsPublisher: DnsConfigPublisherService,
    @Logger(PrefixService.name)
    private readonly logger: LoggerService,
  ) {}

  async findById(id: string): Promise<IpamPrefix> {
    this.contextService.requirePermission('ipam', 'read');
    return this.prefixRepository.restore(id);
  }

  async listPrefixes(query: PrefixListQuery): Promise<IpamPrefix[]> {
    this.contextService.requirePermission('ipam', 'read');
    return this.prefixRepository.listPrefixes(query);
  }

  async createPrefix(input: CreatePrefixRequest): Promise<IpamPrefix> {
    this.contextService.requirePermission('ipam', 'create');
    const normalizedPrefix = await this.prefixRepository.normalizePrefix(input.prefix);
    const entity = PrefixEntity.create(input, this.contextService.organizationId, normalizedPrefix);
    await this.prefixRepository.ensureVrf(entity);
    await this.prefixRepository.ensureZone(entity);
    await this.prefixRepository.ensurePrefixRole(entity);
    const created = await this.prefixRepository.createWithConflictGuard(entity);
    if (DHCP_AUTO_ENABLE_ROLES.has(created.role)) {
      await this.autoEnableDhcpForRole(created, 'create');
    }
    return created;
  }

  async updatePrefix(id: string, input: UpdatePrefixRequest): Promise<IpamPrefix> {
    this.contextService.requirePermission('ipam', 'update');
    const before = await this.prefixRepository.restore(id);
    const previousZoneId = before.zoneId;
    const previousVrfId = before.vrfId;
    const entity = PrefixEntity.restore(before);
    entity.applyUpdate(input);
    // vrfChanged makes updateWithConflictGuard take the prefix-id lock, serializing a VRF move against a concurrent VIP-assign (they lock different scope keys).
    const vrfChanged = entity.changes.vrfId && (previousVrfId ?? null) !== (entity.state.vrfId ?? null);
    // Gate VIP teardown on THIS request's change-set, not previousZoneId vs the committed row — else a status-only PATCH racing a zone move would unhealably wipe the other request's fresh bindings.
    const zoneChanged = entity.changes.zoneId && (previousZoneId ?? null) !== (entity.state.zoneId ?? null);
    const gatewayChanged =
      entity.changes.gatewayIpId && (before.gatewayIpId ?? null) !== (entity.state.gatewayIpId ?? null);
    // A zoneless prefix derives to 'disabled' and silently stops serving — block clearing the
    // zone while DHCP is enabled (operator must disable DHCP first).
    if (zoneChanged && entity.state.zoneId === null) {
      const dhcp = await this.prefixRepository.getDhcpConfig(id);
      if (dhcp.dhcpMode === 'AUTHORITATIVE' || dhcp.dhcpMode === 'PROXY') {
        throw new BadRequestException(
          'Cannot remove the zone from a prefix with DHCP enabled. Disable DHCP on this prefix first, then clear the zone.',
        );
      }
      const dns = await this.prefixRepository.getDnsOverride(id);
      if (dns.serveDns !== null || dns.upstreamOverride.length > 0) {
        throw new BadRequestException(
          'Cannot remove the zone from a prefix with DNS overrides. Clear the DNS override first, then remove the zone.',
        );
      }
    }
    await this.prefixRepository.ensureVrf(entity);
    await this.prefixRepository.ensureZone(entity);
    await this.prefixRepository.ensurePrefixRole(entity);
    // Zone change on a VIP-bearing prefix: clear stale per-bridge bindings in the SAME
    // locked tx so a concurrent read can't publish an atom keyed to old-zone bridges.
    let gatewaySync: GatewaySyncResult | null = null;
    const updated = await this.prefixRepository.updateWithConflictGuard(entity, before, vrfChanged, async (u, tx) => {
      if (zoneChanged && u.vrrpVipId) {
        await this.prefixRepository.replacePrefixVrrpBindings(id, [], tx);
      }
      if (gatewayChanged) {
        gatewaySync = u.gatewayIpId
          ? await this.prefixRepository.syncGatewayRecordOnSet(id, u.gatewayIpId, before.gatewayIpId, u.vrfId, tx)
          : await this.prefixRepository.syncGatewayRecordOnClear(id, before.gatewayIpId, tx);
      }
    });
    this.logGatewaySync(id, gatewaySync);
    // Runs BEFORE the atom publishes below so they derive from the auto-enabled mode. Zone
    // assignment (null → zone) re-attempts a role that qualified while the prefix was zoneless.
    const roleTransitioned = entity.changes.role && (before.role ?? null) !== (entity.state.role ?? null);
    const zoneAssigned = zoneChanged && previousZoneId === null && updated.zoneId !== null;
    if ((roleTransitioned || zoneAssigned) && DHCP_AUTO_ENABLE_ROLES.has(updated.role)) {
      await this.autoEnableDhcpForRole(updated, roleTransitioned ? 'role assignment' : 'zone assignment');
    }
    // DHCP relocates first (serves live traffic) and on ANY zone change (not VIP-gated); each step is isolated — a failure logs and the reconcile cron heals.
    if (zoneChanged) {
      try {
        await this.relocateDhcpAtom(id, previousZoneId, updated.zoneId);
      } catch (error) {
        this.logger.error(
          `DHCP atom relocate failed for prefix ${id} (old zone ${previousZoneId} → new zone ${updated.zoneId}); reconcile cron will heal: ${getErrorMessage(error)}`,
        );
      }
      try {
        await this.relocateDnsAtom(id, previousZoneId, updated.zoneId);
      } catch (error) {
        this.logger.error(
          `DNS prefix-override atom relocate failed for prefix ${id} (old zone ${previousZoneId} → new zone ${updated.zoneId}); reconcile cron will heal: ${getErrorMessage(error)}`,
        );
      }
    }
    if (zoneChanged && updated.vrrpVipId) {
      try {
        await this.relocateVrrpAtom(id, previousZoneId, updated.zoneId);
      } catch (error) {
        this.logger.error(
          `VRRP atom relocate failed for prefix ${id} (old zone ${previousZoneId} → new zone ${updated.zoneId}); reconcile cron will heal: ${getErrorMessage(error)}`,
        );
      }
    }
    if (!zoneChanged && (entity.changes.role || entity.changes.vrfId || entity.changes.gatewayIpId)) {
      // A role/vrf/gateway change without a zone move still shifts the derived atom (eligibility,
      // routers) — re-derive eagerly; publishOrClearDhcpAtom clears when now-ineligible.
      await this.publishOrClearDhcpAtom(id, updated.zoneId);
    }
    return updated;
  }

  private async publishVrrpVip(zoneId: string, prefixId: string): Promise<void> {
    const composed = await this.prefixRepository.composeVrrpVip(prefixId);
    if (!composed) {
      // Do NOT DEL here: clear is unconditional and could clobber a concurrent set's valid atom — the reconcile cron withdraws the orphan.
      this.logger.warn(
        `VRRP VIP for prefix ${prefixId} composed to null (no bridge bindings or linked IP gone); not published to zone ${zoneId} — reconcile will withdraw any stale atom`,
      );
      return;
    }
    const { vip, ifaceByBridge, garpCount } = composed;
    try {
      const result = await this.vrrpWriter.set(zoneId, prefixId, vip, ifaceByBridge, garpCount);
      if (!result.written) {
        this.logger.warn(
          `VRRP VIP atom write skipped (${result.reason}) for prefix ${prefixId} in zone ${zoneId}; bridge may hold a newer value`,
        );
      }
    } catch (error) {
      this.logger.error(
        `VRRP VIP atom publish failed for prefix ${prefixId} in zone ${zoneId}; bridge will not see it until re-set`,
        error instanceof Error ? error.stack : undefined,
      );
      throw error;
    }
  }

  // Publish under the new zone BEFORE withdrawing the old: if the publish fails the old atom survives and a bridge keeps serving until the reconcile cron heals.
  // newZoneId null just withdraws — the row keeps vrrpVipId and re-publishes on zone reassign.
  private async relocateVrrpAtom(prefixId: string, oldZoneId: string | null, newZoneId: string | null): Promise<void> {
    if (newZoneId) {
      await this.publishVrrpVip(newZoneId, prefixId);
    }
    if (oldZoneId) {
      await this.vrrpWriter.clear(oldZoneId, prefixId);
    }
  }

  async archivePrefix(id: string): Promise<IpamPrefix> {
    this.contextService.requirePermission('ipam', 'delete');
    const before = await this.prefixRepository.restore(id);
    const entity = PrefixEntity.restore(before);
    entity.archive();
    const archived = await this.prefixRepository.persistUnderLock(entity, before, async (row, tx) => {
      if (row.vrrpVipId) {
        // In-tx: the FK cascade only fires on a hard delete, and stale bindings must not survive an un-archive or prefill the edit form.
        await this.prefixRepository.replacePrefixVrrpBindings(id, [], tx);
      }
    });
    if (archived.vrrpVipId && archived.zoneId) {
      await this.vrrpWriter.clear(archived.zoneId, id);
    }
    // Not VIP-gated: an archived prefix must stop being served DHCP immediately; a failed DEL is healed by the reconcile cron.
    if (archived.zoneId) {
      try {
        await this.dhcpWriter.clear(archived.zoneId, id);
      } catch (error) {
        this.logger.warn(
          `DHCP atom clear on archive failed for prefix ${id} (reconcile cron will heal): ${getErrorMessage(error)}`,
        );
      }
      try {
        await this.dnsPublisher.clearPrefixDnsOverride(archived.zoneId, id);
      } catch (error) {
        this.logger.warn(
          `DNS prefix-override atom clear on archive failed for prefix ${id} (reconcile cron will heal): ${getErrorMessage(error)}`,
        );
      }
    }
    return archived;
  }

  // Publish under the new zone BEFORE clearing the old: a failed publish leaves the old atom
  // live so a bridge keeps serving until the reconcile cron heals.
  private async relocateAtom(
    prefixId: string,
    oldZoneId: string | null,
    newZoneId: string | null,
    publish: () => Promise<boolean>,
    clear: (zoneId: string) => Promise<void>,
    label: string,
  ): Promise<void> {
    let publishedToNew = false;
    if (newZoneId) {
      publishedToNew = await publish();
    }
    if (oldZoneId && (publishedToNew || !newZoneId)) {
      try {
        await clear(oldZoneId);
      } catch (error) {
        this.logger.warn(
          `${label} atom clear (old zone ${oldZoneId}) failed for prefix ${prefixId} on relocate (reconcile cron will heal): ${getErrorMessage(error)}`,
        );
      }
    }
  }

  private async relocateDnsAtom(prefixId: string, oldZoneId: string | null, newZoneId: string | null): Promise<void> {
    return this.relocateAtom(
      prefixId,
      oldZoneId,
      newZoneId,
      () => this.dnsPublisher.publishPrefixDnsOverride(prefixId),
      (zoneId) => this.dnsPublisher.clearPrefixDnsOverride(zoneId, prefixId),
      'DNS prefix-override',
    );
  }

  private async relocateDhcpAtom(prefixId: string, oldZoneId: string | null, newZoneId: string | null): Promise<void> {
    return this.relocateAtom(
      prefixId,
      oldZoneId,
      newZoneId,
      () => this.publishOrClearDhcpAtom(prefixId, newZoneId),
      (zoneId) => this.dhcpWriter.clear(zoneId, prefixId),
      'DHCP',
    );
  }

  async setPrefixVrrpVip(prefixId: string, vrrpVipId: string, bindings: VrrpBinding[]): Promise<IpamPrefix> {
    this.contextService.requirePermission('ipam', 'update');
    const before = await this.prefixRepository.restore(prefixId);
    if (!before.zoneId) {
      throw new BadRequestException('Prefix must be assigned to a zone before setting a VRRP VIP');
    }
    // Re-check the zone is live: a soft-deleted zone leaves prefix.zoneId pointing at it, and ensureZone is skipped here (zoneId isn't changing).
    await this.prefixRepository.requireLiveZone(before.zoneId);
    const bridgeIds = bindings.map((binding) => binding.bridgeId);
    if (new Set(bridgeIds).size !== bridgeIds.length) {
      throw new BadRequestException('VRRP bindings must not repeat a bridge');
    }
    await this.prefixRepository.assertBridgesInZone(before.zoneId, bridgeIds);
    const entity = PrefixEntity.restore(before);
    entity.setVrrpVip(vrrpVipId);
    const updated = await this.prefixRepository.updateWithConflictGuard(
      entity,
      before,
      false,
      async (committed, tx) => {
        if (committed.zoneId) {
          await this.prefixRepository.assertBridgesInZone(committed.zoneId, bridgeIds);
        }
        await this.prefixRepository.replacePrefixVrrpBindings(prefixId, bindings, tx);
      },
    );
    if (updated.zoneId) {
      await this.publishVrrpVip(updated.zoneId, prefixId);
    }
    return updated;
  }

  async clearPrefixVrrpVip(prefixId: string): Promise<IpamPrefix> {
    this.contextService.requirePermission('ipam', 'update');
    const before = await this.prefixRepository.restore(prefixId);
    const entity = PrefixEntity.restore(before);
    entity.clearVrrpVip();
    const updated = await this.prefixRepository.persistUnderLock(entity, before, (_updated, tx) =>
      this.prefixRepository.replacePrefixVrrpBindings(prefixId, [], tx),
    );
    if (updated.zoneId) {
      await this.vrrpWriter.clear(updated.zoneId, prefixId);
    }
    return updated;
  }

  async getPrefixVrrpBindings(prefixId: string): Promise<VrrpBinding[]> {
    this.contextService.requirePermission('ipam', 'read');
    await this.prefixRepository.restore(prefixId);
    return this.prefixRepository.listPrefixVrrpBindings(prefixId);
  }

  async clearVrrpVipsForZone(zoneId: string): Promise<void> {
    const prefixIds = await this.prefixRepository.listVrrpVipBearingPrefixIdsInZone(zoneId);
    for (const prefixId of prefixIds) {
      await this.vrrpWriter.clear(zoneId, prefixId);
      let before: IpamPrefix;
      try {
        before = await this.prefixRepository.restore(prefixId);
      } catch (error) {
        if (error instanceof NotFoundException) continue;
        throw error;
      }
      if ((before.zoneId ?? null) !== zoneId) continue;
      const entity = PrefixEntity.restore(before);
      entity.clearVrrpVip();
      await this.prefixRepository.persistUnderLock(entity, before, (_updated, tx) =>
        this.prefixRepository.replacePrefixVrrpBindings(prefixId, [], tx),
      );
    }
  }

  async getDhcpConfig(prefixId: string): Promise<PrefixDhcpConfig> {
    this.contextService.requirePermission('ipam', 'read');
    return this.prefixRepository.getDhcpConfig(prefixId);
  }

  async getDhcpLeases(prefixId: string): Promise<DhcpLease[]> {
    this.contextService.requirePermission('ipam', 'read');
    const prefix = await this.prefixRepository.restore(prefixId);
    if (!prefix.zoneId) return [];
    return this.dhcpLeaseReader.listLeasesForPrefix(prefix.zoneId, prefix.prefix);
  }

  // Read-only, derived purely from IPAM (device MAC → interface IP), so no zone is
  // required — unlike leases. restore() 404s a missing prefix and pins tenant scope.
  async getDhcpReservations(prefixId: string): Promise<DhcpReservation[]> {
    this.contextService.requirePermission('ipam', 'read');
    await this.prefixRepository.restore(prefixId);
    // restore() already 404s a cross-org prefix; pass the org for an explicit defense-in-depth scope.
    return this.dhcpDerivation.listReservationsForPrefix(prefixId, this.contextService.organizationId);
  }

  // VIP (when set) is the sole serving address; otherwise the prefix's bridge NIC IPs.
  // Read-only, derived on demand. restore() 404s a missing prefix and pins tenant scope.
  async getDhcpServing(prefixId: string): Promise<PrefixDhcpServing> {
    this.contextService.requirePermission('ipam', 'read');
    const prefix = await this.prefixRepository.restore(prefixId);

    const { vipAddress, bridgeIps } = await this.prefixRepository.loadDhcpServingAddresses({
      vrrpVipId: prefix.vrrpVipId,
      zoneId: prefix.zoneId,
      vrfId: prefix.vrfId,
      cidr: prefix.prefix,
    });

    // Cap dnsServers at 63: DHCP option 6 is length-prefixed to 255 bytes on the wire
    // (255 / 4 bytes per IPv4 = 63). VIP, when set, is the sole serving address.
    const nextServer = vipAddress ?? bridgeIps[0] ?? null;
    const dnsServers = (vipAddress ? [vipAddress] : bridgeIps).slice(0, MAX_DHCP_DNS_SERVERS);
    return { nextServer, dnsServers };
  }

  async getDnsOverride(prefixId: string): Promise<PrefixDnsOverride> {
    this.contextService.requirePermission('ipam', 'read');
    return this.prefixRepository.getDnsOverride(prefixId);
  }

  async updateDnsOverride(prefixId: string, body: PrefixDnsOverride): Promise<PrefixDnsOverride> {
    this.contextService.requirePermission('ipam', 'update');

    // Force-off (serveDns=false) is still a persisted override, so it serializes with deleteZone
    // like an enable; only the full clear bypasses the lock (tombstoned zone stays clearable).
    const hasDnsOverride = body.serveDns !== null || body.upstreamOverride.length > 0;
    let zoneId: string | null = null;
    if (hasDnsOverride) {
      const prefix = await this.prefixRepository.restore(prefixId);
      if (!prefix.zoneId) {
        throw new BadRequestException(
          'DNS overrides can only be set on a zone-scoped prefix. Assign this prefix to a zone first.',
        );
      }
      zoneId = prefix.zoneId;
      await this.prefixRepository.requireLiveZone(prefix.zoneId);
    }

    const result =
      hasDnsOverride && zoneId !== null
        ? await this.prefixRepository.updateDnsOverrideUnderZoneLock(prefixId, zoneId, body)
        : await this.prefixRepository.updateDnsOverride(prefixId, body);

    const audit = this.contextService.buildAuditPayload();
    this.logger.log(
      `DNS override updated for prefix ${prefixId} | actor=${audit.triggeredByEmail} (${audit.triggeredBy})`,
    );

    await this.dnsPublisher.publishPrefixDnsOverride(prefixId);

    return result;
  }

  async updateDhcpConfig(prefixId: string, input: UpdatePrefixDhcpConfig): Promise<PrefixDhcpConfig> {
    this.contextService.requirePermission('ipam', 'update');
    this.validateDhcpOptions(input.dhcpOptions);

    const prefix = await this.prefixRepository.restore(prefixId);

    // Must mirror DhcpDerivationService.listDhcpEnabledPrefixes eligibility — an ineligible
    // prefix derives to 'disabled' and silently never serves, so reject up front.
    if (input.dhcpMode === 'AUTHORITATIVE' || input.dhcpMode === 'PROXY') {
      if (!prefix.zoneId) {
        throw new BadRequestException(
          'DHCP can only be enabled on a zone-scoped prefix (its config is published per zone). Assign this prefix to a zone first.',
        );
      }
      // Zone tombstones don't null Prefix.zoneId — a dead zone means no bridge ever serves the atom.
      await this.prefixRepository.requireLiveZone(prefix.zoneId);
      if (prefix.role === 'NAT') {
        throw new BadRequestException('DHCP cannot be enabled on a NAT-role prefix.');
      }
      if (!isIPv4(prefix.prefix.split('/')[0] ?? '')) {
        throw new BadRequestException('DHCP can only be enabled on an IPv4 prefix (IPv6 prefixes are not served).');
      }
      if (
        prefix.status === 'ACTIVE' &&
        (await this.prefixRepository.getAssociatedPrefixId(prefixId)) !== null &&
        input.dhcpRelayAgentIp === null
      ) {
        throw new BadRequestException('An active relayed prefix requires a DHCP relay agent IP.');
      }
    }

    // Enable serializes with deleteZone's advisory lock (TOCTOU with its in-tx DHCP count); disable
    // must bypass it — the lock path's requireLiveZone would make a tombstoned zone's stale atom un-disableable.
    const enabling = input.dhcpMode === 'AUTHORITATIVE' || input.dhcpMode === 'PROXY';
    const needsZoneLock = Boolean(prefix.zoneId) && enabling;
    const result = needsZoneLock
      ? await this.prefixRepository.updateDhcpConfigUnderZoneLock(prefixId, prefix.zoneId, input)
      : await this.prefixRepository.updateDhcpConfig(prefixId, input);

    // Non-throwing: a failed publish is healed by the reconcile cron.
    await this.publishOrClearDhcpAtom(prefixId);
    return result;
  }

  // Only an UNSET (null) dhcpMode auto-enables: an operator-set mode (incl. OFF) is never
  // overridden, and a role change away never auto-reverts. Never throws — the prefix write
  // already committed, so a failed auto-enable degrades to the pre-ruling behavior (logged).
  private async autoEnableDhcpForRole(prefix: IpamPrefix, trigger: string): Promise<void> {
    if (!prefix.zoneId) {
      // DHCP eligibility requires a zone (atoms are published per zone) — defer, don't fail.
      this.logger.log(
        `DHCP auto-enable deferred for prefix ${prefix.id} on ${trigger} (role ${prefix.role}): the prefix has no zone; it auto-enables when the prefix is assigned to a zone`,
      );
      return;
    }
    if (!isIPv4(prefix.prefix.split('/')[0] ?? '')) {
      return;
    }
    try {
      const outcome = await this.prefixRepository.autoEnableAuthoritativeDhcp(prefix.id, prefix.zoneId);
      if (outcome === 'already-configured') {
        return;
      }
      if (outcome !== 'enabled') {
        this.logger.warn(
          `DHCP auto-enable skipped for prefix ${prefix.id} on ${trigger} (${outcome}); enable manually via the prefix DHCP config`,
        );
        return;
      }
      const audit = this.contextService.buildAuditPayload();
      this.logger.log(
        `DHCP auto-enabled (AUTHORITATIVE) for prefix ${prefix.id} on ${trigger} (role ${prefix.role}); the bridge serves no leases until the prefix has an ACTIVE IP range | actor=${audit.triggeredByEmail} (${audit.triggeredBy})`,
      );
      // Same eager publish as updateDhcpConfig — non-throwing; the reconcile cron heals a failure.
      await this.publishOrClearDhcpAtom(prefix.id, prefix.zoneId);
    } catch (error) {
      this.logger.warn(
        `DHCP auto-enable failed for prefix ${prefix.id} on ${trigger}; DHCP left unconfigured (enable manually): ${getErrorMessage(error)}`,
      );
    }
  }

  // Returns true when the publish/clear completed, false on 'error' — relocateDhcpAtom gates the old-zone clear on it.
  private async publishOrClearDhcpAtom(prefixId: string, zoneId?: string | null): Promise<boolean> {
    const resolveZoneId =
      zoneId !== undefined ? async () => zoneId : async () => (await this.prefixRepository.restore(prefixId)).zoneId;
    return this.dhcpPublisher.republishOne(prefixId, resolveZoneId);
  }

  // Uniqueness is schema-enforced (UpdatePrefixDhcpConfigSchema.refine).
  private validateDhcpOptions(options: UpdatePrefixDhcpConfig['dhcpOptions']): void {
    for (const option of options) {
      if (RESERVED_DHCP_OPTION_CODES.has(option.code)) {
        const msg = RESERVED_DHCP_OPTIONS[option.code] ?? 'reserved';
        throw new BadRequestException(`DHCP option ${option.code} is ${msg}`);
      }
    }
  }

  async listChildPrefixes(id: string): Promise<IpamPrefix[]> {
    this.contextService.requirePermission('ipam', 'read');
    return this.prefixRepository.listChildPrefixes(id);
  }

  async listIpsInPrefix(id: string): Promise<IpAddress[]> {
    this.contextService.requirePermission('ipam', 'read');
    return this.prefixRepository.listIpsInPrefix(id);
  }

  async getPrefixUtilization(id: string): Promise<PrefixUtilization> {
    this.contextService.requirePermission('ipam', 'read');
    return this.prefixRepository.getPrefixUtilization(id);
  }

  async allocateNextPrefix(parentPrefixId: string, input: AllocateNextPrefixRequest): Promise<IpamPrefix> {
    this.contextService.requirePermission('ipam', 'create');
    return this.prefixRepository.allocateNextPrefix(parentPrefixId, input);
  }

  async detectPrefixOverlap(input: DetectPrefixOverlapRequest): Promise<{
    hasOverlap: boolean;
    conflictingPrefixId: string | null;
    conflictingPrefix: string | null;
  }> {
    return this.prefixRepository.detectPrefixOverlap(input);
  }

  async setPrefixGateway(prefixId: string, gatewayIpId: string): Promise<IpamPrefix> {
    this.contextService.requirePermission('ipam', 'update');
    const before = await this.prefixRepository.restore(prefixId);
    const entity = PrefixEntity.restore(before);
    entity.setGateway(gatewayIpId);
    // updateWithConflictGuard runs ensureGateway inside the locked tx; the Gateway-table sync rides
    // the same tx so Prefix.gatewayIpId and the Gateway row cannot diverge (reconciler writes both).
    let sync: GatewaySyncResult | null = null;
    const updated = await this.prefixRepository.updateWithConflictGuard(entity, before, false, async (u, tx) => {
      sync = await this.prefixRepository.syncGatewayRecordOnSet(prefixId, gatewayIpId, before.gatewayIpId, u.vrfId, tx);
    });
    this.logGatewaySync(prefixId, sync);
    // The gateway feeds the atom's routers[] — republish so the bridge advertises the new
    // default route eagerly instead of waiting for the reconcile cron.
    await this.publishOrClearDhcpAtom(prefixId, updated.zoneId);
    return updated;
  }

  async clearPrefixGateway(prefixId: string): Promise<IpamPrefix> {
    this.contextService.requirePermission('ipam', 'update');
    const before = await this.prefixRepository.restore(prefixId);
    const entity = PrefixEntity.restore(before);
    entity.clearGateway();
    let sync: GatewaySyncResult | null = null;
    const updated = await this.prefixRepository.persistUnderLock(entity, before, async (_updated, tx) => {
      sync = await this.prefixRepository.syncGatewayRecordOnClear(prefixId, before.gatewayIpId, tx);
    });
    this.logGatewaySync(prefixId, sync);
    await this.publishOrClearDhcpAtom(prefixId, updated.zoneId);
    return updated;
  }

  private logGatewaySync(prefixId: string, sync: GatewaySyncResult | null): void {
    if (sync?.customRowPreserved) {
      this.logger.log(
        `Prefix ${prefixId} gateway sync: operator-customized gateway row (non-default routingPriority) preserved`,
      );
    }
  }

  async validatePrefixGatewayRequest(input: ValidatePrefixGatewayRequest): Promise<ValidatePrefixGatewayResult> {
    return this.prefixRepository.validatePrefixGatewayRequest(input);
  }
}
