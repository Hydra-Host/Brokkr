import { Test } from '@nestjs/testing';
import { Prisma } from '@repo/database';
import { PrismaClient } from 'src/prisma/prisma.client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DnsRecordDerivationService,
  ipToPtrHostName,
  ipToReverseDomainName,
  sanitizeDnsLabel,
} from '../dns-record-derivation.service';

function createMockPrisma() {
  return {
    zone: {
      findUnique: vi.fn(),
    },
    dnsDomain: {
      findFirst: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    dnsRecord: {
      findMany: vi.fn().mockResolvedValue([]),
      deleteMany: vi.fn(),
    },
    $queryRaw: vi.fn(),
  };
}

function createMockLogger() {
  return {
    log: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    verbose: vi.fn(),
  };
}

function setupDeriveForZone(
  prisma: ReturnType<typeof createMockPrisma>,
  opts: {
    deviceRows?: Array<{ deviceId: string; hostname: string; ipAddressId: string; address: string }>;
    dnsNameRows?: Array<{ ipAddressId: string; dnsName: string; address: string }>;
    prefixRows?: Array<{ network: string; prefixLength: number }>;
    forwardDomain?: { id: string; name: string } | null;
    reverseDomains?: Array<{ id: string }>;
    upsertedIds?: Array<{ id: string }>;
    manualRecords?: Array<{ domainId: string; name: string; type: string }>;
  },
) {
  prisma.zone.findUnique.mockResolvedValue({ id: 'zone-1', deletedAt: null, dnsEnabled: true });

  const fwd = opts.forwardDomain ?? null;
  const revDomains = opts.reverseDomains ?? [];
  let domainFindCall = 0;
  prisma.dnsDomain.findFirst.mockImplementation(() => {
    domainFindCall++;
    if (domainFindCall === 1) return Promise.resolve(fwd);
    return Promise.resolve(null);
  });

  const fwdCreated = fwd ?? { id: 'domain-fwd', name: 'lan' };
  let domainCreateCall = 0;
  prisma.dnsDomain.create.mockImplementation(() => {
    if (domainCreateCall === 0 && !fwd) {
      domainCreateCall++;
      return Promise.resolve(fwdCreated);
    }
    const rev = revDomains[fwd ? domainCreateCall : domainCreateCall - 1];
    domainCreateCall++;
    return Promise.resolve(rev ?? { id: `domain-rev-${domainCreateCall}` });
  });

  const deviceRows = opts.deviceRows ?? [];
  const dnsNameRows = opts.dnsNameRows ?? [];
  const prefixRows = opts.prefixRows ?? [];
  const upsertResult = opts.upsertedIds ?? [{ id: 'upserted-1' }];

  let queryCall = 0;
  prisma.$queryRaw.mockImplementation(() => {
    queryCall++;
    if (queryCall === 1) return Promise.resolve(deviceRows);
    if (queryCall === 2) return Promise.resolve(dnsNameRows);
    if (queryCall === 3) return Promise.resolve(prefixRows);
    return Promise.resolve(upsertResult);
  });

  prisma.dnsRecord.findMany.mockResolvedValue(opts.manualRecords ?? []);
  prisma.dnsRecord.deleteMany.mockResolvedValue({ count: 0 });
}

describe('DnsRecordDerivationService', () => {
  let service: DnsRecordDerivationService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(async () => {
    prisma = createMockPrisma();
    logger = createMockLogger();

    const module = await Test.createTestingModule({
      providers: [
        DnsRecordDerivationService,
        { provide: PrismaClient, useValue: prisma },
        { provide: `LoggerService${DnsRecordDerivationService.name}`, useValue: logger },
      ],
    }).compile();

    service = module.get(DnsRecordDerivationService);
  });

  describe('deriveForZone', () => {
    it('batch-upserts A records from device hostnames with IPv4 addresses', async () => {
      setupDeriveForZone(prisma, {
        deviceRows: [{ deviceId: 'dev-1', hostname: 'gpu-0001', ipAddressId: 'ip-1', address: '10.0.1.5' }],
        upsertedIds: [{ id: 'rec-a-1' }],
      });

      await service.deriveForZone('zone-1');

      expect(prisma.$queryRaw).toHaveBeenCalledTimes(4);
      expect(prisma.dnsRecord.deleteMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            source: 'AUTO',
            id: { notIn: ['rec-a-1'] },
          }),
        }),
      );
    });

    it('batch-upserts AAAA records from device hostnames with IPv6 addresses', async () => {
      setupDeriveForZone(prisma, {
        deviceRows: [{ deviceId: 'dev-1', hostname: 'gpu-0001', ipAddressId: 'ip-1', address: '2001:db8::5' }],
        prefixRows: [{ network: '2001:db8::', prefixLength: 48 }],
        reverseDomains: [{ id: 'domain-rev6' }],
        upsertedIds: [{ id: 'rec-aaaa' }, { id: 'rec-ptr' }],
      });

      await service.deriveForZone('zone-1');

      expect(prisma.$queryRaw).toHaveBeenCalledTimes(4);
      expect(prisma.dnsRecord.deleteMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: { notIn: ['rec-aaaa', 'rec-ptr'] },
          }),
        }),
      );
    });

    it('soft-deletes orphaned reverse domains that end up empty', async () => {
      setupDeriveForZone(prisma, {
        deviceRows: [],
        prefixRows: [],
        upsertedIds: [],
      });
      prisma.dnsDomain.findMany.mockResolvedValueOnce([{ id: 'domain-orphan' }]);

      await service.deriveForZone('zone-1');

      expect(prisma.dnsDomain.updateMany).toHaveBeenCalledWith({
        where: {
          id: { in: ['domain-orphan'] },
          deletedAt: null,
          records: { none: { deletedAt: null } },
        },
        data: { deletedAt: expect.any(Date) },
      });
    });

    it('resolves the forward domain by oldest forward type, not by name', async () => {
      setupDeriveForZone(prisma, {
        deviceRows: [{ deviceId: 'dev-1', hostname: 'gpu-0001', ipAddressId: 'ip-1', address: '10.0.1.5' }],
        prefixRows: [],
        forwardDomain: { id: 'domain-renamed', name: 'corp.example' },
        upsertedIds: [{ id: 'rec-a' }],
      });

      await service.deriveForZone('zone-1');

      expect(prisma.dnsDomain.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { zoneId: 'zone-1', type: 'FORWARD', deletedAt: null },
          orderBy: { createdAt: 'asc' },
        }),
      );
      expect(prisma.dnsDomain.create).not.toHaveBeenCalled();
    });

    it('places the ptr in the most-specific containing prefix reverse domain', async () => {
      setupDeriveForZone(prisma, {
        deviceRows: [{ deviceId: 'dev-1', hostname: 'gpu-0001', ipAddressId: 'ip-1', address: '10.9.5.7' }],
        prefixRows: [
          { network: '10.9.5.0', prefixLength: 24 },
          { network: '10.9.0.0', prefixLength: 16 },
        ],
        reverseDomains: [{ id: 'domain-rev-child' }, { id: 'domain-rev-parent' }],
        upsertedIds: [{ id: 'rec-a' }, { id: 'rec-ptr' }],
      });

      await service.deriveForZone('zone-1');

      const serializedCalls = JSON.stringify(prisma.$queryRaw.mock.calls);
      expect(serializedCalls).toContain('domain-rev-child');
      expect(serializedCalls).not.toContain('domain-rev-parent');

      const prefixQueryStrings = prisma.$queryRaw.mock.calls[2][0];
      expect(prefixQueryStrings.join('?')).toContain('ORDER BY masklen(p.prefix) DESC');
    });

    it('emits no PTR when the matching prefix is a /32', async () => {
      setupDeriveForZone(prisma, {
        deviceRows: [{ deviceId: 'dev-1', hostname: 'gpu-0001', ipAddressId: 'ip-1', address: '10.0.1.5' }],
        prefixRows: [{ network: '10.0.1.5', prefixLength: 32 }],
        reverseDomains: [{ id: 'domain-rev32' }],
        upsertedIds: [{ id: 'rec-a' }],
      });

      await service.deriveForZone('zone-1');

      const upsertCall = prisma.$queryRaw.mock.calls[3];
      expect(upsertCall).toBeDefined();
      expect(JSON.stringify(upsertCall)).not.toContain('PTR');
    });

    it('derives PTR records for A records with matching prefix', async () => {
      setupDeriveForZone(prisma, {
        deviceRows: [{ deviceId: 'dev-1', hostname: 'gpu-0001', ipAddressId: 'ip-1', address: '10.0.1.5' }],
        prefixRows: [{ network: '10.0.1.0', prefixLength: 24 }],
        reverseDomains: [{ id: 'domain-rev' }],
        upsertedIds: [{ id: 'rec-a' }, { id: 'rec-ptr' }],
      });

      await service.deriveForZone('zone-1');

      expect(prisma.dnsRecord.deleteMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: { notIn: ['rec-a', 'rec-ptr'] },
          }),
        }),
      );
    });

    it('deletes stale AUTO records not in the upserted set', async () => {
      setupDeriveForZone(prisma, {
        deviceRows: [{ deviceId: 'dev-1', hostname: 'gpu-0001', ipAddressId: 'ip-1', address: '10.0.1.5' }],
        prefixRows: [{ network: '10.0.1.0', prefixLength: 24 }],
        reverseDomains: [{ id: 'domain-rev' }],
        upsertedIds: [{ id: 'rec-a' }, { id: 'rec-ptr' }],
      });
      prisma.dnsRecord.deleteMany.mockResolvedValue({ count: 1 });

      await service.deriveForZone('zone-1');

      expect(prisma.dnsRecord.deleteMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            source: 'AUTO',
            id: expect.objectContaining({ notIn: expect.any(Array) }),
          }),
        }),
      );
    });

    it('handles dnsName IPs alongside device hostnames', async () => {
      setupDeriveForZone(prisma, {
        dnsNameRows: [{ ipAddressId: 'ip-2', dnsName: 'switch-mgmt', address: '10.0.1.10' }],
        upsertedIds: [{ id: 'rec-dns' }],
      });

      await service.deriveForZone('zone-1');

      expect(prisma.$queryRaw).toHaveBeenCalledTimes(4);
      expect(prisma.dnsRecord.deleteMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: { notIn: ['rec-dns'] },
          }),
        }),
      );
    });

    it('deduplicates overlapping device hostname and dnsName records', async () => {
      setupDeriveForZone(prisma, {
        deviceRows: [{ deviceId: 'dev-1', hostname: 'gpu-0001', ipAddressId: 'ip-1', address: '10.0.1.5' }],
        dnsNameRows: [{ ipAddressId: 'ip-1', dnsName: 'gpu-0001', address: '10.0.1.5' }],
        upsertedIds: [{ id: 'rec-a' }],
      });

      await service.deriveForZone('zone-1');

      const upsertCall = prisma.$queryRaw.mock.calls[3];
      expect(upsertCall).toBeDefined();

      const upsertSql = upsertCall[0];
      const valueCount = upsertSql.values.filter((v: unknown) => v === 'gpu-0001').length;
      expect(valueCount).toBe(1);
    });

    it('skips deleted zones', async () => {
      prisma.zone.findUnique.mockResolvedValue({
        id: 'zone-1',
        deletedAt: new Date(),
      });

      await service.deriveForZone('zone-1');

      expect(prisma.dnsDomain.findFirst).not.toHaveBeenCalled();
    });

    it('skips non-existent zones', async () => {
      prisma.zone.findUnique.mockResolvedValue(null);

      await service.deriveForZone('zone-missing');

      expect(prisma.dnsDomain.findFirst).not.toHaveBeenCalled();
    });

    it('skips derivation for dns-disabled zones', async () => {
      prisma.zone.findUnique.mockResolvedValue({ id: 'zone-1', deletedAt: null, dnsEnabled: false });

      await service.deriveForZone('zone-1');

      expect(prisma.dnsDomain.findFirst).not.toHaveBeenCalled();
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });

    it('deletes leftover AUTO records when a zone is dns-disabled', async () => {
      prisma.zone.findUnique.mockResolvedValue({ id: 'zone-1', deletedAt: null, dnsEnabled: false });
      prisma.dnsDomain.findMany.mockResolvedValue([{ id: 'domain-fwd' }, { id: 'domain-rev' }]);
      prisma.dnsRecord.deleteMany.mockResolvedValue({ count: 2 });

      await service.deriveForZone('zone-1');

      expect(prisma.dnsRecord.deleteMany).toHaveBeenCalledWith({
        where: { domainId: { in: ['domain-fwd', 'domain-rev'] }, source: 'AUTO' },
      });
      expect(prisma.dnsDomain.findFirst).not.toHaveBeenCalled();
    });

    it('skips the AUTO delete when a dns-disabled zone has no active domains', async () => {
      prisma.zone.findUnique.mockResolvedValue({ id: 'zone-1', deletedAt: null, dnsEnabled: false });
      prisma.dnsDomain.findMany.mockResolvedValue([]);

      await service.deriveForZone('zone-1');

      expect(prisma.dnsRecord.deleteMany).not.toHaveBeenCalled();
    });

    it('skips batch upsert when no records are derived', async () => {
      setupDeriveForZone(prisma, {});

      await service.deriveForZone('zone-1');

      expect(prisma.$queryRaw).toHaveBeenCalledTimes(3);
    });

    it('is idempotent on repeated calls with same data', async () => {
      prisma.zone.findUnique.mockResolvedValue({ id: 'zone-1', deletedAt: null, dnsEnabled: true });
      prisma.dnsDomain.findFirst.mockResolvedValue({ id: 'domain-fwd', name: 'lan' });

      const deviceRows = [{ deviceId: 'dev-1', hostname: 'gpu-0001', ipAddressId: 'ip-1', address: '10.0.1.5' }];

      let callCount = 0;
      prisma.$queryRaw.mockImplementation(() => {
        callCount++;
        const position = ((callCount - 1) % 4) + 1;
        if (position === 1) return Promise.resolve(deviceRows);
        if (position === 4) return Promise.resolve([{ id: 'rec-1' }]);
        return Promise.resolve([]);
      });
      prisma.dnsRecord.deleteMany.mockResolvedValue({ count: 0 });

      await service.deriveForZone('zone-1');
      await service.deriveForZone('zone-1');

      expect(prisma.$queryRaw).toHaveBeenCalledTimes(8);
      expect(prisma.dnsRecord.deleteMany).toHaveBeenCalledTimes(2);
      expect(prisma.dnsRecord.deleteMany).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          where: expect.objectContaining({ id: { notIn: ['rec-1'] } }),
        }),
      );
      expect(prisma.dnsRecord.deleteMany).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          where: expect.objectContaining({ id: { notIn: ['rec-1'] } }),
        }),
      );
    });

    it('cleans up all AUTO records when no devices or IPs exist', async () => {
      prisma.zone.findUnique.mockResolvedValue({ id: 'zone-1', deletedAt: null, dnsEnabled: true });
      prisma.dnsDomain.findFirst.mockResolvedValue(null);
      prisma.dnsDomain.create.mockResolvedValue({ id: 'domain-fwd', name: 'lan' });
      prisma.$queryRaw.mockResolvedValue([]);
      prisma.dnsRecord.deleteMany.mockResolvedValue({ count: 3 });

      await service.deriveForZone('zone-1');

      expect(prisma.dnsRecord.deleteMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            source: 'AUTO',
            domainId: { in: ['domain-fwd'] },
          }),
        }),
      );
    });

    it('recovers from P2002 on concurrent forward domain creation', async () => {
      prisma.zone.findUnique.mockResolvedValue({ id: 'zone-1', deletedAt: null, dnsEnabled: true });

      let findFirstCall = 0;
      prisma.dnsDomain.findFirst.mockImplementation(() => {
        findFirstCall++;
        if (findFirstCall === 1) return Promise.resolve(null);
        return Promise.resolve({ id: 'domain-race', name: 'lan' });
      });
      prisma.dnsDomain.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: 'test',
        }),
      );
      prisma.$queryRaw.mockResolvedValue([]);
      prisma.dnsRecord.deleteMany.mockResolvedValue({ count: 0 });

      await service.deriveForZone('zone-1');

      expect(prisma.dnsDomain.create).toHaveBeenCalledTimes(1);
      expect(prisma.dnsDomain.findFirst).toHaveBeenCalledTimes(2);
      expect(logger.error).not.toHaveBeenCalled();
    });

    it('recovers from P2002 on concurrent reverse domain creation', async () => {
      prisma.zone.findUnique.mockResolvedValue({ id: 'zone-1', deletedAt: null, dnsEnabled: true });

      prisma.dnsDomain.findFirst.mockResolvedValueOnce({ id: 'domain-fwd', name: 'lan' });
      prisma.dnsDomain.findFirst.mockResolvedValueOnce(null);
      prisma.dnsDomain.findFirst.mockResolvedValueOnce({ id: 'domain-rev-race' });

      prisma.dnsDomain.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: 'test',
        }),
      );

      let queryCall = 0;
      prisma.$queryRaw.mockImplementation(() => {
        queryCall++;
        if (queryCall === 1) return Promise.resolve([]);
        if (queryCall === 2) return Promise.resolve([]);
        if (queryCall === 3) return Promise.resolve([{ network: '10.0.1.0', prefixLength: 24 }]);
        return Promise.resolve([]);
      });
      prisma.dnsRecord.deleteMany.mockResolvedValue({ count: 0 });

      await service.deriveForZone('zone-1');

      expect(prisma.dnsDomain.create).toHaveBeenCalledTimes(1);
      expect(logger.error).not.toHaveBeenCalled();
    });

    it('skips devices whose names are not valid DNS labels', async () => {
      setupDeriveForZone(prisma, {
        deviceRows: [
          { deviceId: 'dev-ok', hostname: 'gpu-0001', ipAddressId: 'ip-1', address: '10.0.1.5' },
          { deviceId: 'dev-dots', hostname: 'foo.bar.baz', ipAddressId: 'ip-2', address: '10.0.1.6' },
          { deviceId: 'dev-bad', hostname: '...', ipAddressId: 'ip-3', address: '10.0.1.7' },
        ],
        upsertedIds: [{ id: 'rec-ok' }, { id: 'rec-dots' }],
      });

      await service.deriveForZone('zone-1');

      expect(prisma.$queryRaw).toHaveBeenCalledTimes(4);
      const upsertCall = prisma.$queryRaw.mock.calls[3];
      const upsertValues = JSON.stringify(upsertCall);
      expect(upsertValues).toContain('gpu-0001');
      expect(upsertValues).toContain('foo-bar-baz');
      expect(upsertValues).not.toContain('ip-3');
    });

    it('skips dnsName IPs that are not valid DNS labels', async () => {
      setupDeriveForZone(prisma, {
        dnsNameRows: [
          { ipAddressId: 'ip-1', dnsName: 'valid-name', address: '10.0.1.5' },
          { ipAddressId: 'ip-2', dnsName: '---', address: '10.0.1.6' },
        ],
        upsertedIds: [{ id: 'rec-valid' }],
      });

      await service.deriveForZone('zone-1');

      expect(prisma.$queryRaw).toHaveBeenCalledTimes(4);
      const upsertCall = prisma.$queryRaw.mock.calls[3];
      const upsertValues = JSON.stringify(upsertCall);
      expect(upsertValues).toContain('valid-name');
      expect(upsertValues).not.toContain('ip-2');
    });

    it('logs errors on failure without throwing', async () => {
      prisma.zone.findUnique.mockRejectedValue(new Error('db down'));

      await service.deriveForZone('zone-1');

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('Failed to derive DNS records for zone zone-1'),
      );
    });

    it('skips auto records that collide with existing manual records on (domainId, name, type)', async () => {
      setupDeriveForZone(prisma, {
        forwardDomain: { id: 'domain-fwd', name: 'lan' },
        deviceRows: [
          { deviceId: 'dev-1', hostname: 'gpu-0001', ipAddressId: 'ip-1', address: '10.0.1.5' },
          { deviceId: 'dev-2', hostname: 'gpu-0002', ipAddressId: 'ip-2', address: '10.0.1.6' },
        ],
        manualRecords: [{ domainId: 'domain-fwd', name: 'gpu-0001', type: 'A' }],
        upsertedIds: [{ id: 'rec-auto-2' }],
      });

      await service.deriveForZone('zone-1');

      expect(prisma.dnsRecord.findMany).toHaveBeenCalledWith({
        where: {
          domainId: { in: ['domain-fwd'] },
          source: 'MANUAL',
          deletedAt: null,
        },
        select: { domainId: true, name: true, type: true },
      });

      const upsertCall = prisma.$queryRaw.mock.calls[3];
      expect(upsertCall).toBeDefined();
      const sqlParts = upsertCall[0];
      const sqlString = typeof sqlParts === 'string' ? sqlParts : sqlParts.strings?.join('');
      expect(sqlString).not.toContain('gpu-0001');
    });

    it('preserves manual record untouched when auto-derivation produces same (domain, name, type) with different value', async () => {
      setupDeriveForZone(prisma, {
        forwardDomain: { id: 'domain-fwd', name: 'lan' },
        deviceRows: [{ deviceId: 'dev-1', hostname: 'manual-host', ipAddressId: 'ip-1', address: '10.0.1.5' }],
        manualRecords: [{ domainId: 'domain-fwd', name: 'manual-host', type: 'A' }],
      });

      await service.deriveForZone('zone-1');

      expect(prisma.$queryRaw).toHaveBeenCalledTimes(3);
    });

    it('also excludes auto PTR records when manual PTR exists for same reverse key', async () => {
      setupDeriveForZone(prisma, {
        forwardDomain: { id: 'domain-fwd', name: 'lan' },
        deviceRows: [{ deviceId: 'dev-1', hostname: 'gpu-0001', ipAddressId: 'ip-1', address: '10.0.1.5' }],
        prefixRows: [{ network: '10.0.1.0', prefixLength: 24 }],
        reverseDomains: [{ id: 'domain-rev' }],
        manualRecords: [{ domainId: 'domain-rev', name: '5', type: 'PTR' }],
        upsertedIds: [{ id: 'rec-a' }],
      });

      await service.deriveForZone('zone-1');

      expect(prisma.dnsRecord.findMany).toHaveBeenCalledWith({
        where: {
          domainId: { in: ['domain-fwd', 'domain-rev'] },
          source: 'MANUAL',
          deletedAt: null,
        },
        select: { domainId: true, name: true, type: true },
      });
    });
  });

  describe('rederiveAll', () => {
    it('derives for every zone that has device IPs', async () => {
      const deriveForZoneSpy = vi.spyOn(service, 'deriveForZone').mockResolvedValue(undefined);

      let queryCallCount = 0;
      prisma.$queryRaw.mockImplementation(() => {
        queryCallCount++;
        if (queryCallCount === 1) return Promise.resolve([{ zoneId: 'zone-a' }, { zoneId: 'zone-b' }]);
        if (queryCallCount === 2) return Promise.resolve([]);
        return Promise.resolve([]);
      });

      await service.rederiveAll();

      expect(deriveForZoneSpy).toHaveBeenCalledWith('zone-a');
      expect(deriveForZoneSpy).toHaveBeenCalledWith('zone-b');
      expect(deriveForZoneSpy).toHaveBeenCalledTimes(2);
    });

    it('is a no-op when no zones have device IPs or auto records', async () => {
      const deriveForZoneSpy = vi.spyOn(service, 'deriveForZone').mockResolvedValue(undefined);
      prisma.$queryRaw.mockResolvedValue([]);

      await service.rederiveAll();

      expect(deriveForZoneSpy).not.toHaveBeenCalled();
    });

    it('derives for zones with stale auto records even without device IPs', async () => {
      const deriveForZoneSpy = vi.spyOn(service, 'deriveForZone').mockResolvedValue(undefined);

      let queryCallCount = 0;
      prisma.$queryRaw.mockImplementation(() => {
        queryCallCount++;
        if (queryCallCount === 1) return Promise.resolve([]);
        if (queryCallCount === 2) return Promise.resolve([{ zoneId: 'zone-orphan' }]);
        return Promise.resolve([]);
      });

      await service.rederiveAll();

      expect(deriveForZoneSpy).toHaveBeenCalledWith('zone-orphan');
      expect(deriveForZoneSpy).toHaveBeenCalledTimes(1);
    });

    it('deduplicates zones appearing in both device-ip and auto-record queries', async () => {
      const deriveForZoneSpy = vi.spyOn(service, 'deriveForZone').mockResolvedValue(undefined);

      let queryCallCount = 0;
      prisma.$queryRaw.mockImplementation(() => {
        queryCallCount++;
        if (queryCallCount === 1) return Promise.resolve([{ zoneId: 'zone-a' }]);
        if (queryCallCount === 2) return Promise.resolve([{ zoneId: 'zone-a' }, { zoneId: 'zone-b' }]);
        return Promise.resolve([]);
      });

      await service.rederiveAll();

      expect(deriveForZoneSpy).toHaveBeenCalledWith('zone-a');
      expect(deriveForZoneSpy).toHaveBeenCalledWith('zone-b');
      expect(deriveForZoneSpy).toHaveBeenCalledTimes(2);
    });
  });
});

describe('ipToReverseDomainName', () => {
  it('converts /24 prefix to reverse domain', () => {
    expect(ipToReverseDomainName('10.0.1.0', 24)).toBe('1.0.10.in-addr.arpa');
  });

  it('converts /16 prefix to reverse domain', () => {
    expect(ipToReverseDomainName('172.16.0.0', 16)).toBe('16.172.in-addr.arpa');
  });

  it('converts /8 prefix to reverse domain', () => {
    expect(ipToReverseDomainName('10.0.0.0', 8)).toBe('10.in-addr.arpa');
  });

  it('handles non-byte-aligned /25 by truncating to byte boundary', () => {
    expect(ipToReverseDomainName('10.0.1.0', 25)).toBe('1.0.10.in-addr.arpa');
  });

  it('converts /48 IPv6 prefix to reverse domain', () => {
    expect(ipToReverseDomainName('2001:db8::', 48)).toBe('0.0.0.0.8.b.d.0.1.0.0.2.ip6.arpa');
  });

  it('converts /64 IPv6 prefix to reverse domain', () => {
    expect(ipToReverseDomainName('2001:db8:abcd:1234::', 64)).toBe('4.3.2.1.d.c.b.a.8.b.d.0.1.0.0.2.ip6.arpa');
  });

  it('throws on IPv6 address with multiple ::', () => {
    expect(() => ipToReverseDomainName('2001::db8::1', 48)).toThrow('multiple ::');
  });
});

describe('ipToPtrHostName', () => {
  it('returns host octet for /24 IPv4', () => {
    expect(ipToPtrHostName('10.0.1.50', 24)).toBe('50');
  });

  it('returns two host octets for /16 IPv4', () => {
    expect(ipToPtrHostName('172.16.5.10', 16)).toBe('10.5');
  });

  it('returns three host octets for /8 IPv4', () => {
    expect(ipToPtrHostName('10.1.2.3', 8)).toBe('3.2.1');
  });

  it('truncates non-byte-aligned /25 to byte boundary like ipToReverseDomainName', () => {
    expect(ipToPtrHostName('10.0.1.50', 25)).toBe('50');
  });

  it('returns host nibbles for /48 IPv6', () => {
    expect(ipToPtrHostName('2001:db8::5', 48)).toBe('5.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0');
  });

  it('returns host nibbles for /64 IPv6', () => {
    expect(ipToPtrHostName('2001:db8:abcd:1234::1', 64)).toBe('1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0');
  });

  it('throws on IPv6 address with multiple ::', () => {
    expect(() => ipToPtrHostName('2001::db8::1', 48)).toThrow('multiple ::');
  });

  it('returns empty string for /32 IPv4', () => {
    expect(ipToPtrHostName('10.0.1.5', 32)).toBe('');
  });

  it('returns empty string for /128 IPv6', () => {
    expect(ipToPtrHostName('2001:db8::1', 128)).toBe('');
  });
});

describe('sanitizeDnsLabel', () => {
  it('passes through a valid hostname unchanged', () => {
    expect(sanitizeDnsLabel('gpu-0001')).toBe('gpu-0001');
  });

  it('lowercases uppercase letters', () => {
    expect(sanitizeDnsLabel('GPU-0001')).toBe('gpu-0001');
  });

  it('replaces dots with hyphens to prevent multi-label splitting', () => {
    expect(sanitizeDnsLabel('foo.bar')).toBe('foo-bar');
  });

  it('replaces underscores and spaces with hyphens', () => {
    expect(sanitizeDnsLabel('my_server name')).toBe('my-server-name');
  });

  it('strips leading and trailing hyphens after replacement', () => {
    expect(sanitizeDnsLabel('.leading')).toBe('leading');
    expect(sanitizeDnsLabel('trailing.')).toBe('trailing');
  });

  it('replaces each invalid char with a hyphen', () => {
    expect(sanitizeDnsLabel('a...b')).toBe('a---b');
  });

  it('returns null for empty string', () => {
    expect(sanitizeDnsLabel('')).toBeNull();
  });

  it('returns null for all-invalid characters', () => {
    expect(sanitizeDnsLabel('...')).toBeNull();
  });

  it('truncates to 63 characters', () => {
    const long = 'a'.repeat(70);
    const result = sanitizeDnsLabel(long);
    expect(result).toHaveLength(63);
  });

  it('strips trailing hyphens produced by truncation', () => {
    const input = 'a'.repeat(62) + '--x';
    const result = sanitizeDnsLabel(input);
    expect(result).toBe('a'.repeat(62));
  });

  it('returns null for single hyphen', () => {
    expect(sanitizeDnsLabel('-')).toBeNull();
  });
});
