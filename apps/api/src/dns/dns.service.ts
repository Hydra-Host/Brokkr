import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type {
  CreateDnsDomain,
  CreateDnsRecord,
  DnsRecordListQuery,
  UpdateDnsDomain,
  UpdateDnsRecord,
} from '@repo/api-client';
import { validateDnsRecordName, validateDnsRecordValue } from '@repo/api-client';
import { Prisma } from '@repo/database';
import { DnsRecordsPublisherService } from 'src/brokkr-bridge/dns/dns-records-publisher.service';
import { ContextService } from 'src/common/context/context.service';
import { Logger } from 'src/common/decorators/logger.decorator';
import { requireZoneOwnership } from 'src/common/zone-ownership';
import { LoggerService } from 'src/logger/logger.service';
import { PrismaClient } from 'src/prisma/prisma.client';
import { z } from 'zod';

@Injectable()
export class DnsService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly contextService: ContextService,
    private readonly publisher: DnsRecordsPublisherService,
    @Logger(DnsService.name) private readonly logger: LoggerService,
  ) {}

  async listDomains(zoneId: string) {
    this.contextService.requirePermission('zone', 'read');
    await this.requireZone(zoneId);
    return this.prisma.dnsDomain.findMany({
      where: { zoneId, deletedAt: null },
      orderBy: { name: 'asc' },
    });
  }

  async getDomain(zoneId: string, domainId: string) {
    this.contextService.requirePermission('zone', 'read');
    await this.requireZone(zoneId);
    const domain = await this.prisma.dnsDomain.findUnique({
      where: { id: domainId },
    });
    if (!domain || domain.deletedAt || domain.zoneId !== zoneId) {
      throw new NotFoundException('DNS domain not found');
    }
    return domain;
  }

  async createDomain(zoneId: string, dto: CreateDnsDomain) {
    this.contextService.requirePermission('zone', 'update');
    await this.requireZone(zoneId);
    try {
      const domain = await this.prisma.dnsDomain.create({
        data: {
          // FQDN trailing dots are valid input but never appear in parsed queries — store the
          // canonical dot-less form or authoritative lookups on the bridge can never match.
          name: dto.name.replace(/\.$/, ''),
          type: dto.type,
          zoneId,
        },
      });
      await this.publisher.republishForZone(zoneId);
      return domain;
    } catch (error) {
      throwIfUniqueViolation(error, 'A domain with this name already exists in this zone');
      throw error;
    }
  }

  async updateDomain(zoneId: string, domainId: string, dto: UpdateDnsDomain) {
    this.contextService.requirePermission('zone', 'update');
    const domain = await this.getDomain(zoneId, domainId);
    try {
      const updated = await this.prisma.dnsDomain.update({
        where: { id: domain.id },
        data: { name: dto.name.replace(/\.$/, '') },
      });
      await this.publisher.republishForZone(zoneId);
      return updated;
    } catch (error) {
      throwIfUniqueViolation(error, 'A domain with this name already exists in this zone');
      throw error;
    }
  }

  async deleteDomain(zoneId: string, domainId: string) {
    this.contextService.requirePermission('zone', 'update');
    const domain = await this.getDomain(zoneId, domainId);
    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.dnsDomain.update({
        where: { id: domain.id },
        data: { deletedAt: now },
      }),
      this.prisma.dnsRecord.updateMany({
        where: { domainId: domain.id, deletedAt: null },
        data: { deletedAt: now },
      }),
    ]);
    // Audit BEFORE the publish: a republish failure must never lose the record of a completed delete.
    const audit = this.contextService.buildAuditPayload();
    this.logger.log(
      `DNS domain "${domain.name}" (${domain.id}) deleted from zone ${zoneId} | actor=${audit.triggeredByEmail} (${audit.triggeredBy})`,
    );
    await this.publisher.republishForZone(zoneId);
  }

  async listRecords(zoneId: string, domainId: string, query: DnsRecordListQuery) {
    this.contextService.requirePermission('zone', 'read');
    await this.getDomain(zoneId, domainId);
    const records = await this.prisma.dnsRecord.findMany({
      where: {
        domainId,
        deletedAt: null,
        ...(query.source ? { source: query.source } : {}),
      },
      include: { device: { select: { role: true } } },
      orderBy: [{ name: 'asc' }, { type: 'asc' }],
    });
    return records.map(({ device, ...record }) => ({ ...record, deviceRole: device?.role ?? null }));
  }

  async createRecord(zoneId: string, domainId: string, dto: CreateDnsRecord) {
    this.contextService.requirePermission('zone', 'update');
    await this.getDomain(zoneId, domainId);

    // Live row first: after a manual soft-delete, derivation can add a live AUTO twin beside the tombstone
    // (partial unique index) — reviving the tombstone would collide, so pin the live row instead.
    const existing = await this.prisma.dnsRecord.findFirst({
      where: {
        domainId,
        name: dto.name,
        type: dto.type,
        value: dto.value,
      },
      orderBy: { deletedAt: { sort: 'asc', nulls: 'first' } },
    });

    // A live AUTO twin is not a conflict: creating the same record manually pins it MANUAL
    // (derivation yields to MANUAL on name+type). Only a live MANUAL duplicate rejects.
    if (existing && !existing.deletedAt && existing.source === 'MANUAL') {
      throw new ConflictException('A record with this name, type, and value already exists');
    }

    try {
      const record = existing
        ? await this.prisma.dnsRecord.update({
            where: { id: existing.id },
            data: {
              deletedAt: null,
              ttlOverride: dto.ttlOverride ?? null,
              source: 'MANUAL',
              deviceId: null,
              ipAddressId: null,
            },
          })
        : await this.prisma.dnsRecord.create({
            data: {
              domainId,
              name: dto.name,
              type: dto.type,
              value: dto.value,
              ttlOverride: dto.ttlOverride ?? null,
              source: 'MANUAL',
            },
          });

      await this.publisher.republishForZone(zoneId);
      return { ...record, deviceRole: null };
    } catch (error) {
      throwIfUniqueViolation(error, 'A record with this name, type, and value already exists');
      throw error;
    }
  }

  async updateRecord(zoneId: string, domainId: string, recordId: string, dto: UpdateDnsRecord) {
    this.contextService.requirePermission('zone', 'update');
    const record = await this.findManualRecord(zoneId, domainId, recordId);
    if (dto.name !== undefined) {
      const name = dto.name;
      runRefinement((ctx) => validateDnsRecordName(record.type, name, ctx));
    }
    if (dto.value !== undefined) {
      const value = dto.value;
      runRefinement((ctx) => validateDnsRecordValue(record.type, value, ctx));
    }
    try {
      const updated = await this.prisma.dnsRecord.update({
        where: { id: record.id },
        data: {
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.value !== undefined ? { value: dto.value } : {}),
          ...(dto.ttlOverride !== undefined ? { ttlOverride: dto.ttlOverride } : {}),
        },
      });
      await this.publisher.republishForZone(zoneId);
      return { ...updated, deviceRole: null };
    } catch (error) {
      throwIfUniqueViolation(error, 'A record with this name, type, and value already exists');
      throw error;
    }
  }

  async deleteRecord(zoneId: string, domainId: string, recordId: string) {
    this.contextService.requirePermission('zone', 'update');
    const record = await this.findManualRecord(zoneId, domainId, recordId);
    await this.prisma.dnsRecord.update({
      where: { id: record.id },
      data: { deletedAt: new Date() },
    });
    // Audit BEFORE the publish: a republish failure must never lose the record of a completed delete.
    const audit = this.contextService.buildAuditPayload();
    this.logger.log(
      `DNS record "${record.name}" (${record.id}) deleted from domain ${domainId} | actor=${audit.triggeredByEmail} (${audit.triggeredBy})`,
    );
    await this.publisher.republishForZone(zoneId);
  }

  private async findManualRecord(zoneId: string, domainId: string, recordId: string) {
    await this.getDomain(zoneId, domainId);
    const record = await this.prisma.dnsRecord.findUnique({
      where: { id: recordId },
    });
    if (!record || record.deletedAt || record.domainId !== domainId) {
      throw new NotFoundException('DNS record not found');
    }
    if (record.source !== 'MANUAL') {
      throw new BadRequestException('Only manual DNS records can be modified');
    }
    return record;
  }

  private async requireZone(zoneId: string) {
    return requireZoneOwnership(this.prisma, zoneId, this.contextService.organizationId);
  }
}

function throwIfUniqueViolation(error: unknown, message: string): void {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    throw new ConflictException(message);
  }
}

function runRefinement(fn: (ctx: z.RefinementCtx) => void): void {
  const issues: z.IssueData[] = [];
  fn({ addIssue: (issue) => issues.push(issue), path: [] });
  if (issues.length > 0) throw new BadRequestException(issues[0].message);
}
