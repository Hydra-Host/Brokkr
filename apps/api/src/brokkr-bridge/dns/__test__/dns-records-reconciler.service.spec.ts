import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConfigAtomWriter } from '../../../common/redis';
import type { LoggerService } from '../../../logger/logger.service';
import type { PrismaClient } from '../../../prisma/prisma.client';
import type { DnsRecordDerivationService } from '../dns-record-derivation.service';
import type { DnsRecordsAtom } from '../dns-records-atom.schema';
import type { DnsRecordsPublisherService } from '../dns-records-publisher.service';
import { DnsRecordsReconcilerService } from '../dns-records-reconciler.service';

const ZONE = 'deca8b4c-2e65-4f75-96e5-67bdcdc9d79a';
const OTHER_ZONE = '11111111-1111-1111-1111-111111111111';

const ATOM: DnsRecordsAtom = {
  domains: [
    {
      name: 'example.lan',
      type: 'FORWARD',
      records: [{ name: 'host-a', type: 'A', value: '10.0.0.1', ttl: null }],
    },
  ],
};

const DIVERGENT_ATOM: DnsRecordsAtom = {
  domains: [
    {
      name: 'example.lan',
      type: 'FORWARD',
      records: [{ name: 'host-b', type: 'A', value: '10.0.0.2', ttl: null }],
    },
  ],
};

function keyFor(zoneId: string): string {
  return `${zoneId}:config:dns-records`;
}

function buildService(opts: {
  desiredZoneIds?: string[];
  buildAtomResults?: Record<string, DnsRecordsAtom | null>;
  scanKeys?: string[];
  atomValues?: Record<string, DnsRecordsAtom | null | Error>;
}) {
  const desiredZoneIds = opts.desiredZoneIds ?? [];
  const buildAtomResults = opts.buildAtomResults ?? {};
  const scanKeysList = opts.scanKeys ?? [];
  const atomValues = opts.atomValues ?? {};

  const rederiveAll = vi.fn().mockResolvedValue(undefined);
  const derivation = { rederiveAll } as unknown as DnsRecordDerivationService;

  const republishForZone = vi.fn().mockResolvedValue(undefined);
  const clearForZone = vi.fn().mockResolvedValue(undefined);
  const publishAtom = vi.fn().mockResolvedValue(undefined);
  const clearAtom = vi.fn().mockResolvedValue(undefined);
  const buildAtomForZone = vi.fn().mockImplementation(async (zoneId: string) => {
    return buildAtomResults[zoneId] ?? null;
  });
  const publisher = {
    republishForZone,
    clearForZone,
    publishAtom,
    clearAtom,
    buildAtomForZone,
  } as unknown as DnsRecordsPublisherService;

  const readAtom = vi.fn().mockImplementation(async (zoneId: string, _unprefixedKey: string) => {
    const key = keyFor(zoneId);
    const value = atomValues[key];
    if (value instanceof Error) throw value;
    return value ?? null;
  });
  const atomWriter = { readAtom } as unknown as ConfigAtomWriter;

  const scan = vi.fn().mockResolvedValue(['0', scanKeysList]);
  const set = vi.fn().mockResolvedValue('OK');
  const del = vi.fn().mockResolvedValue(1);
  const redis = { scan, set, del } as unknown as import('ioredis').default;

  const $queryRaw = vi.fn().mockResolvedValue(desiredZoneIds.map((zoneId) => ({ zoneId })));
  const prisma = { $queryRaw } as unknown as PrismaClient;

  const logger = { log: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as unknown as LoggerService;

  const service = new DnsRecordsReconcilerService(derivation, publisher, atomWriter, redis, prisma, logger);
  return {
    service,
    rederiveAll,
    republishForZone,
    clearForZone,
    publishAtom,
    clearAtom,
    buildAtomForZone,
    scan,
    set,
    del,
    $queryRaw,
    logger,
  };
}

describe('DnsRecordsReconcilerService', () => {
  beforeEach(() => vi.clearAllMocks());

  it('runs derivation before reconciling atoms', async () => {
    const { service, rederiveAll, scan } = buildService({
      desiredZoneIds: [ZONE],
      buildAtomResults: { [ZONE]: ATOM },
      scanKeys: [],
    });

    await service.handleCron();

    expect(rederiveAll).toHaveBeenCalledTimes(1);
    expect(rederiveAll.mock.invocationCallOrder[0]).toBeLessThan(scan.mock.invocationCallOrder[0]);
  });

  it('publishes a zone the DB wants but Redis has no atom for (missing)', async () => {
    const { service, publishAtom } = buildService({
      desiredZoneIds: [ZONE],
      buildAtomResults: { [ZONE]: ATOM },
      scanKeys: [],
    });

    await service.handleCron();

    expect(publishAtom).toHaveBeenCalledWith(ZONE, ATOM);
  });

  it('publishes when the atom exists but its value diverges from the DB', async () => {
    const key = keyFor(ZONE);
    const { service, publishAtom } = buildService({
      desiredZoneIds: [ZONE],
      buildAtomResults: { [ZONE]: ATOM },
      scanKeys: [key],
      atomValues: { [key]: DIVERGENT_ATOM },
    });

    await service.handleCron();

    expect(publishAtom).toHaveBeenCalledWith(ZONE, ATOM);
  });

  it('excludes dns-disabled zones from the desired set so their atoms are cleared', async () => {
    const key = keyFor(ZONE);
    const { service, clearAtom, $queryRaw } = buildService({
      desiredZoneIds: [],
      scanKeys: [key],
      atomValues: { [key]: ATOM },
    });

    await service.handleCron();

    const [template] = $queryRaw.mock.calls[0];
    expect(template.join('?')).toContain('"dnsEnabled" = true');
    expect(clearAtom).toHaveBeenCalledWith(ZONE);
  });

  it('clears an orphaned atom the DB no longer references', async () => {
    const key = keyFor(ZONE);
    const { service, clearAtom, publishAtom } = buildService({
      desiredZoneIds: [],
      scanKeys: [key],
      atomValues: { [key]: ATOM },
    });

    await service.handleCron();

    expect(clearAtom).toHaveBeenCalledWith(ZONE);
    expect(publishAtom).not.toHaveBeenCalled();
  });

  it('is a no-op in steady state (DB and Redis already agree)', async () => {
    const key = keyFor(ZONE);
    const { service, publishAtom, clearAtom } = buildService({
      desiredZoneIds: [ZONE],
      buildAtomResults: { [ZONE]: ATOM },
      scanKeys: [key],
      atomValues: { [key]: ATOM },
    });

    await service.handleCron();

    expect(publishAtom).not.toHaveBeenCalled();
    expect(clearAtom).not.toHaveBeenCalled();
  });

  it('treats an unreadable/malformed atom as divergent — republishes if desired', async () => {
    const key = keyFor(ZONE);
    const { service, publishAtom } = buildService({
      desiredZoneIds: [ZONE],
      buildAtomResults: { [ZONE]: ATOM },
      scanKeys: [key],
      atomValues: { [key]: new Error('schema mismatch') },
    });

    await service.handleCron();

    expect(publishAtom).toHaveBeenCalledWith(ZONE, ATOM);
  });

  it('skips when Redis distributed lock is not acquired', async () => {
    const { service, set, publishAtom, clearAtom } = buildService({ desiredZoneIds: [ZONE] });
    set.mockResolvedValue(null);

    await service.handleCron();

    expect(publishAtom).not.toHaveBeenCalled();
    expect(clearAtom).not.toHaveBeenCalled();
  });

  it('releases the Redis lock after reconciliation completes', async () => {
    const { service, del } = buildService({ desiredZoneIds: [], scanKeys: [] });

    await service.handleCron();

    expect(del).toHaveBeenCalledWith('dns-records-reconciler:lock');
  });

  it('does not abort the tick when one zone fails to derive', async () => {
    const { service, publishAtom, clearAtom, buildAtomForZone } = buildService({
      desiredZoneIds: [ZONE, OTHER_ZONE],
      buildAtomResults: { [ZONE]: ATOM, [OTHER_ZONE]: ATOM },
      scanKeys: [keyFor(ZONE)],
      atomValues: { [keyFor(ZONE)]: ATOM },
    });
    buildAtomForZone.mockRejectedValueOnce(new Error('db down')).mockResolvedValueOnce(ATOM);

    await service.handleCron();

    expect(publishAtom).toHaveBeenCalledWith(OTHER_ZONE, ATOM);
    expect(clearAtom).not.toHaveBeenCalled();
  });

  it('clears orphan from a zone that had domains deleted', async () => {
    const key = keyFor(OTHER_ZONE);
    const { service, clearAtom } = buildService({
      desiredZoneIds: [ZONE],
      buildAtomResults: { [ZONE]: ATOM },
      scanKeys: [keyFor(ZONE), key],
      atomValues: {
        [keyFor(ZONE)]: ATOM,
        [key]: DIVERGENT_ATOM,
      },
    });

    await service.handleCron();

    expect(clearAtom).toHaveBeenCalledWith(OTHER_ZONE);
  });
});
