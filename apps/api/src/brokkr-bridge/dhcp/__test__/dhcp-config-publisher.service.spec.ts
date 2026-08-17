import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DhcpConfigPublisherService } from '../dhcp-config-publisher.service';
import type { DhcpConfigRedisWriterService } from '../dhcp-config-redis-writer.service';
import type { DhcpDerivationService } from '../dhcp-derivation.service';

const ATOM = { mode: 'AUTHORITATIVE' } as never;

function build() {
  const derivation = { deriveOne: vi.fn() };
  const writer = { set: vi.fn().mockResolvedValue({ written: true }), clear: vi.fn().mockResolvedValue(undefined) };
  const prisma = { $queryRaw: vi.fn(), prefix: { findUnique: vi.fn() } };
  const logger = { warn: vi.fn(), error: vi.fn(), log: vi.fn(), debug: vi.fn() };
  const service = new DhcpConfigPublisherService(
    prisma as never,
    derivation as unknown as DhcpDerivationService,
    writer as unknown as DhcpConfigRedisWriterService,
    logger as never,
  );
  return { service, derivation, writer, prisma, logger };
}

describe('DhcpConfigPublisherService.republishPrefixes', () => {
  let h: ReturnType<typeof build>;
  beforeEach(() => {
    h = build();
  });

  it('sets the atom when the prefix derives to enabled', async () => {
    h.derivation.deriveOne.mockResolvedValue({ status: 'enabled', zoneId: 'z1', atom: ATOM });
    await h.service.republishPrefixes(['p1']);
    expect(h.writer.set).toHaveBeenCalledWith('z1', 'p1', ATOM);
    expect(h.writer.clear).not.toHaveBeenCalled();
  });

  it('clears the atom (via the prefix zone) when the prefix derives to disabled', async () => {
    h.derivation.deriveOne.mockResolvedValue({ status: 'disabled' });
    h.prisma.prefix.findUnique.mockResolvedValue({ zoneId: 'z9' });
    await h.service.republishPrefixes(['p2']);
    expect(h.writer.clear).toHaveBeenCalledWith('z9', 'p2');
    expect(h.writer.set).not.toHaveBeenCalled();
  });

  it('leaves the atom untouched on a transient derivation error', async () => {
    h.derivation.deriveOne.mockResolvedValue({ status: 'error' });
    await h.service.republishPrefixes(['p3']);
    expect(h.writer.set).not.toHaveBeenCalled();
    expect(h.writer.clear).not.toHaveBeenCalled();
  });

  it('swallows and logs a thrown error (never fails the caller)', async () => {
    h.derivation.deriveOne.mockRejectedValue(new Error('redis down'));
    await expect(h.service.republishPrefixes(['p4'])).resolves.toBeUndefined();
    expect(h.logger.warn).toHaveBeenCalled();
  });

  it('dedupes repeated prefix ids', async () => {
    h.derivation.deriveOne.mockResolvedValue({ status: 'enabled', zoneId: 'z1', atom: ATOM });
    await h.service.republishPrefixes(['p1', 'p1', 'p1']);
    expect(h.derivation.deriveOne).toHaveBeenCalledTimes(1);
  });

  it('does not call clear when the prefix is not found (findUnique returns null)', async () => {
    h.derivation.deriveOne.mockResolvedValue({ status: 'disabled' });
    h.prisma.prefix.findUnique.mockResolvedValue(null);
    await h.service.republishPrefixes(['p-gone']);
    expect(h.writer.clear).not.toHaveBeenCalled();
    expect(h.writer.set).not.toHaveBeenCalled();
  });

  it('does not call clear when the prefix has a null zoneId', async () => {
    h.derivation.deriveOne.mockResolvedValue({ status: 'disabled' });
    h.prisma.prefix.findUnique.mockResolvedValue({ zoneId: null });
    await h.service.republishPrefixes(['p-zoneless']);
    expect(h.writer.clear).not.toHaveBeenCalled();
    expect(h.writer.set).not.toHaveBeenCalled();
  });
});

describe('DhcpConfigPublisherService resolvers', () => {
  it('republishForDevice republishes each prefix that holds one of the device reservations', async () => {
    const h = build();
    h.prisma.$queryRaw.mockResolvedValue([{ prefixId: 'p1' }, { prefixId: 'p2' }]);
    h.derivation.deriveOne.mockResolvedValue({ status: 'enabled', zoneId: 'z1', atom: ATOM });
    await h.service.republishForDevice('device-1');
    expect(h.derivation.deriveOne).toHaveBeenCalledWith('p1');
    expect(h.derivation.deriveOne).toHaveBeenCalledWith('p2');
    expect(h.writer.set).toHaveBeenCalledTimes(2);
  });

  it('republishForIpAddress republishes the prefix that contains the IP', async () => {
    const h = build();
    h.prisma.$queryRaw.mockResolvedValue([{ prefixId: 'p7' }]);
    h.derivation.deriveOne.mockResolvedValue({ status: 'enabled', zoneId: 'z1', atom: ATOM });
    await h.service.republishForIpAddress('ip-1');
    expect(h.derivation.deriveOne).toHaveBeenCalledWith('p7');
  });

  it('republishForReservation republishes the prefix that contains the reservation address', async () => {
    const h = build();
    h.prisma.$queryRaw.mockResolvedValue([{ prefixId: 'p-old' }]);
    h.derivation.deriveOne.mockResolvedValue({ status: 'enabled', zoneId: 'z1', atom: ATOM });
    await h.service.republishForReservation('10.0.1.5', 'org-1', null);
    expect(h.derivation.deriveOne).toHaveBeenCalledWith('p-old');
    expect(h.writer.set).toHaveBeenCalledWith('z1', 'p-old', ATOM);
  });

  it('is a no-op when the device has no reservation-bearing DHCP prefixes', async () => {
    const h = build();
    h.prisma.$queryRaw.mockResolvedValue([]);
    await h.service.republishForDevice('device-1');
    expect(h.derivation.deriveOne).not.toHaveBeenCalled();
  });

  it('never throws when the resolver query fails — eager republish runs after the caller commits', async () => {
    const h = build();
    h.prisma.$queryRaw.mockRejectedValue(new Error('db down'));
    await expect(h.service.republishForDevice('device-1')).resolves.toBeUndefined();
    await expect(h.service.republishForIpAddress('ip-1')).resolves.toBeUndefined();
    await expect(h.service.republishForReservation('10.0.1.5', 'org-1', null)).resolves.toBeUndefined();
    expect(h.logger.warn).toHaveBeenCalled();
    expect(h.derivation.deriveOne).not.toHaveBeenCalled();
  });
});
