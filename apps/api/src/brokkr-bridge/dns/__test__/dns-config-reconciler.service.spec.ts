import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConfigAtomWriter } from '../../../common/redis';
import type { LoggerService } from '../../../logger/logger.service';
import type { DnsConfigAtom, DnsPrefixOverrideAtom } from '../dns-atom.schema';
import { DnsConfigReconcilerService } from '../dns-config-reconciler.service';
import type { DnsConfigRedisWriterService } from '../dns-config-redis-writer.service';
import type { DnsDerivationService } from '../dns-derivation.service';

const ZONE = 'deca8b4c-2e65-4f75-96e5-67bdcdc9d79a';
const PREFIX_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

function makeZoneAtom(overrides: Partial<DnsConfigAtom> = {}): DnsConfigAtom {
  return {
    enabled: true,
    upstreamResolvers: ['8.8.8.8'],
    ttlSeconds: 60,
    cacheSize: 1000,
    ownedDomain: 'lan',
    hostnames: [],
    tcpEnabled: true,
    tcpMaxConnections: 20,
    tcpMaxQueriesPerConn: 100,
    tcpIdleTimeoutMs: 5000,
    tcpMaxMessageBytes: 4096,
    maxTtlSeconds: 0,
    maxCacheTtlSeconds: 0,
    minCacheTtlSeconds: 0,
    negTtlSeconds: 0,
    ...overrides,
  };
}

function makePrefixAtom(overrides: Partial<DnsPrefixOverrideAtom> = {}): DnsPrefixOverrideAtom {
  return {
    serveDns: true,
    upstreamOverride: [],
    ...overrides,
  };
}

function zoneKeyFor(zoneId: string): string {
  return `${zoneId}:config:dns`;
}

function prefixKeyFor(zoneId: string, prefixId: string): string {
  return `${zoneId}:prefix:${prefixId}:config:dns`;
}

interface BuildOpts {
  desiredZones?: Array<{ zoneId: string; atom: DnsConfigAtom }>;
  zoneEnabledKeys?: string[];
  zoneQueryFailed?: boolean;
  desiredPrefixes?: Array<{ prefixId: string; zoneId: string; atom: DnsPrefixOverrideAtom }>;
  prefixEnabledKeys?: string[];
  prefixQueryFailed?: boolean;
  scanZoneKeys?: string[];
  scanPrefixKeys?: string[];
  atomValues?: Record<string, unknown>;
}

function buildService(opts: BuildOpts = {}) {
  const desiredZones = opts.desiredZones ?? [];
  const desiredPrefixes = opts.desiredPrefixes ?? [];
  const zoneEnabledKeys = opts.zoneEnabledKeys ?? desiredZones.map((d) => d.zoneId);
  const prefixEnabledKeys = opts.prefixEnabledKeys ?? desiredPrefixes.map((d) => `${d.zoneId}:${d.prefixId}`);
  const scanZoneKeys = opts.scanZoneKeys ?? [];
  const scanPrefixKeys = opts.scanPrefixKeys ?? [];
  const atomValues = opts.atomValues ?? {};

  const deriveAllZones = vi.fn().mockResolvedValue({
    atoms: desiredZones,
    enabledKeys: new Set(zoneEnabledKeys),
    queryFailed: opts.zoneQueryFailed ?? false,
  });
  const deriveAllPrefixes = vi.fn().mockResolvedValue({
    atoms: desiredPrefixes,
    enabledKeys: new Set(prefixEnabledKeys),
    queryFailed: opts.prefixQueryFailed ?? false,
  });
  const derivation = { deriveAllZones, deriveAllPrefixes } as unknown as DnsDerivationService;

  const setZone = vi.fn().mockResolvedValue({ written: true });
  const clearZone = vi.fn().mockResolvedValue(undefined);
  const setPrefix = vi.fn().mockResolvedValue({ written: true });
  const clearPrefix = vi.fn().mockResolvedValue(undefined);
  const dnsWriter = { setZone, clearZone, setPrefix, clearPrefix } as unknown as DnsConfigRedisWriterService;

  const readAtom = vi.fn().mockImplementation(async (zoneId: string, unprefixedKey: string) => {
    const key = `${zoneId}:${unprefixedKey}`;
    const value = atomValues[key];
    if (value instanceof Error) throw value;
    return value ?? null;
  });
  const atomWriter = { readAtom } as unknown as ConfigAtomWriter;

  let scanCallCount = 0;
  const scan = vi.fn().mockImplementation(async () => {
    scanCallCount++;
    if (scanCallCount === 1) return ['0', scanZoneKeys];
    return ['0', scanPrefixKeys];
  });
  const redis = { scan } as unknown as import('ioredis').default;

  const logger = {
    log: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  } as unknown as LoggerService;

  const service = new DnsConfigReconcilerService(derivation, dnsWriter, atomWriter, redis, logger);
  return {
    service,
    setZone,
    clearZone,
    setPrefix,
    clearPrefix,
    readAtom,
    scan,
    logger,
    deriveAllZones,
    deriveAllPrefixes,
  };
}

describe('DnsConfigReconcilerService', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('zone reconciliation', () => {
    it('republishes a zone config the DB wants but Redis lacks', async () => {
      const atom = makeZoneAtom();
      const { service, setZone } = buildService({
        desiredZones: [{ zoneId: ZONE, atom }],
        scanZoneKeys: [],
      });

      await service.handleCron();

      expect(setZone).toHaveBeenCalledWith(ZONE, atom);
    });

    it('republishes when the zone atom diverges', async () => {
      const key = zoneKeyFor(ZONE);
      const desiredAtom = makeZoneAtom({ ttlSeconds: 120 });
      const publishedAtom = makeZoneAtom({ ttlSeconds: 60 });
      const { service, setZone } = buildService({
        desiredZones: [{ zoneId: ZONE, atom: desiredAtom }],
        scanZoneKeys: [key],
        atomValues: { [key]: publishedAtom },
      });

      await service.handleCron();

      expect(setZone).toHaveBeenCalledWith(ZONE, desiredAtom);
    });

    it('clears an orphaned zone atom the DB no longer references', async () => {
      const key = zoneKeyFor(ZONE);
      const atom = makeZoneAtom();
      const { service, clearZone, setZone } = buildService({
        desiredZones: [],
        scanZoneKeys: [key],
        atomValues: { [key]: atom },
      });

      await service.handleCron();

      expect(clearZone).toHaveBeenCalledWith(ZONE);
      expect(setZone).not.toHaveBeenCalled();
    });

    it('preserves a published zone atom when derivation failed this tick', async () => {
      const key = zoneKeyFor(ZONE);
      const atom = makeZoneAtom();
      const { service, clearZone, setZone, logger } = buildService({
        desiredZones: [],
        zoneEnabledKeys: [ZONE],
        scanZoneKeys: [key],
        atomValues: { [key]: atom },
      });

      await service.handleCron();

      expect(clearZone).not.toHaveBeenCalled();
      expect(setZone).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('failed to derive this tick'));
    });

    it('silently skips prefix keys matched by the zone SCAN without logging a warning', async () => {
      const prefixKey = prefixKeyFor(ZONE, PREFIX_ID);
      const { service, logger } = buildService({
        desiredZones: [],
        scanZoneKeys: [prefixKey],
      });

      await service.handleCron();

      expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining('Unrecognized DNS zone atom key shape'));
    });

    it('skips orphan cleanup when zone query failed', async () => {
      const key = zoneKeyFor(ZONE);
      const atom = makeZoneAtom();
      const { service, clearZone, setZone, logger } = buildService({
        desiredZones: [],
        zoneQueryFailed: true,
        scanZoneKeys: [key],
        atomValues: { [key]: atom },
      });

      await service.handleCron();

      expect(clearZone).not.toHaveBeenCalled();
      expect(setZone).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('zone query failed'));
    });

    it('is a no-op in steady state', async () => {
      const key = zoneKeyFor(ZONE);
      const atom = makeZoneAtom();
      const { service, setZone, clearZone } = buildService({
        desiredZones: [{ zoneId: ZONE, atom }],
        scanZoneKeys: [key],
        atomValues: { [key]: atom },
      });

      await service.handleCron();

      expect(setZone).not.toHaveBeenCalled();
      expect(clearZone).not.toHaveBeenCalled();
    });
  });

  describe('prefix reconciliation', () => {
    it('republishes a prefix override the DB wants but Redis lacks', async () => {
      const atom = makePrefixAtom();
      const { service, setPrefix } = buildService({
        desiredPrefixes: [{ prefixId: PREFIX_ID, zoneId: ZONE, atom }],
        scanPrefixKeys: [],
      });

      await service.handleCron();

      expect(setPrefix).toHaveBeenCalledWith(ZONE, PREFIX_ID, atom);
    });

    it('clears an orphaned prefix override atom', async () => {
      const key = prefixKeyFor(ZONE, PREFIX_ID);
      const atom = makePrefixAtom();
      const { service, clearPrefix, setPrefix } = buildService({
        desiredPrefixes: [],
        scanPrefixKeys: [key],
        atomValues: { [key]: atom },
      });

      await service.handleCron();

      expect(clearPrefix).toHaveBeenCalledWith(ZONE, PREFIX_ID);
      expect(setPrefix).not.toHaveBeenCalled();
    });

    it('skips orphan cleanup when prefix query failed', async () => {
      const key = prefixKeyFor(ZONE, PREFIX_ID);
      const atom = makePrefixAtom();
      const { service, clearPrefix, setPrefix, logger } = buildService({
        desiredPrefixes: [],
        prefixQueryFailed: true,
        scanPrefixKeys: [key],
        atomValues: { [key]: atom },
      });

      await service.handleCron();

      expect(clearPrefix).not.toHaveBeenCalled();
      expect(setPrefix).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('prefix query failed'));
    });

    it('preserves a published prefix atom when derivation failed this tick', async () => {
      const key = prefixKeyFor(ZONE, PREFIX_ID);
      const atom = makePrefixAtom();
      const { service, clearPrefix, setPrefix, logger } = buildService({
        desiredPrefixes: [],
        prefixEnabledKeys: [`${ZONE}:${PREFIX_ID}`],
        scanPrefixKeys: [key],
        atomValues: { [key]: atom },
      });

      await service.handleCron();

      expect(clearPrefix).not.toHaveBeenCalled();
      expect(setPrefix).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('failed to derive this tick'));
    });
  });

  describe('reentrancy guard', () => {
    it('skips a re-entrant tick while a previous run is still in flight', async () => {
      const { service, scan, logger } = buildService();
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
  });
});
