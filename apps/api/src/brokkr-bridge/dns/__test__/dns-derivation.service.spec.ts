import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DnsDerivationService } from '../dns-derivation.service';

const ZONE_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const PREFIX_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

function makeZoneRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ZONE_ID,
    dnsEnabled: true,
    dnsUpstreamResolvers: ['8.8.8.8', '1.1.1.1'],
    dnsTtlSeconds: 60,
    dnsCacheSize: 1000,
    dnsOwnedDomain: 'lan',
    dnsUpstreamTimeoutMs: 1000,
    dnsPollMs: 2000,
    dnsTcpMaxConnections: 20,
    dnsTcpMaxQueriesPerConn: 100,
    dnsTcpIdleTimeoutMs: 5000,
    dnsTcpMaxMessageBytes: 4096,
    dnsMaxTtlSeconds: 0,
    dnsMaxCacheTtlSeconds: 0,
    dnsMinCacheTtlSeconds: 0,
    dnsNegTtlSeconds: 0,
    devices: [{ name: 'bridge-1' }],
    ...overrides,
  };
}

function makePrefixRow(overrides: Record<string, unknown> = {}) {
  return {
    prefixId: PREFIX_ID,
    zoneId: ZONE_ID,
    cidr: '10.0.1.0/24',
    dnsServeDns: true,
    dnsUpstreamOverride: ['1.1.1.1'],
    ...overrides,
  };
}

function buildService(opts: { zones?: unknown[]; prefixes?: unknown[] } = {}) {
  const zones = opts.zones ?? [];
  const prefixes = opts.prefixes ?? [];

  const zoneFindMany = vi.fn().mockResolvedValue(zones);
  const queryRaw = vi.fn().mockResolvedValue(prefixes);
  const prisma = {
    zone: { findMany: zoneFindMany },
    $queryRaw: queryRaw,
  };
  const logger = {
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };

  const service = new DnsDerivationService(prisma as never, logger as never);
  return { service, prisma, zoneFindMany, queryRaw, logger };
}

describe('DnsDerivationService', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('deriveAllZones', () => {
    it('derives atoms for all DNS-enabled zones', async () => {
      const { service } = buildService({ zones: [makeZoneRow()] });
      const result = await service.deriveAllZones();
      expect(result.atoms).toHaveLength(1);
      expect(result.atoms[0].zoneId).toBe(ZONE_ID);
      expect(result.atoms[0].atom.enabled).toBe(true);
      expect(result.atoms[0].atom.upstreamResolvers).toEqual(['1.1.1.1', '8.8.8.8']);
      expect(result.enabledKeys.has(ZONE_ID)).toBe(true);
    });

    it('derives atom with enabled=false for a DNS-disabled zone', async () => {
      const { service } = buildService({ zones: [makeZoneRow({ dnsEnabled: false })] });
      const result = await service.deriveAllZones();
      expect(result.atoms).toHaveLength(1);
      expect(result.atoms[0].atom.enabled).toBe(false);
      expect(result.enabledKeys.has(ZONE_ID)).toBe(true);
    });

    it('returns empty with queryFailed on query failure', async () => {
      const { service, zoneFindMany } = buildService();
      zoneFindMany.mockRejectedValue(new Error('db down'));
      const result = await service.deriveAllZones();
      expect(result.atoms).toHaveLength(0);
      expect(result.enabledKeys.size).toBe(0);
      expect(result.queryFailed).toBe(true);
    });

    it('sets queryFailed=false on successful derivation', async () => {
      const { service } = buildService({ zones: [makeZoneRow()] });
      const result = await service.deriveAllZones();
      expect(result.queryFailed).toBe(false);
    });

    it('skips zones whose atom derivation throws but still includes their key', async () => {
      const badRow = makeZoneRow({ dnsTtlSeconds: -1 });
      const { service, logger } = buildService({ zones: [badRow] });
      const result = await service.deriveAllZones();
      expect(result.atoms).toHaveLength(0);
      expect(result.enabledKeys.has(ZONE_ID)).toBe(true);
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Failed to derive DNS zone atom'));
    });
  });

  describe('deriveOneZone', () => {
    it('returns ok with the derived atom', async () => {
      const { service } = buildService({ zones: [makeZoneRow()] });
      const result = await service.deriveOneZone(ZONE_ID);
      expect(result.status).toBe('ok');
      if (result.status === 'ok') {
        expect(result.atom.ownedDomain).toBe('lan');
      }
    });

    it('returns ok with enabled=false for a DNS-disabled zone', async () => {
      const { service } = buildService({ zones: [makeZoneRow({ dnsEnabled: false })] });
      const result = await service.deriveOneZone(ZONE_ID);
      expect(result.status).toBe('ok');
      if (result.status === 'ok') {
        expect(result.atom.enabled).toBe(false);
      }
    });

    it('returns not_found when the zone does not exist', async () => {
      const { service } = buildService({ zones: [] });
      const result = await service.deriveOneZone(ZONE_ID);
      expect(result.status).toBe('not_found');
    });

    it('returns error on query failure', async () => {
      const { service, zoneFindMany } = buildService();
      zoneFindMany.mockRejectedValue(new Error('db down'));
      const result = await service.deriveOneZone(ZONE_ID);
      expect(result.status).toBe('error');
    });
  });

  describe('buildZoneAtom', () => {
    it('passes through DB ms value to atom tcpIdleTimeoutMs', () => {
      const { service } = buildService();
      const row = {
        zoneId: ZONE_ID,
        dnsEnabled: true,
        dnsUpstreamResolvers: ['8.8.8.8'],
        dnsTtlSeconds: 60,
        dnsCacheSize: 1000,
        dnsOwnedDomain: 'lan',
        dnsUpstreamTimeoutMs: 1000,
        dnsPollMs: 2000,
        dnsTcpMaxConnections: 20,
        dnsTcpMaxQueriesPerConn: 100,
        dnsTcpIdleTimeoutMs: 5000,
        dnsTcpMaxMessageBytes: 4096,
        dnsMaxTtlSeconds: 0,
        dnsMaxCacheTtlSeconds: 0,
        dnsMinCacheTtlSeconds: 0,
        dnsNegTtlSeconds: 0,
        bridgeHostnames: ['bridge-1'],
      };
      const atom = service.buildZoneAtom(row);
      expect(atom.tcpIdleTimeoutMs).toBe(5000);
      expect(atom.tcpEnabled).toBe(true);
    });

    it('filters out non-IPv4 upstream resolvers', () => {
      const { service, logger } = buildService();
      const row = {
        zoneId: ZONE_ID,
        dnsEnabled: true,
        dnsUpstreamResolvers: ['8.8.8.8', 'not-an-ip', '1.1.1.1'],
        dnsTtlSeconds: 60,
        dnsCacheSize: 1000,
        dnsOwnedDomain: 'lan',
        dnsUpstreamTimeoutMs: 1000,
        dnsPollMs: 2000,
        dnsTcpMaxConnections: 20,
        dnsTcpMaxQueriesPerConn: 100,
        dnsTcpIdleTimeoutMs: 5000,
        dnsTcpMaxMessageBytes: 4096,
        dnsMaxTtlSeconds: 0,
        dnsMaxCacheTtlSeconds: 0,
        dnsMinCacheTtlSeconds: 0,
        dnsNegTtlSeconds: 0,
        bridgeHostnames: [],
      };
      const atom = service.buildZoneAtom(row);
      expect(atom.upstreamResolvers).toEqual(['1.1.1.1', '8.8.8.8']);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('not IPv4'));
    });

    it('clamps tcpMaxConnections to minimum 1', () => {
      const { service } = buildService();
      const row = {
        zoneId: ZONE_ID,
        dnsEnabled: true,
        dnsUpstreamResolvers: [],
        dnsTtlSeconds: 60,
        dnsCacheSize: 1000,
        dnsOwnedDomain: 'lan',
        dnsUpstreamTimeoutMs: 1000,
        dnsPollMs: 2000,
        dnsTcpMaxConnections: 0,
        dnsTcpMaxQueriesPerConn: 0,
        dnsTcpIdleTimeoutMs: 0,
        dnsTcpMaxMessageBytes: 0,
        dnsMaxTtlSeconds: 0,
        dnsMaxCacheTtlSeconds: 0,
        dnsMinCacheTtlSeconds: 0,
        dnsNegTtlSeconds: 0,
        bridgeHostnames: [],
      };
      const atom = service.buildZoneAtom(row);
      expect(atom.tcpMaxConnections).toBe(1);
      expect(atom.tcpMaxQueriesPerConn).toBe(1);
      expect(atom.tcpIdleTimeoutMs).toBe(1);
      expect(atom.tcpMaxMessageBytes).toBe(1);
    });

    it('omits unset optional knobs so bridge defaults apply', () => {
      const { service } = buildService();
      const row = {
        zoneId: ZONE_ID,
        dnsEnabled: true,
        dnsUpstreamResolvers: [],
        dnsTtlSeconds: 60,
        dnsCacheSize: 1000,
        dnsOwnedDomain: 'lan',
        dnsUpstreamTimeoutMs: 1000,
        dnsPollMs: 2000,
        dnsTcpMaxConnections: null,
        dnsTcpMaxQueriesPerConn: null,
        dnsTcpIdleTimeoutMs: null,
        dnsTcpMaxMessageBytes: null,
        dnsMaxTtlSeconds: null,
        dnsMaxCacheTtlSeconds: null,
        dnsMinCacheTtlSeconds: null,
        dnsNegTtlSeconds: null,
        bridgeHostnames: [],
      };
      const atom = service.buildZoneAtom(row);
      expect(atom.tcpMaxConnections).toBeUndefined();
      expect(atom.tcpMaxQueriesPerConn).toBeUndefined();
      expect(atom.tcpIdleTimeoutMs).toBeUndefined();
      expect(atom.tcpMaxMessageBytes).toBeUndefined();
      expect(atom.maxTtlSeconds).toBeUndefined();
      expect(atom.maxCacheTtlSeconds).toBeUndefined();
      expect(atom.minCacheTtlSeconds).toBeUndefined();
      expect(atom.negTtlSeconds).toBeUndefined();
    });

    it('defaults ownedDomain to "lan" when empty', () => {
      const { service } = buildService();
      const row = {
        zoneId: ZONE_ID,
        dnsEnabled: true,
        dnsUpstreamResolvers: [],
        dnsTtlSeconds: 60,
        dnsCacheSize: 1000,
        dnsOwnedDomain: '',
        dnsUpstreamTimeoutMs: 1000,
        dnsPollMs: 2000,
        dnsTcpMaxConnections: 20,
        dnsTcpMaxQueriesPerConn: 100,
        dnsTcpIdleTimeoutMs: 5000,
        dnsTcpMaxMessageBytes: 4096,
        dnsMaxTtlSeconds: 0,
        dnsMaxCacheTtlSeconds: 0,
        dnsMinCacheTtlSeconds: 0,
        dnsNegTtlSeconds: 0,
        bridgeHostnames: [],
      };
      const atom = service.buildZoneAtom(row);
      expect(atom.ownedDomain).toBe('lan');
    });
  });

  describe('deriveAllPrefixes', () => {
    it('derives atoms for prefixes with DNS overrides', async () => {
      const { service } = buildService({ prefixes: [makePrefixRow()] });
      const result = await service.deriveAllPrefixes();
      expect(result.atoms).toHaveLength(1);
      expect(result.atoms[0].prefixId).toBe(PREFIX_ID);
      expect(result.atoms[0].atom.serveDns).toBe(true);
      expect(result.atoms[0].atom.cidr).toBe('10.0.1.0/24');
    });

    it('returns empty with queryFailed on query failure', async () => {
      const { service, queryRaw } = buildService();
      queryRaw.mockRejectedValue(new Error('db down'));
      const result = await service.deriveAllPrefixes();
      expect(result.atoms).toHaveLength(0);
      expect(result.queryFailed).toBe(true);
    });

    it('sets queryFailed=false on successful derivation', async () => {
      const { service } = buildService({ prefixes: [makePrefixRow()] });
      const result = await service.deriveAllPrefixes();
      expect(result.queryFailed).toBe(false);
    });
  });

  describe('deriveOnePrefix', () => {
    it('returns ok with the derived atom', async () => {
      const { service } = buildService({ prefixes: [makePrefixRow()] });
      const result = await service.deriveOnePrefix(PREFIX_ID);
      expect(result.status).toBe('ok');
      if (result.status === 'ok') {
        expect(result.atom.upstreamOverride).toEqual(['1.1.1.1']);
      }
    });

    it('returns not_found when no override exists', async () => {
      const { service } = buildService({ prefixes: [] });
      const result = await service.deriveOnePrefix(PREFIX_ID);
      expect(result.status).toBe('not_found');
    });
  });

  describe('buildPrefixAtom', () => {
    it('filters out non-IPv4 upstream overrides', () => {
      const { service, logger } = buildService();
      const row = {
        prefixId: PREFIX_ID,
        zoneId: ZONE_ID,
        cidr: '10.0.1.0/24',
        dnsServeDns: null,
        dnsUpstreamOverride: ['1.1.1.1', 'bad-ip'],
      };
      const atom = service.buildPrefixAtom(row);
      expect(atom.upstreamOverride).toEqual(['1.1.1.1']);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('not IPv4'));
    });

    it('carries the prefix cidr into the atom', () => {
      const { service } = buildService();
      const row = {
        prefixId: PREFIX_ID,
        zoneId: ZONE_ID,
        cidr: '172.16.8.0/22',
        dnsServeDns: true,
        dnsUpstreamOverride: [],
      };
      const atom = service.buildPrefixAtom(row);
      expect(atom.cidr).toBe('172.16.8.0/22');
    });
  });
});
