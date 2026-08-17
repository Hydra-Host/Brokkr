import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DnsConfigPublisherService } from '../dns-config-publisher.service';
import type { DnsConfigRedisWriterService } from '../dns-config-redis-writer.service';
import type { DnsDerivationService } from '../dns-derivation.service';

const ZONE_ATOM = { enabled: true } as never;
const PREFIX_ATOM = { serveDns: true } as never;

function build() {
  const prisma = {
    prefix: {
      findUnique: vi.fn().mockResolvedValue({ zoneId: 'z1' }),
    },
  };
  const derivation = {
    deriveOneZone: vi.fn(),
    deriveOnePrefix: vi.fn(),
  };
  const writer = {
    setZone: vi.fn().mockResolvedValue({ written: true }),
    clearZone: vi.fn().mockResolvedValue(undefined),
    setPrefix: vi.fn().mockResolvedValue({ written: true }),
    clearPrefix: vi.fn().mockResolvedValue(undefined),
  };
  const logger = { warn: vi.fn(), error: vi.fn(), log: vi.fn(), debug: vi.fn() };
  const service = new DnsConfigPublisherService(
    prisma as never,
    derivation as unknown as DnsDerivationService,
    writer as unknown as DnsConfigRedisWriterService,
    logger as never,
  );
  return { service, prisma, derivation, writer, logger };
}

describe('DnsConfigPublisherService', () => {
  let h: ReturnType<typeof build>;
  beforeEach(() => {
    h = build();
  });

  describe('publishZoneDnsConfig', () => {
    it('sets the atom when the zone derives to ok', async () => {
      h.derivation.deriveOneZone.mockResolvedValue({ status: 'ok', zoneId: 'z1', atom: ZONE_ATOM });
      const result = await h.service.publishZoneDnsConfig('z1');
      expect(h.writer.setZone).toHaveBeenCalledWith('z1', ZONE_ATOM);
      expect(result).toBe(true);
    });

    it('clears the atom when the zone is not found', async () => {
      h.derivation.deriveOneZone.mockResolvedValue({ status: 'not_found' });
      const result = await h.service.publishZoneDnsConfig('z1');
      expect(h.writer.clearZone).toHaveBeenCalledWith('z1');
      expect(result).toBe(true);
    });

    it('returns true when the write is refused as stale', async () => {
      h.derivation.deriveOneZone.mockResolvedValue({ status: 'ok', zoneId: 'z1', atom: ZONE_ATOM });
      h.writer.setZone.mockResolvedValue({ written: false, reason: 'stale' });
      const result = await h.service.publishZoneDnsConfig('z1');
      expect(result).toBe(true);
    });

    it('returns false on a transient derivation error', async () => {
      h.derivation.deriveOneZone.mockResolvedValue({ status: 'error' });
      const result = await h.service.publishZoneDnsConfig('z1');
      expect(result).toBe(false);
      expect(h.writer.setZone).not.toHaveBeenCalled();
      expect(h.writer.clearZone).not.toHaveBeenCalled();
    });

    it('swallows and logs a thrown error', async () => {
      h.derivation.deriveOneZone.mockRejectedValue(new Error('redis down'));
      const result = await h.service.publishZoneDnsConfig('z1');
      expect(result).toBe(false);
      expect(h.logger.warn).toHaveBeenCalled();
    });
  });

  describe('clearZoneDnsConfig', () => {
    it('clears the zone atom', async () => {
      await h.service.clearZoneDnsConfig('z1');
      expect(h.writer.clearZone).toHaveBeenCalledWith('z1');
    });

    it('swallows errors', async () => {
      h.writer.clearZone.mockRejectedValue(new Error('redis down'));
      await expect(h.service.clearZoneDnsConfig('z1')).resolves.toBeUndefined();
      expect(h.logger.warn).toHaveBeenCalled();
    });
  });

  describe('publishPrefixDnsOverride', () => {
    it('sets the atom when the prefix derives to ok', async () => {
      h.derivation.deriveOnePrefix.mockResolvedValue({ status: 'ok', zoneId: 'z1', atom: PREFIX_ATOM });
      const result = await h.service.publishPrefixDnsOverride('p1');
      expect(h.writer.setPrefix).toHaveBeenCalledWith('z1', 'p1', PREFIX_ATOM);
      expect(result).toBe(true);
    });

    it('clears the stale atom when the prefix override is not found', async () => {
      h.derivation.deriveOnePrefix.mockResolvedValue({ status: 'not_found' });
      const result = await h.service.publishPrefixDnsOverride('p1');
      expect(h.prisma.prefix.findUnique).toHaveBeenCalledWith({ where: { id: 'p1' }, select: { zoneId: true } });
      expect(h.writer.clearPrefix).toHaveBeenCalledWith('z1', 'p1');
      expect(result).toBe(true);
    });

    it('skips clear when the prefix has no zone', async () => {
      h.derivation.deriveOnePrefix.mockResolvedValue({ status: 'not_found' });
      h.prisma.prefix.findUnique.mockResolvedValue({ zoneId: null });
      const result = await h.service.publishPrefixDnsOverride('p1');
      expect(h.writer.clearPrefix).not.toHaveBeenCalled();
      expect(result).toBe(true);
    });

    it('returns true when the write is refused as stale so relocate clears the old zone', async () => {
      h.derivation.deriveOnePrefix.mockResolvedValue({ status: 'ok', zoneId: 'z1', atom: PREFIX_ATOM });
      h.writer.setPrefix.mockResolvedValue({ written: false, reason: 'stale' });
      const result = await h.service.publishPrefixDnsOverride('p1');
      expect(result).toBe(true);
    });

    it('returns false on a transient derivation error', async () => {
      h.derivation.deriveOnePrefix.mockResolvedValue({ status: 'error' });
      const result = await h.service.publishPrefixDnsOverride('p1');
      expect(result).toBe(false);
    });

    it('swallows and logs a thrown error', async () => {
      h.derivation.deriveOnePrefix.mockRejectedValue(new Error('redis down'));
      const result = await h.service.publishPrefixDnsOverride('p1');
      expect(result).toBe(false);
      expect(h.logger.warn).toHaveBeenCalled();
    });
  });

  describe('clearPrefixDnsOverride', () => {
    it('clears the prefix atom', async () => {
      await h.service.clearPrefixDnsOverride('z1', 'p1');
      expect(h.writer.clearPrefix).toHaveBeenCalledWith('z1', 'p1');
    });

    it('swallows errors', async () => {
      h.writer.clearPrefix.mockRejectedValue(new Error('redis down'));
      await expect(h.service.clearPrefixDnsOverride('z1', 'p1')).resolves.toBeUndefined();
      expect(h.logger.warn).toHaveBeenCalled();
    });
  });
});
