import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConfigAtomWriter } from '../../../common/redis';
import type { PrefixRepository } from '../../../ipam/prefix/prefix.repository';
import type { LoggerService } from '../../../logger/logger.service';
import { VrrpReconcilerService } from '../vrrp-reconciler.service';
import type { VrrpRedisWriterService } from '../vrrp-redis-writer.service';

const ZONE = 'deca8b4c-2e65-4f75-96e5-67bdcdc9d79a';
const OTHER_ZONE = '11111111-1111-1111-1111-111111111111';
const PREFIX_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const VIP = '10.0.1.1/24';
const IFACE = 'eth0';
const IFACE_BY_BRIDGE: Record<string, string> = { 'bridge-a': IFACE };

function keyFor(zoneId: string, prefixId: string): string {
  return `${zoneId}:prefix:${prefixId}:config:vrrp`;
}

interface Desired {
  prefixId: string;
  zoneId: string;
  vip: string;
  ifaceByBridge: Record<string, string>;
  garpCount: number;
}

function buildService(opts: {
  desired?: Desired[];
  scanKeys?: string[];
  atomValues?: Record<string, { vip: string; ifaceByBridge: Record<string, string>; garpCount?: number } | null | Error>;
}) {
  const desired = opts.desired ?? [];
  const scanKeys = opts.scanKeys ?? [];
  const atomValues = opts.atomValues ?? {};

  const listAllVrrpVipBearingPrefixes = vi.fn().mockResolvedValue(desired);
  const prefixRepository = { listAllVrrpVipBearingPrefixes } as unknown as PrefixRepository;

  const set = vi.fn().mockResolvedValue({ written: true });
  const clear = vi.fn().mockResolvedValue(undefined);
  const vrrpWriter = { set, clear } as unknown as VrrpRedisWriterService;

  const readAtom = vi.fn().mockImplementation(async (zoneId: string, unprefixedKey: string) => {
    const key = `${zoneId}:${unprefixedKey}`;
    const value = atomValues[key];
    if (value instanceof Error) throw value;
    return value ?? null;
  });
  const atomWriter = { readAtom } as unknown as ConfigAtomWriter;

  const scan = vi.fn().mockResolvedValue(['0', scanKeys]);
  const redis = { scan } as unknown as import('ioredis').default;

  const logger = { log: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as unknown as LoggerService;

  const service = new VrrpReconcilerService(prefixRepository, vrrpWriter, atomWriter, redis, logger);
  return { service, set, clear, readAtom, scan, logger, listAllVrrpVipBearingPrefixes };
}

describe('VrrpReconcilerService', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reads Redis (scan) before the DB (desired) — reverse of the write order', async () => {
    const key = keyFor(ZONE, PREFIX_ID);
    const { service, scan, listAllVrrpVipBearingPrefixes } = buildService({
      desired: [{ prefixId: PREFIX_ID, zoneId: ZONE, vip: VIP, ifaceByBridge: IFACE_BY_BRIDGE, garpCount: 5 }],
      scanKeys: [key],
      atomValues: { [key]: { vip: VIP, ifaceByBridge: IFACE_BY_BRIDGE, garpCount: 5 } },
    });

    await service.handleCron();

    expect(scan.mock.invocationCallOrder[0]).toBeLessThan(listAllVrrpVipBearingPrefixes.mock.invocationCallOrder[0]);
  });

  it('republishes a VIP the DB wants but Redis has no atom for (missing)', async () => {
    const { service, set } = buildService({
      desired: [{ prefixId: PREFIX_ID, zoneId: ZONE, vip: VIP, ifaceByBridge: IFACE_BY_BRIDGE, garpCount: 5 }],
      scanKeys: [],
    });

    await service.handleCron();

    expect(set).toHaveBeenCalledWith(ZONE, PREFIX_ID, VIP, IFACE_BY_BRIDGE, 5);
  });

  it('republishes when the atom exists but its value diverges from the DB', async () => {
    const key = keyFor(ZONE, PREFIX_ID);
    const { service, set } = buildService({
      desired: [{ prefixId: PREFIX_ID, zoneId: ZONE, vip: VIP, ifaceByBridge: IFACE_BY_BRIDGE, garpCount: 5 }],
      scanKeys: [key],
      atomValues: { [key]: { vip: '10.0.1.99/24', ifaceByBridge: IFACE_BY_BRIDGE, garpCount: 5 } },
    });

    await service.handleCron();

    expect(set).toHaveBeenCalledWith(ZONE, PREFIX_ID, VIP, IFACE_BY_BRIDGE, 5);
  });

  it('republishes when the atom is published under a stale (relocated) zone', async () => {
    const staleKey = keyFor(OTHER_ZONE, PREFIX_ID);
    const { service, set, clear } = buildService({
      desired: [{ prefixId: PREFIX_ID, zoneId: ZONE, vip: VIP, ifaceByBridge: IFACE_BY_BRIDGE, garpCount: 5 }],
      scanKeys: [staleKey],
      atomValues: { [staleKey]: { vip: VIP, ifaceByBridge: IFACE_BY_BRIDGE, garpCount: 5 } },
    });

    await service.handleCron();

    expect(set).toHaveBeenCalledWith(ZONE, PREFIX_ID, VIP, IFACE_BY_BRIDGE, 5);
    expect(clear).toHaveBeenCalledWith(OTHER_ZONE, PREFIX_ID);
  });

  it('clears an orphaned atom the DB no longer references', async () => {
    const key = keyFor(ZONE, PREFIX_ID);
    const { service, clear, set } = buildService({
      desired: [],
      scanKeys: [key],
      atomValues: { [key]: { vip: VIP, ifaceByBridge: IFACE_BY_BRIDGE, garpCount: 5 } },
    });

    await service.handleCron();

    expect(clear).toHaveBeenCalledWith(ZONE, PREFIX_ID);
    expect(set).not.toHaveBeenCalled();
  });

  it('is a no-op in steady state (DB and Redis already agree)', async () => {
    const key = keyFor(ZONE, PREFIX_ID);
    const { service, set, clear } = buildService({
      desired: [{ prefixId: PREFIX_ID, zoneId: ZONE, vip: VIP, ifaceByBridge: IFACE_BY_BRIDGE, garpCount: 5 }],
      scanKeys: [key],
      atomValues: { [key]: { vip: VIP, ifaceByBridge: IFACE_BY_BRIDGE, garpCount: 5 } },
    });

    await service.handleCron();

    expect(set).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
  });

  it('treats an unreadable/malformed atom as divergent — republishes if desired', async () => {
    const key = keyFor(ZONE, PREFIX_ID);
    const { service, set } = buildService({
      desired: [{ prefixId: PREFIX_ID, zoneId: ZONE, vip: VIP, ifaceByBridge: IFACE_BY_BRIDGE, garpCount: 5 }],
      scanKeys: [key],
      atomValues: { [key]: new Error('schema mismatch') },
    });

    await service.handleCron();

    expect(set).toHaveBeenCalledWith(ZONE, PREFIX_ID, VIP, IFACE_BY_BRIDGE, 5);
  });

  it('skips a re-entrant tick while a previous run is still in flight', async () => {
    const { service, scan, logger } = buildService({ desired: [] });
    let resolveFirst: () => void = () => undefined;
    scan.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = () => resolve(['0', []]);
        }),
    );

    const first = service.handleCron();
    await service.handleCron();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('previous run still in flight'));

    resolveFirst();
    await first;
  });

  it('does not abort the tick when one prefix fails to republish', async () => {
    const OTHER_PREFIX_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    const { service, set, logger } = buildService({
      desired: [
        { prefixId: PREFIX_ID, zoneId: ZONE, vip: VIP, ifaceByBridge: IFACE_BY_BRIDGE, garpCount: 5 },
        { prefixId: OTHER_PREFIX_ID, zoneId: ZONE, vip: VIP, ifaceByBridge: IFACE_BY_BRIDGE, garpCount: 5 },
      ],
      scanKeys: [],
    });
    set.mockRejectedValueOnce(new Error('redis down')).mockResolvedValueOnce({ written: true });

    await service.handleCron();

    expect(set).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Failed to republish'));
  });
});
