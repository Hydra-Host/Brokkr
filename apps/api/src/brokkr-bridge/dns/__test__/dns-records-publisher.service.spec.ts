import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DnsRecordsAtom } from '../dns-records-atom.schema';
import { DnsRecordsPublisherService } from '../dns-records-publisher.service';
import type { DnsRecordsRedisWriterService } from '../dns-records-redis-writer.service';

const ZONE = 'aaaa1111-2222-3333-4444-555555555555';

const ATOM: DnsRecordsAtom = {
  domains: [
    {
      name: 'example.lan',
      type: 'FORWARD',
      records: [{ name: 'host-a', type: 'A', value: '10.0.0.1', ttl: null }],
    },
  ],
};

function build() {
  const writer = {
    set: vi.fn().mockResolvedValue({ written: true }),
    clear: vi.fn().mockResolvedValue(undefined),
  } as unknown as DnsRecordsRedisWriterService;

  const prisma = {
    dnsDomain: {
      findMany: vi.fn().mockResolvedValue([]),
    },
  };

  const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

  const service = new DnsRecordsPublisherService(prisma as never, writer, logger as never);

  return { service, writer, prisma, logger };
}

describe('DnsRecordsPublisherService', () => {
  let h: ReturnType<typeof build>;
  beforeEach(() => {
    h = build();
  });

  describe('republishForZone', () => {
    it('writes the atom when domains exist', async () => {
      h.prisma.dnsDomain.findMany.mockResolvedValue([
        {
          name: 'example.lan',
          type: 'FORWARD',
          records: [{ name: 'host-a', type: 'A', value: '10.0.0.1', ttlOverride: null }],
        },
      ]);

      await h.service.republishForZone(ZONE);

      expect(h.writer.set).toHaveBeenCalledWith(ZONE, ATOM);
      expect(h.writer.clear).not.toHaveBeenCalled();
    });

    it('clears the atom when no domains exist', async () => {
      h.prisma.dnsDomain.findMany.mockResolvedValue([]);

      await h.service.republishForZone(ZONE);

      expect(h.writer.clear).toHaveBeenCalledWith(ZONE);
      expect(h.writer.set).not.toHaveBeenCalled();
    });

    it('swallows errors and logs a warning', async () => {
      h.prisma.dnsDomain.findMany.mockRejectedValue(new Error('db down'));

      await expect(h.service.republishForZone(ZONE)).resolves.toBeUndefined();

      expect(h.logger.warn).toHaveBeenCalledWith(expect.stringContaining('reconcile cron will heal'));
    });
  });

  describe('buildAtomForZone', () => {
    it('returns null when no domains exist', async () => {
      h.prisma.dnsDomain.findMany.mockResolvedValue([]);

      const result = await h.service.buildAtomForZone(ZONE);

      expect(result).toBeNull();
    });

    it('maps ttlOverride to ttl (null when unset)', async () => {
      h.prisma.dnsDomain.findMany.mockResolvedValue([
        {
          name: 'example.lan',
          type: 'FORWARD',
          records: [
            { name: 'host-a', type: 'A', value: '10.0.0.1', ttlOverride: 300 },
            { name: 'host-b', type: 'A', value: '10.0.0.2', ttlOverride: null },
          ],
        },
      ]);

      const result = await h.service.buildAtomForZone(ZONE);

      expect(result).not.toBeNull();
      expect(result!.domains[0].records[0].ttl).toBe(300);
      expect(result!.domains[0].records[1].ttl).toBeNull();
    });
  });
});
