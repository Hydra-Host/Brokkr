import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConfigAtomWriter } from '../../../common/redis';
import type { LoggerService } from '../../../logger/logger.service';
import type { DhcpAtom } from '../dhcp-atom.schema';
import { DhcpConfigReconcilerService } from '../dhcp-config-reconciler.service';
import type { DhcpConfigRedisWriterService } from '../dhcp-config-redis-writer.service';
import type { DhcpDerivationService } from '../dhcp-derivation.service';

const ZONE = 'deca8b4c-2e65-4f75-96e5-67bdcdc9d79a';
const OTHER_ZONE = '11111111-1111-1111-1111-111111111111';
const PREFIX_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

function makeAtom(overrides: Partial<DhcpAtom> = {}): DhcpAtom {
  return {
    mode: 'AUTHORITATIVE',
    subnet: '10.0.1.0/24',
    pools: [],
    routers: [],
    dnsServers: [],
    leaseTtlSeconds: 600,
    reservations: [],
    dhcpOptions: [],
    nextServer: null,
    ipxeBuildTarget: null,
    relay: null,
    ...overrides,
  };
}

function keyFor(zoneId: string, prefixId: string): string {
  return `${zoneId}:prefix:${prefixId}:config:dhcp`;
}

interface Desired {
  prefixId: string;
  zoneId: string;
  atom: DhcpAtom;
}

function buildService(opts: {
  desired?: Desired[];
  enabledKeys?: string[];
  scanKeys?: string[];
  atomValues?: Record<string, DhcpAtom | null | Error>;
}) {
  const desired = opts.desired ?? [];
  const scanKeys = opts.scanKeys ?? [];
  const atomValues = opts.atomValues ?? {};
  // Default enabledKeys to the derived set. A test overrides it to model a prefix that
  // is still DHCP-enabled but whose derivation threw (present here, absent from desired).
  const enabledKeys = opts.enabledKeys ?? desired.map((d) => `${d.zoneId}:${d.prefixId}`);

  const deriveAll = vi.fn().mockResolvedValue({ atoms: desired, enabledKeys: new Set(enabledKeys) });
  const derivation = { deriveAll } as unknown as DhcpDerivationService;

  const set = vi.fn().mockResolvedValue({ written: true });
  const clear = vi.fn().mockResolvedValue(undefined);
  const dhcpWriter = { set, clear } as unknown as DhcpConfigRedisWriterService;

  const readAtom = vi.fn().mockImplementation(async (zoneId: string, unprefixedKey: string) => {
    const key = `${zoneId}:${unprefixedKey}`;
    const value = atomValues[key];
    if (value instanceof Error) throw value;
    return value ?? null;
  });
  const atomWriter = { readAtom } as unknown as ConfigAtomWriter;

  const scan = vi.fn().mockResolvedValue(['0', scanKeys]);
  const redis = { scan } as unknown as import('ioredis').default;

  const logger = {
    log: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  } as unknown as LoggerService;

  const service = new DhcpConfigReconcilerService(derivation, dhcpWriter, atomWriter, redis, logger);
  return { service, set, clear, readAtom, scan, logger, deriveAll };
}

describe('DhcpConfigReconcilerService', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reads Redis (scan) before the DB (deriveAll) — reverse of write order', async () => {
    const key = keyFor(ZONE, PREFIX_ID);
    const atom = makeAtom();
    const { service, scan, deriveAll } = buildService({
      desired: [{ prefixId: PREFIX_ID, zoneId: ZONE, atom }],
      scanKeys: [key],
      atomValues: { [key]: atom },
    });

    await service.handleCron();

    expect(scan.mock.invocationCallOrder[0]).toBeLessThan(deriveAll.mock.invocationCallOrder[0]);
  });

  it('republishes a config the DB wants but Redis has no atom for (missing)', async () => {
    const atom = makeAtom();
    const { service, set } = buildService({
      desired: [{ prefixId: PREFIX_ID, zoneId: ZONE, atom }],
      scanKeys: [],
    });

    await service.handleCron();

    expect(set).toHaveBeenCalledWith(ZONE, PREFIX_ID, atom);
  });

  it('republishes when the atom exists but its value diverges', async () => {
    const key = keyFor(ZONE, PREFIX_ID);
    const desiredAtom = makeAtom({ leaseTtlSeconds: 1800 });
    const publishedAtom = makeAtom({ leaseTtlSeconds: 600 });
    const { service, set } = buildService({
      desired: [{ prefixId: PREFIX_ID, zoneId: ZONE, atom: desiredAtom }],
      scanKeys: [key],
      atomValues: { [key]: publishedAtom },
    });

    await service.handleCron();

    expect(set).toHaveBeenCalledWith(ZONE, PREFIX_ID, desiredAtom);
  });

  it('republishes when the atom is under a stale (relocated) zone', async () => {
    const staleKey = keyFor(OTHER_ZONE, PREFIX_ID);
    const atom = makeAtom();
    const { service, set, clear } = buildService({
      desired: [{ prefixId: PREFIX_ID, zoneId: ZONE, atom }],
      scanKeys: [staleKey],
      atomValues: { [staleKey]: atom },
    });

    await service.handleCron();

    // Publish under new zone
    expect(set).toHaveBeenCalledWith(ZONE, PREFIX_ID, atom);
    // Clear orphaned key under old zone
    expect(clear).toHaveBeenCalledWith(OTHER_ZONE, PREFIX_ID);
  });

  it('clears an orphaned atom the DB no longer references', async () => {
    const key = keyFor(ZONE, PREFIX_ID);
    const atom = makeAtom();
    const { service, clear, set } = buildService({
      desired: [],
      scanKeys: [key],
      atomValues: { [key]: atom },
    });

    await service.handleCron();

    expect(clear).toHaveBeenCalledWith(ZONE, PREFIX_ID);
    expect(set).not.toHaveBeenCalled();
  });

  it('preserves a published atom when the prefix is still enabled but derivation failed', async () => {
    const key = keyFor(ZONE, PREFIX_ID);
    const atom = makeAtom();
    const { service, clear, set, logger } = buildService({
      desired: [], // derivation produced no atom for it this tick
      enabledKeys: [`${ZONE}:${PREFIX_ID}`], // ...but it is still DHCP-enabled in the DB
      scanKeys: [key],
      atomValues: { [key]: atom },
    });

    await service.handleCron();

    expect(clear).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('failed to derive this tick'));
  });

  it('is a no-op in steady state (DB and Redis already agree)', async () => {
    const key = keyFor(ZONE, PREFIX_ID);
    const atom = makeAtom();
    const { service, set, clear } = buildService({
      desired: [{ prefixId: PREFIX_ID, zoneId: ZONE, atom }],
      scanKeys: [key],
      atomValues: { [key]: atom },
    });

    await service.handleCron();

    expect(set).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
  });

  it('treats an unreadable/malformed atom as divergent — republishes if desired', async () => {
    const key = keyFor(ZONE, PREFIX_ID);
    const atom = makeAtom();
    const { service, set } = buildService({
      desired: [{ prefixId: PREFIX_ID, zoneId: ZONE, atom }],
      scanKeys: [key],
      atomValues: { [key]: new Error('schema mismatch') },
    });

    await service.handleCron();

    expect(set).toHaveBeenCalledWith(ZONE, PREFIX_ID, atom);
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
    const atom = makeAtom();
    const { service, set, logger } = buildService({
      desired: [
        { prefixId: PREFIX_ID, zoneId: ZONE, atom },
        { prefixId: OTHER_PREFIX_ID, zoneId: ZONE, atom },
      ],
      scanKeys: [],
    });
    set.mockRejectedValueOnce(new Error('redis down')).mockResolvedValueOnce({ written: true });

    await service.handleCron();

    expect(set).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Failed to republish'));
  });

  it('aborts safely when the Redis SCAN step throws (no orphan-clearing on transient failure)', async () => {
    const { service, scan, set, clear, deriveAll, logger } = buildService({
      desired: [{ prefixId: PREFIX_ID, zoneId: ZONE, atom: makeAtom() }],
      scanKeys: [],
    });
    scan.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    await service.handleCron();

    expect(set).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
    // deriveAll runs AFTER scan, so it must not have been reached.
    expect(deriveAll).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('ECONNREFUSED'));
  });

  it('does not abort the tick when one orphan fails to clear', async () => {
    const OTHER_PREFIX_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    const key1 = keyFor(ZONE, PREFIX_ID);
    const key2 = keyFor(ZONE, OTHER_PREFIX_ID);
    const atom = makeAtom();
    const { service, clear, logger } = buildService({
      desired: [],
      scanKeys: [key1, key2],
      atomValues: { [key1]: atom, [key2]: atom },
    });
    clear.mockRejectedValueOnce(new Error('redis down')).mockResolvedValueOnce(undefined);

    await service.handleCron();

    expect(clear).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Failed to clear orphaned'));
  });
});
