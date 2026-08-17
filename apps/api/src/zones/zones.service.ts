import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ActiveRecordRegistry } from '@repo/active-record';
import {
  type CreateZoneRequest,
  type ZoneAddressInput,
  type ZoneBridge,
  type ZoneContactInput,
  type ZoneDhcpPrefixSummary,
  ZoneDhcpPrefixSummarySchema,
  type ZoneVrrpPrefixSummary,
  ZoneVrrpPrefixSummarySchema,
} from '@repo/api-client';
import { paginateArray, type PaginationQuery } from '@repo/database/pagination';
import { toZoneAddressData } from '@repo/utils';
import Redis from 'ioredis';
import { DnsConfigPublisherService } from 'src/brokkr-bridge/dns/dns-config-publisher.service';
import { DnsRecordsPublisherService } from 'src/brokkr-bridge/dns/dns-records-publisher.service';
import { ContextService } from 'src/common/context/context.service';
import { Logger } from 'src/common/decorators/logger.decorator';
import { getErrorMessage } from 'src/common/error-utils';
import { REDIS_CLIENT } from 'src/common/redis';
import { type BridgePresence, lookupBridgePresence, OFFLINE_PRESENCE } from 'src/dcim-bridges/bridge-presence.overlay';
import { PrefixService } from 'src/ipam/prefix/prefix.service';
import { LoggerService } from 'src/logger/logger.service';
import { PrismaClient } from 'src/prisma/prisma.client';
import { RegionAssignmentService } from 'src/regions/region-assignment.service';
import { type BridgeZoneAdapterRow, getBridgesInZoneFromPrisma } from 'src/zones/bridge-zone-adapter';
import { type ZoneRedisAclCredential, ZoneRedisAclService } from './zone-redis-acl.service';
import { zoneAclLockKey } from './zone-redis-acl.util';
import { generateZoneId, isUuidSuffixConflict, MAX_UUID_SUFFIX_ATTEMPTS } from './zone-uuid';
import { ZoneRecord } from './zone.record';
import { zonesPaginationConfig } from './zones.pagination';

// Explicitly select ZoneContactSchema fields to prevent Contact-table PII leaks.
const ZONE_CONTACT_SELECT = {
  id: true,
  name: true,
  title: true,
  email: true,
  phone: true,
  contactType: true,
  isShippingContact: true,
  createdAt: true,
  updatedAt: true,
} as const;

@Injectable()
export class ZonesService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly contextService: ContextService,
    private readonly regionAssignment: RegionAssignmentService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Logger(ZonesService.name) private readonly logger: LoggerService,
    private readonly zoneRedisAcl: ZoneRedisAclService,
    private readonly prefixService: PrefixService,
    private readonly dnsPublisher: DnsConfigPublisherService,
    private readonly dnsRecordsPublisher: DnsRecordsPublisherService,
  ) {}

  async getZones() {
    const zones = await ZoneRecord.findAllActive();
    return zones.map((zone) => zone.toListItem());
  }

  async getZonesPaginated(query: PaginationQuery) {
    const zones = await this.getZones();
    return paginateArray(zones, query, zonesPaginationConfig);
  }

  async getZoneById(zoneId: string) {
    const zone = await ZoneRecord.findFullActiveById(zoneId);
    if (!zone) {
      throw new NotFoundException('Zone not found');
    }

    const bridges = await this.getBridgesInZone(zone.data.id);
    return zone.toResponse(bridges);
  }

  async createZone(dto: CreateZoneRequest) {
    // uuidSuffix (last 5 chars, used for device names) must be unique; the DB index is the race-safe guarantee — regenerate on P2002.
    for (let attempt = 1; attempt <= MAX_UUID_SUFFIX_ATTEMPTS; attempt++) {
      const { id } = generateZoneId();
      const zone = ZoneRecord.fromCreateRequest(dto, id);

      // Provisioned BEFORE the persist and compensated (DELUSER) on failure; the plaintext is returned exactly once and never stored.
      let redisCredential: ZoneRedisAclCredential | undefined;
      if (this.zoneRedisAcl.enabled) {
        redisCredential = await this.zoneRedisAcl.provisionUser(id);
      }

      try {
        await this.persistNewZone(zone, dto, redisCredential?.passwordHash);

        await this.regionAssignment.assignZoneSafe(zone.data.id);

        const audit = this.contextService.buildAuditPayload();
        this.logger.log(
          `Zone "${dto.name}" (${zone.data.id}) created | actor=${audit.triggeredByEmail} (${audit.triggeredBy})`,
        );

        return {
          id: zone.data.id,
          name: zone.data.name,
          ...(redisCredential && {
            redisCredential: { username: redisCredential.username, password: redisCredential.password },
          }),
        };
      } catch (error) {
        if (redisCredential) {
          await this.compensateRedisAclUser(id);
        }
        if (isUuidSuffixConflict(error)) {
          this.logger.warn(`Zone uuidSuffix collision on attempt ${attempt}; regenerating id`);
          continue;
        }
        throw error;
      }
    }

    throw new ConflictException('Could not allocate a unique zone identifier; please retry');
  }

  // Never throws — the original persist error must surface; a leaked user is swept by the startup reconcile.
  private async compensateRedisAclUser(zoneId: string) {
    try {
      await this.zoneRedisAcl.deleteUser(zoneId);
    } catch (error) {
      this.logger.error(
        `Failed to clean up Redis ACL user after zone create failure (zone=${zoneId}): ${getErrorMessage(error)}`,
      );
    }
  }

  private async persistNewZone(zone: ZoneRecord, dto: CreateZoneRequest, redisPasswordHash?: string) {
    await ActiveRecordRegistry.transaction(async (tx) => {
      await zone.save({ tx });

      if (redisPasswordHash !== undefined) {
        await tx.zoneRedisCredential.create({
          data: { zoneId: zone.data.id, passwordHash: redisPasswordHash },
        });
      }

      await tx.zoneAddress.create({
        data: {
          type: 'PRIMARY',
          zone: { connect: { id: zone.data.id } },
          ...toZoneAddressData(dto.primaryAddress),
        },
      });

      if (dto.shippingAddress) {
        await tx.zoneAddress.create({
          data: {
            type: 'SHIPPING',
            zone: { connect: { id: zone.data.id } },
            ...toZoneAddressData(dto.shippingAddress),
          },
        });
      }

      for (const contact of dto.contacts) {
        await tx.contact.create({
          data: {
            zone: { connect: { id: zone.data.id } },
            name: contact.name,
            title: contact.title,
            email: contact.email,
            phone: contact.phone,
            contactType: contact.contactType,
            isShippingContact: contact.isShippingContact,
          },
        });
      }
    });
  }

  async updateName(zoneId: string, name: string) {
    const zone = await ZoneRecord.findActiveById(zoneId);
    if (!zone) {
      throw new NotFoundException('Zone not found');
    }

    zone.rename(name);
    await zone.save();

    return this.getZoneById(zoneId);
  }

  async updatePrimaryAddress(zoneId: string, address: ZoneAddressInput) {
    this.contextService.requirePermission('zone', 'update');
    const zone = await ZoneRecord.findActiveById(zoneId);
    if (!zone) {
      throw new NotFoundException('Zone not found');
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.zoneAddress.updateMany({
        where: { zoneId: zone.data.id, type: 'PRIMARY', deletedAt: null },
        data: { deletedAt: new Date() },
      });

      await tx.zoneAddress.create({
        data: {
          type: 'PRIMARY',
          zone: { connect: { id: zone.data.id } },
          ...toZoneAddressData(address),
        },
      });
    });

    await this.regionAssignment.assignZoneSafe(zoneId);

    return this.getZoneById(zoneId);
  }

  async updateShippingAddress(zoneId: string, address: ZoneAddressInput) {
    this.contextService.requirePermission('zone', 'update');
    const zone = await ZoneRecord.findActiveById(zoneId);
    if (!zone) {
      throw new NotFoundException('Zone not found');
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.zoneAddress.updateMany({
        where: { zoneId: zone.data.id, type: 'SHIPPING', deletedAt: null },
        data: { deletedAt: new Date() },
      });

      await tx.zoneAddress.create({
        data: {
          type: 'SHIPPING',
          zone: { connect: { id: zone.data.id } },
          ...toZoneAddressData(address),
        },
      });
    });

    return this.getZoneById(zoneId);
  }

  async deleteZone(zoneId: string) {
    // Authz FIRST: the record-layer check on zone.delete() fires only after the VRRP/DELUSER side effects below — an under-privileged caller must 403 before any damage.
    this.contextService.requirePermission('zone', 'delete');

    const zone = await ZoneRecord.findActiveById(zoneId);
    if (!zone) {
      throw new NotFoundException('Zone not found');
    }

    // Fail fast BEFORE any side effect; the in-tx recount below is the TOCTOU backstop.
    const earlyDhcpCount = await this.prisma.prefix.count({
      where: { zoneId, deletedAt: null, dhcpMode: { notIn: ['OFF'] } },
    });
    if (earlyDhcpCount > 0) {
      throw new BadRequestException(
        `Cannot delete zone: ${earlyDhcpCount} prefix(es) still have DHCP enabled. Disable DHCP on all prefixes first.`,
      );
    }

    // Revocation is keyed off the credential ROW (not the feature flag) and runs under the same per-zone advisory lock as rotateCredential; the lookup MUST stay inside the locked window or a rotate could recreate the user after an unlocked lookup returned null.
    let revokedHash: string | null = null;
    try {
      await ActiveRecordRegistry.transaction(async (tx) => {
        const lockKey = zoneAclLockKey(zoneId);
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;

        const dhcpPrefixCount = await tx.prefix.count({
          where: {
            zoneId,
            deletedAt: null,
            dhcpMode: { notIn: ['OFF'] },
          },
        });
        if (dhcpPrefixCount > 0) {
          throw new BadRequestException(
            `Cannot delete zone: ${dhcpPrefixCount} prefix(es) still have DHCP enabled. Disable DHCP on all prefixes first.`,
          );
        }

        // Clear surviving per-prefix overrides so reassignment cannot republish stale DNS.
        await tx.prefix.updateMany({
          where: { zoneId, deletedAt: null },
          data: { dnsServeDns: null, dnsUpstreamOverride: [] },
        });

        const credential = await tx.zoneRedisCredential.findUnique({ where: { zoneId } });
        if (credential) {
          await this.zoneRedisAcl.deleteUser(zoneId);
          revokedHash = credential.passwordHash;
          await tx.zoneRedisCredential.deleteMany({ where: { zoneId } });
        }
        const now = new Date();
        await tx.dnsRecord.updateMany({
          where: {
            domain: { zoneId, deletedAt: null },
            deletedAt: null,
          },
          data: { deletedAt: now },
        });
        await tx.dnsDomain.updateMany({
          where: { zoneId, deletedAt: null },
          data: { deletedAt: now },
        });

        await zone.delete({ tx });
      });
    } catch (error) {
      if (revokedHash !== null) {
        await this.zoneRedisAcl.convergeUserToDb(zoneId, revokedHash, 'delete');
      }
      throw error;
    }

    // Audit immediately after the commit — a post-commit VIP-teardown throw must not skip the tombstone record.
    const audit = this.contextService.buildAuditPayload();
    this.logger.log(
      `Zone "${zone.data.name}" (${zoneId}) soft-deleted | actor=${audit.triggeredByEmail} (${audit.triggeredBy})`,
    );

    // Best-effort: the zone is already soft-deleted, so a transient failure here must not 500 the
    // caller. Later reconciliation heals cleanup failures.
    try {
      await this.dnsPublisher.clearZoneDnsConfig(zoneId);
      await this.dnsRecordsPublisher.republishForZone(zoneId);
      await this.prefixService.clearVrrpVipsForZone(zoneId);
    } catch (error) {
      this.logger.warn(
        `Post-delete cleanup for zone ${zoneId} failed (reconciler will heal): ${getErrorMessage(error)}`,
      );
    }

    return { success: true };
  }

  async getContactsPaginated(zoneId: string, query: PaginationQuery) {
    await this.requireZoneOwnership(zoneId);

    const contacts = await this.prisma.contact.findMany({
      where: { zoneId, deletedAt: null },
      orderBy: { createdAt: 'asc' },
      select: ZONE_CONTACT_SELECT,
    });

    return paginateArray(contacts, query, {
      searchableFields: ['name', 'email', 'phone'],
      sortableFields: { name: 'name', email: 'email', contactType: 'contactType', createdAt: 'createdAt' },
      defaultSort: [{ field: 'createdAt', direction: 'asc' }],
    });
  }

  async getContact(zoneId: string, contactId: string) {
    await this.requireZoneOwnership(zoneId);

    const contact = await this.prisma.contact.findUnique({
      where: { id: contactId, zoneId, deletedAt: null },
      select: ZONE_CONTACT_SELECT,
    });

    if (!contact) {
      throw new NotFoundException('Contact not found');
    }

    return contact;
  }

  async createContact(zoneId: string, dto: ZoneContactInput) {
    this.contextService.requirePermission('zone', 'update');
    await this.requireZoneOwnership(zoneId);

    if (dto.isShippingContact) {
      await this.ensureUniqueShippingContact(zoneId);
    }

    return this.prisma.contact.create({
      data: {
        zone: { connect: { id: zoneId } },
        name: dto.name,
        title: dto.title,
        email: dto.email,
        phone: dto.phone,
        contactType: dto.contactType,
        isShippingContact: dto.isShippingContact,
      },
      select: ZONE_CONTACT_SELECT,
    });
  }

  async updateContact(zoneId: string, contactId: string, dto: ZoneContactInput) {
    this.contextService.requirePermission('zone', 'update');
    await this.requireZoneOwnership(zoneId);

    const existing = await this.prisma.contact.findUnique({
      where: { id: contactId, zoneId, deletedAt: null },
    });

    if (!existing) {
      throw new NotFoundException('Contact not found');
    }

    if (dto.isShippingContact) {
      await this.ensureUniqueShippingContact(zoneId, contactId);
    }

    return this.prisma.contact.update({
      where: { id: contactId },
      data: {
        name: dto.name,
        title: dto.title,
        email: dto.email,
        phone: dto.phone,
        contactType: dto.contactType,
        isShippingContact: dto.isShippingContact,
      },
      select: ZONE_CONTACT_SELECT,
    });
  }

  async deleteContact(zoneId: string, contactId: string) {
    this.contextService.requirePermission('zone', 'update');
    await this.requireZoneOwnership(zoneId);

    const existing = await this.prisma.contact.findUnique({
      where: { id: contactId, zoneId, deletedAt: null },
    });

    if (!existing) {
      throw new NotFoundException('Contact not found');
    }

    // Contact.type is nullable in the shared table, so don't group null contacts together.
    if (existing.contactType) {
      const remainingOfType = await this.prisma.contact.count({
        where: {
          zoneId,
          contactType: existing.contactType,
          deletedAt: null,
          id: { not: contactId },
        },
      });

      if (remainingOfType === 0) {
        throw new BadRequestException(`Cannot delete the last ${existing.contactType} contact`);
      }
    }

    await this.prisma.contact.update({
      where: { id: contactId },
      data: { deletedAt: new Date() },
    });

    const audit = this.contextService.buildAuditPayload();
    this.logger.log(
      `Zone contact "${existing.name}" (${contactId}) soft-deleted from zone ${zoneId} | actor=${audit.triggeredByEmail} (${audit.triggeredBy})`,
    );

    return { success: true };
  }

  private async ensureUniqueShippingContact(zoneId: string, excludeId?: string) {
    const existingShipping = await this.prisma.contact.findFirst({
      where: {
        zoneId,
        isShippingContact: true,
        deletedAt: null,
        ...(excludeId && { id: { not: excludeId } }),
      },
    });

    if (existingShipping) {
      await this.prisma.contact.update({
        where: { id: existingShipping.id },
        data: { isShippingContact: false },
      });
    }
  }

  async getDhcpPrefixSummary(zoneId: string): Promise<ZoneDhcpPrefixSummary[]> {
    await this.requireZoneOwnership(zoneId);

    const rows = await this.prisma.$queryRaw<
      Array<{
        prefixId: string;
        cidr: string;
        role: string | null;
        dhcpMode: string | null;
      }>
    >`
      SELECT
        p.id        AS "prefixId",
        p.prefix::text AS cidr,
        p.role,
        p."dhcpMode"
      FROM "Prefix" p
      WHERE p."zoneId" = ${zoneId}
        AND p."organizationId" = ${this.contextService.organizationId}
        AND p."deletedAt" IS NULL
      ORDER BY p.prefix
    `;

    const summaries: ZoneDhcpPrefixSummary[] = [];
    for (const row of rows) {
      // Skip malformed rows so one bad prefix cannot fail the summary.
      const parsed = ZoneDhcpPrefixSummarySchema.safeParse({
        prefixId: row.prefixId,
        cidr: row.cidr,
        role: row.role,
        dhcpMode: row.dhcpMode,
        dhcpEligible: !row.cidr.includes(':') && row.role !== 'NAT',
      });
      if (parsed.success) {
        summaries.push(parsed.data);
      } else {
        this.logger.warn(`Skipping malformed DHCP prefix summary row ${row.prefixId}: ${parsed.error.message}`);
      }
    }
    return summaries;
  }

  async getVrrpPrefixSummary(zoneId: string): Promise<ZoneVrrpPrefixSummary[]> {
    await this.requireZoneOwnership(zoneId);

    const rows = await this.prisma.$queryRaw<
      Array<{
        prefixId: string;
        cidr: string;
        role: string | null;
        vip: string | null;
        ifaceByBridge: Record<string, string>;
      }>
    >`
      SELECT
        p.id AS "prefixId",
        p.prefix::text AS cidr,
        p.role,
        CASE WHEN ip.address IS NOT NULL
          THEN host(ip.address) || '/' || masklen(p.prefix)::text
          ELSE NULL
        END AS vip,
        COALESCE(
          jsonb_object_agg(d.name, b.iface) FILTER (WHERE d.name IS NOT NULL),
          '{}'::jsonb
        ) AS "ifaceByBridge"
      FROM "Prefix" p
      LEFT JOIN "IpAddress" ip ON ip.id = p."vrrpVipId" AND ip."deletedAt" IS NULL
      LEFT JOIN "PrefixVrrpBinding" b ON b."prefixId" = p.id
      LEFT JOIN "Device" d ON d.id = b."bridgeId" AND d."deletedAt" IS NULL
      WHERE p."zoneId" = ${zoneId}
        AND p."organizationId" = ${this.contextService.organizationId}
        AND p."vrrpVipId" IS NOT NULL
        AND p."deletedAt" IS NULL
      GROUP BY p.id, p.prefix, p.role, ip.address
      ORDER BY p.prefix
    `;

    const summaries: ZoneVrrpPrefixSummary[] = [];
    for (const row of rows) {
      const parsed = ZoneVrrpPrefixSummarySchema.safeParse(row);
      if (parsed.success) {
        summaries.push(parsed.data);
      } else {
        this.logger.warn(`Skipping malformed VRRP prefix summary row ${row.prefixId}: ${parsed.error.message}`);
      }
    }
    return summaries;
  }

  private async requireZoneOwnership(zoneId: string) {
    const zone = await ZoneRecord.findActiveById(zoneId);
    if (!zone) {
      throw new NotFoundException('Zone not found');
    }
    return zone;
  }

  private async getBridgesInZone(zoneId: string | null): Promise<ZoneBridge[]> {
    if (!zoneId) return [];

    let devices: BridgeZoneAdapterRow[];
    try {
      devices = await getBridgesInZoneFromPrisma(this.prisma, zoneId);
    } catch {
      return [];
    }

    let presence = new Map<string, BridgePresence>();
    try {
      presence = await lookupBridgePresence(
        this.redis,
        devices.map((d) => ({ id: d.id, zoneId, name: d.display })),
      );
    } catch (error) {
      this.logger.warn(`Failed to look up bridge presence (zone=${zoneId}): ${getErrorMessage(error)}`);
    }

    return devices.map((d) => {
      const p = presence.get(d.id) ?? OFFLINE_PRESENCE;
      return { id: d.id, name: d.display, online: p.online, is_leader: p.isLeader };
    });
  }
}
