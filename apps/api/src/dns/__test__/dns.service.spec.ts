import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@repo/database';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DnsService } from '../dns.service';

function p2002() {
  return new Prisma.PrismaClientKnownRequestError('unique', {
    code: 'P2002',
    clientVersion: 't',
  });
}

function makeService() {
  const context = {
    organizationId: 'org-1',
    requirePermission: vi.fn(),
    buildAuditPayload: vi.fn().mockReturnValue({ triggeredBy: 'u1', triggeredByEmail: 'a@example.com' }),
  };
  const publisher = {
    republishForZone: vi.fn().mockResolvedValue(undefined),
  };
  const zone = { id: 'zone-1', organizationId: 'org-1', deletedAt: null };
  const domain = {
    id: 'dom-1',
    name: 'lan',
    type: 'FORWARD',
    zoneId: 'zone-1',
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const record = {
    id: 'rec-1',
    name: 'host1',
    type: 'A',
    value: '10.0.0.1',
    source: 'MANUAL',
    ttlOverride: null,
    domainId: 'dom-1',
    deviceId: null,
    ipAddressId: null,
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const prisma = {
    zone: {
      findUnique: vi.fn().mockResolvedValue(zone),
    },
    dnsDomain: {
      findMany: vi.fn().mockResolvedValue([domain]),
      findUnique: vi.fn().mockResolvedValue(domain),
      create: vi.fn().mockResolvedValue(domain),
      update: vi.fn().mockResolvedValue(domain),
      delete: vi.fn().mockResolvedValue(domain),
    },
    dnsRecord: {
      findMany: vi.fn().mockResolvedValue([record]),
      findUnique: vi.fn().mockResolvedValue(record),
      findFirst: vi.fn().mockResolvedValue(record),
      create: vi.fn().mockResolvedValue(record),
      update: vi.fn().mockResolvedValue(record),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    $transaction: vi.fn().mockImplementation((ops: Promise<unknown>[]) => Promise.all(ops)),
  };
  const logger = { log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const service = new DnsService(prisma as never, context as never, publisher as never, logger as never);
  return { service, prisma, publisher, context, logger };
}

describe('DnsService', () => {
  let svc: ReturnType<typeof makeService>;

  beforeEach(() => {
    svc = makeService();
  });

  describe('listDomains', () => {
    it('returns domains for a zone', async () => {
      const result = await svc.service.listDomains('zone-1');
      expect(result).toHaveLength(1);
      expect(svc.prisma.dnsDomain.findMany).toHaveBeenCalledWith({
        where: { zoneId: 'zone-1', deletedAt: null },
        orderBy: { name: 'asc' },
      });
    });

    it('throws NotFoundException when zone does not exist', async () => {
      svc.prisma.zone.findUnique.mockResolvedValue(null);
      await expect(svc.service.listDomains('gone')).rejects.toThrow(NotFoundException);
    });

    it('throws NotFoundException when zone belongs to another org', async () => {
      svc.prisma.zone.findUnique.mockResolvedValue({
        id: 'zone-1',
        organizationId: 'other-org',
        deletedAt: null,
      });
      await expect(svc.service.listDomains('zone-1')).rejects.toThrow(NotFoundException);
    });

    it('throws NotFoundException when zone is soft-deleted', async () => {
      svc.prisma.zone.findUnique.mockResolvedValue({
        id: 'zone-1',
        organizationId: 'org-1',
        deletedAt: new Date(),
      });
      await expect(svc.service.listDomains('zone-1')).rejects.toThrow(NotFoundException);
    });
  });

  describe('getDomain', () => {
    it('returns the domain', async () => {
      const result = await svc.service.getDomain('zone-1', 'dom-1');
      expect(result.id).toBe('dom-1');
    });

    it('throws NotFoundException when domain is soft-deleted', async () => {
      svc.prisma.dnsDomain.findUnique.mockResolvedValue({
        id: 'dom-1',
        zoneId: 'zone-1',
        deletedAt: new Date(),
      });
      await expect(svc.service.getDomain('zone-1', 'dom-1')).rejects.toThrow(NotFoundException);
    });

    it('throws NotFoundException when domain belongs to a different zone', async () => {
      svc.prisma.dnsDomain.findUnique.mockResolvedValue({
        id: 'dom-1',
        zoneId: 'other-zone',
        deletedAt: null,
      });
      await expect(svc.service.getDomain('zone-1', 'dom-1')).rejects.toThrow(NotFoundException);
    });

    it('throws NotFoundException when domain does not exist', async () => {
      svc.prisma.dnsDomain.findUnique.mockResolvedValue(null);
      await expect(svc.service.getDomain('zone-1', 'missing')).rejects.toThrow(NotFoundException);
    });
  });

  describe('createDomain', () => {
    it('creates a domain and republishes', async () => {
      const result = await svc.service.createDomain('zone-1', { name: 'test.lan', type: 'FORWARD' });
      expect(result.id).toBe('dom-1');
      expect(svc.prisma.dnsDomain.create).toHaveBeenCalledWith({
        data: { name: 'test.lan', type: 'FORWARD', zoneId: 'zone-1' },
      });
      expect(svc.publisher.republishForZone).toHaveBeenCalledWith('zone-1');
    });

    it('throws ConflictException on duplicate name', async () => {
      svc.prisma.dnsDomain.create.mockRejectedValue(p2002());
      await expect(svc.service.createDomain('zone-1', { name: 'dup', type: 'FORWARD' })).rejects.toThrow(
        ConflictException,
      );
    });

    it('validates zone scoping before creating', async () => {
      svc.prisma.zone.findUnique.mockResolvedValue(null);
      await expect(svc.service.createDomain('zone-1', { name: 'test', type: 'FORWARD' })).rejects.toThrow(
        NotFoundException,
      );
      expect(svc.prisma.dnsDomain.create).not.toHaveBeenCalled();
    });
  });

  describe('updateDomain', () => {
    it('updates domain name and republishes', async () => {
      svc.prisma.dnsDomain.update.mockResolvedValue({ ...svc.prisma.dnsDomain.findUnique(), name: 'new-name' });
      await svc.service.updateDomain('zone-1', 'dom-1', { name: 'new-name' });
      expect(svc.prisma.dnsDomain.update).toHaveBeenCalledWith({
        where: { id: 'dom-1' },
        data: { name: 'new-name' },
      });
      expect(svc.publisher.republishForZone).toHaveBeenCalledWith('zone-1');
    });

    it('throws ConflictException on duplicate name', async () => {
      svc.prisma.dnsDomain.update.mockRejectedValue(p2002());
      await expect(svc.service.updateDomain('zone-1', 'dom-1', { name: 'dup' })).rejects.toThrow(ConflictException);
    });
  });

  describe('deleteDomain', () => {
    it('soft-deletes domain and its records then republishes', async () => {
      await svc.service.deleteDomain('zone-1', 'dom-1');
      expect(svc.prisma.$transaction).toHaveBeenCalledWith([expect.anything(), expect.anything()]);
      expect(svc.prisma.dnsDomain.update).toHaveBeenCalledWith({
        where: { id: 'dom-1' },
        data: { deletedAt: expect.any(Date) },
      });
      expect(svc.prisma.dnsRecord.updateMany).toHaveBeenCalledWith({
        where: { domainId: 'dom-1', deletedAt: null },
        data: { deletedAt: expect.any(Date) },
      });
      expect(svc.publisher.republishForZone).toHaveBeenCalledWith('zone-1');
    });

    it('logs an audit trail', async () => {
      await svc.service.deleteDomain('zone-1', 'dom-1');
      expect(svc.context.buildAuditPayload).toHaveBeenCalled();
      expect(svc.logger.log).toHaveBeenCalledWith(expect.stringContaining('dom-1'));
    });

    it('logs the audit even when republish fails', async () => {
      svc.publisher.republishForZone.mockRejectedValue(new Error('redis down'));
      await expect(svc.service.deleteDomain('zone-1', 'dom-1')).rejects.toThrow('redis down');
      expect(svc.logger.log).toHaveBeenCalledWith(expect.stringContaining('dom-1'));
    });

    it('throws NotFoundException when domain does not exist', async () => {
      svc.prisma.dnsDomain.findUnique.mockResolvedValue(null);
      await expect(svc.service.deleteDomain('zone-1', 'missing')).rejects.toThrow(NotFoundException);
      expect(svc.publisher.republishForZone).not.toHaveBeenCalled();
    });
  });

  describe('domain name normalization', () => {
    it('strips a trailing dot on create', async () => {
      await svc.service.createDomain('zone-1', { name: 'corp.example.', type: 'FORWARD' });
      expect(svc.prisma.dnsDomain.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ name: 'corp.example' }) }),
      );
    });

    it('strips a trailing dot on rename', async () => {
      await svc.service.updateDomain('zone-1', 'dom-1', { name: 'corp.example.' });
      expect(svc.prisma.dnsDomain.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { name: 'corp.example' } }),
      );
    });
  });

  describe('listRecords', () => {
    it('returns records for a domain', async () => {
      const result = await svc.service.listRecords('zone-1', 'dom-1', {});
      expect(result).toHaveLength(1);
    });

    it('maps the linked device role onto each record', async () => {
      svc.prisma.dnsRecord.findMany.mockResolvedValueOnce([
        { id: 'rec-auto', source: 'AUTO', deviceId: 'dev-1', device: { role: 'Server' } },
        { id: 'rec-bridge', source: 'AUTO', deviceId: 'dev-2', device: { role: 'Bridge' } },
        { id: 'rec-manual', source: 'MANUAL', deviceId: null, device: null },
      ]);
      const result = await svc.service.listRecords('zone-1', 'dom-1', {});
      expect(result.map((r: { deviceRole: string | null }) => r.deviceRole)).toEqual(['Server', 'Bridge', null]);
      expect(result[0]).not.toHaveProperty('device');
    });

    it('filters by source when provided', async () => {
      await svc.service.listRecords('zone-1', 'dom-1', { source: 'MANUAL' });
      expect(svc.prisma.dnsRecord.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ source: 'MANUAL' }),
        }),
      );
    });

    it('omits source filter when not provided', async () => {
      await svc.service.listRecords('zone-1', 'dom-1', {});
      expect(svc.prisma.dnsRecord.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { domainId: 'dom-1', deletedAt: null },
        }),
      );
    });

    it('orders by name then type', async () => {
      await svc.service.listRecords('zone-1', 'dom-1', {});
      expect(svc.prisma.dnsRecord.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: [{ name: 'asc' }, { type: 'asc' }],
        }),
      );
    });
  });

  describe('createRecord', () => {
    it('creates a manual record and republishes', async () => {
      svc.prisma.dnsRecord.findFirst.mockResolvedValueOnce(null);
      await svc.service.createRecord('zone-1', 'dom-1', {
        name: 'web',
        type: 'A',
        value: '10.0.0.2',
      });
      expect(svc.prisma.dnsRecord.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ source: 'MANUAL' }),
      });
      expect(svc.publisher.republishForZone).toHaveBeenCalledWith('zone-1');
    });

    it('passes ttlOverride when provided', async () => {
      svc.prisma.dnsRecord.findFirst.mockResolvedValueOnce(null);
      await svc.service.createRecord('zone-1', 'dom-1', {
        name: 'web',
        type: 'A',
        value: '10.0.0.2',
        ttlOverride: 300,
      });
      expect(svc.prisma.dnsRecord.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ ttlOverride: 300 }),
      });
    });

    it('sets ttlOverride to null when not provided', async () => {
      svc.prisma.dnsRecord.findFirst.mockResolvedValueOnce(null);
      await svc.service.createRecord('zone-1', 'dom-1', {
        name: 'web',
        type: 'A',
        value: '10.0.0.2',
      });
      expect(svc.prisma.dnsRecord.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ ttlOverride: null }),
      });
    });

    it('prefers the live row when a soft-deleted twin coexists', async () => {
      svc.prisma.dnsRecord.findFirst.mockResolvedValueOnce({ id: 'rec-live', source: 'AUTO', deletedAt: null });
      await svc.service.createRecord('zone-1', 'dom-1', { name: 'web', type: 'A', value: '10.0.0.2' });
      expect(svc.prisma.dnsRecord.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ orderBy: { deletedAt: { sort: 'asc', nulls: 'first' } } }),
      );
      expect(svc.prisma.dnsRecord.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'rec-live' } }));
    });

    it('pins a live auto twin as manual instead of rejecting', async () => {
      svc.prisma.dnsRecord.findFirst.mockResolvedValueOnce({
        id: 'rec-auto',
        source: 'AUTO',
        deletedAt: null,
      });
      await svc.service.createRecord('zone-1', 'dom-1', {
        name: 'web',
        type: 'A',
        value: '10.0.0.2',
      });
      expect(svc.prisma.dnsRecord.update).toHaveBeenCalledWith({
        where: { id: 'rec-auto' },
        data: expect.objectContaining({ source: 'MANUAL', deviceId: null, ipAddressId: null }),
      });
      expect(svc.prisma.dnsRecord.create).not.toHaveBeenCalled();
    });

    it('throws ConflictException when a live record with the same key exists', async () => {
      await expect(
        svc.service.createRecord('zone-1', 'dom-1', {
          name: 'dup',
          type: 'A',
          value: '10.0.0.1',
        }),
      ).rejects.toThrow(ConflictException);
      expect(svc.prisma.dnsRecord.create).not.toHaveBeenCalled();
    });

    it('restores a soft-deleted record instead of creating a new one', async () => {
      svc.prisma.dnsRecord.findFirst.mockResolvedValueOnce({
        id: 'rec-deleted',
        name: 'web',
        type: 'A',
        value: '10.0.0.2',
        source: 'AUTO',
        deletedAt: new Date(),
      });
      svc.prisma.dnsRecord.update.mockResolvedValueOnce({
        id: 'rec-deleted',
        source: 'MANUAL',
        deletedAt: null,
      });
      await svc.service.createRecord('zone-1', 'dom-1', {
        name: 'web',
        type: 'A',
        value: '10.0.0.2',
        ttlOverride: 600,
      });
      expect(svc.prisma.dnsRecord.create).not.toHaveBeenCalled();
      expect(svc.prisma.dnsRecord.update).toHaveBeenCalledWith({
        where: { id: 'rec-deleted' },
        data: {
          deletedAt: null,
          ttlOverride: 600,
          source: 'MANUAL',
          deviceId: null,
          ipAddressId: null,
        },
      });
      expect(svc.publisher.republishForZone).toHaveBeenCalledWith('zone-1');
    });
  });

  describe('updateRecord', () => {
    it('updates a manual record and republishes', async () => {
      await svc.service.updateRecord('zone-1', 'dom-1', 'rec-1', { name: 'new-host' });
      expect(svc.prisma.dnsRecord.update).toHaveBeenCalledWith({
        where: { id: 'rec-1' },
        data: { name: 'new-host' },
      });
      expect(svc.publisher.republishForZone).toHaveBeenCalledWith('zone-1');
    });

    it('rejects updating AUTO records', async () => {
      svc.prisma.dnsRecord.findUnique.mockResolvedValue({
        id: 'rec-1',
        domainId: 'dom-1',
        source: 'AUTO',
        deletedAt: null,
      });
      await expect(svc.service.updateRecord('zone-1', 'dom-1', 'rec-1', { name: 'x' })).rejects.toThrow(
        BadRequestException,
      );
    });

    it('throws ConflictException on duplicate after update', async () => {
      svc.prisma.dnsRecord.update.mockRejectedValue(p2002());
      await expect(svc.service.updateRecord('zone-1', 'dom-1', 'rec-1', { value: '10.0.0.99' })).rejects.toThrow(
        ConflictException,
      );
    });

    it('rejects invalid name for A record', async () => {
      await expect(svc.service.updateRecord('zone-1', 'dom-1', 'rec-1', { name: '-bad' })).rejects.toThrow(
        BadRequestException,
      );
    });

    it('rejects name with spaces for A record', async () => {
      await expect(svc.service.updateRecord('zone-1', 'dom-1', 'rec-1', { name: 'bad name' })).rejects.toThrow(
        BadRequestException,
      );
    });

    it('rejects invalid PTR record name', async () => {
      svc.prisma.dnsRecord.findUnique.mockResolvedValue({
        id: 'rec-1',
        domainId: 'dom-1',
        type: 'PTR',
        source: 'MANUAL',
        deletedAt: null,
      });
      await expect(svc.service.updateRecord('zone-1', 'dom-1', 'rec-1', { name: 'not!valid' })).rejects.toThrow(
        BadRequestException,
      );
    });

    it('rejects invalid IPv4 value for A record', async () => {
      await expect(svc.service.updateRecord('zone-1', 'dom-1', 'rec-1', { value: 'not-an-ip' })).rejects.toThrow(
        BadRequestException,
      );
    });

    it('rejects invalid IPv6 value for AAAA record', async () => {
      svc.prisma.dnsRecord.findUnique.mockResolvedValue({
        id: 'rec-1',
        domainId: 'dom-1',
        type: 'AAAA',
        source: 'MANUAL',
        deletedAt: null,
      });
      await expect(svc.service.updateRecord('zone-1', 'dom-1', 'rec-1', { value: 'not-ipv6' })).rejects.toThrow(
        BadRequestException,
      );
    });

    it('rejects invalid domain name for PTR record', async () => {
      svc.prisma.dnsRecord.findUnique.mockResolvedValue({
        id: 'rec-1',
        domainId: 'dom-1',
        type: 'PTR',
        source: 'MANUAL',
        deletedAt: null,
      });
      await expect(svc.service.updateRecord('zone-1', 'dom-1', 'rec-1', { value: '!!invalid!!' })).rejects.toThrow(
        BadRequestException,
      );
    });

    it('accepts valid IPv6 for AAAA record', async () => {
      svc.prisma.dnsRecord.findUnique.mockResolvedValue({
        id: 'rec-1',
        domainId: 'dom-1',
        type: 'AAAA',
        source: 'MANUAL',
        deletedAt: null,
      });
      await svc.service.updateRecord('zone-1', 'dom-1', 'rec-1', { value: '2001:db8::1' });
      expect(svc.prisma.dnsRecord.update).toHaveBeenCalled();
    });

    it('only includes provided fields in update data', async () => {
      await svc.service.updateRecord('zone-1', 'dom-1', 'rec-1', { value: '10.0.0.5' });
      expect(svc.prisma.dnsRecord.update).toHaveBeenCalledWith({
        where: { id: 'rec-1' },
        data: { value: '10.0.0.5' },
      });
    });

    it('throws NotFoundException for missing record', async () => {
      svc.prisma.dnsRecord.findUnique.mockResolvedValue(null);
      await expect(svc.service.updateRecord('zone-1', 'dom-1', 'missing', { name: 'x' })).rejects.toThrow(
        NotFoundException,
      );
    });

    it('throws NotFoundException for record in different domain', async () => {
      svc.prisma.dnsRecord.findUnique.mockResolvedValue({
        id: 'rec-1',
        domainId: 'other-dom',
        source: 'MANUAL',
        deletedAt: null,
      });
      await expect(svc.service.updateRecord('zone-1', 'dom-1', 'rec-1', { name: 'x' })).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('deleteRecord', () => {
    it('soft-deletes a manual record and republishes', async () => {
      await svc.service.deleteRecord('zone-1', 'dom-1', 'rec-1');
      expect(svc.prisma.dnsRecord.update).toHaveBeenCalledWith({
        where: { id: 'rec-1' },
        data: { deletedAt: expect.any(Date) },
      });
      expect(svc.publisher.republishForZone).toHaveBeenCalledWith('zone-1');
    });

    it('logs an audit trail', async () => {
      await svc.service.deleteRecord('zone-1', 'dom-1', 'rec-1');
      expect(svc.context.buildAuditPayload).toHaveBeenCalled();
      expect(svc.logger.log).toHaveBeenCalledWith(expect.stringContaining('rec-1'));
    });

    it('logs the audit even when republish fails', async () => {
      svc.publisher.republishForZone.mockRejectedValue(new Error('redis down'));
      await expect(svc.service.deleteRecord('zone-1', 'dom-1', 'rec-1')).rejects.toThrow('redis down');
      expect(svc.logger.log).toHaveBeenCalledWith(expect.stringContaining('rec-1'));
    });

    it('rejects deleting AUTO records', async () => {
      svc.prisma.dnsRecord.findUnique.mockResolvedValue({
        id: 'rec-1',
        domainId: 'dom-1',
        source: 'AUTO',
        deletedAt: null,
      });
      await expect(svc.service.deleteRecord('zone-1', 'dom-1', 'rec-1')).rejects.toThrow(BadRequestException);
    });

    it('throws NotFoundException for missing record', async () => {
      svc.prisma.dnsRecord.findUnique.mockResolvedValue(null);
      await expect(svc.service.deleteRecord('zone-1', 'dom-1', 'missing')).rejects.toThrow(NotFoundException);
    });

    it('throws NotFoundException for soft-deleted record', async () => {
      svc.prisma.dnsRecord.findUnique.mockResolvedValue({
        id: 'rec-1',
        domainId: 'dom-1',
        source: 'MANUAL',
        deletedAt: new Date(),
      });
      await expect(svc.service.deleteRecord('zone-1', 'dom-1', 'rec-1')).rejects.toThrow(NotFoundException);
    });
  });

  describe('permission gates', () => {
    it('rejects all read paths when zone:read is denied', async () => {
      svc.context.requirePermission.mockImplementation(() => {
        throw new ForbiddenException();
      });

      await expect(svc.service.listDomains('zone-1')).rejects.toThrow(ForbiddenException);
      await expect(svc.service.getDomain('zone-1', 'dom-1')).rejects.toThrow(ForbiddenException);
      await expect(svc.service.listRecords('zone-1', 'dom-1', {})).rejects.toThrow(ForbiddenException);

      expect(svc.context.requirePermission).toHaveBeenCalledWith('zone', 'read');
      expect(svc.prisma.dnsDomain.findMany).not.toHaveBeenCalled();
    });

    it('rejects all mutation paths when zone:update is denied', async () => {
      svc.context.requirePermission.mockImplementation((resource: string, action: string) => {
        if (action !== 'read') throw new ForbiddenException();
      });

      await expect(svc.service.createDomain('zone-1', { name: 'test', type: 'FORWARD' })).rejects.toThrow(
        ForbiddenException,
      );
      await expect(svc.service.updateDomain('zone-1', 'dom-1', { name: 'x' })).rejects.toThrow(ForbiddenException);
      await expect(svc.service.deleteDomain('zone-1', 'dom-1')).rejects.toThrow(ForbiddenException);
      await expect(
        svc.service.createRecord('zone-1', 'dom-1', { name: 'a', type: 'A', value: '1.2.3.4' }),
      ).rejects.toThrow(ForbiddenException);
      await expect(svc.service.updateRecord('zone-1', 'dom-1', 'rec-1', { name: 'x' })).rejects.toThrow(
        ForbiddenException,
      );
      await expect(svc.service.deleteRecord('zone-1', 'dom-1', 'rec-1')).rejects.toThrow(ForbiddenException);

      expect(svc.context.requirePermission).toHaveBeenCalledWith('zone', 'update');
      expect(svc.prisma.dnsDomain.create).not.toHaveBeenCalled();
      expect(svc.prisma.dnsDomain.delete).not.toHaveBeenCalled();
      expect(svc.prisma.dnsRecord.create).not.toHaveBeenCalled();
    });
  });
});
