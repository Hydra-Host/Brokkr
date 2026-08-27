import type { ConfigAtomWriter } from 'src/common/redis';
import { DNS_CONFIG_KEY, TTL_DNS_CONFIG_SECONDS, dnsPrefixConfig } from 'src/common/redis';
import { vi } from 'vitest';
import {
  DnsConfigAtomSchema,
  DnsPrefixOverrideAtomSchema,
  type DnsConfigAtom,
  type DnsPrefixOverrideAtom,
} from '../dns-atom.schema';
import { DnsConfigRedisWriterService } from '../dns-config-redis-writer.service';

describe('DnsConfigRedisWriterService', () => {
  let service: DnsConfigRedisWriterService;
  let writeAtomJson: ReturnType<typeof vi.fn>;
  let delKey: ReturnType<typeof vi.fn>;
  const ZONE = '99999999-0000-0000-0000-000000000000';
  const PREFIX_ID = '11111111-2222-3333-4444-555555555555';
  const ZONE_ATOM: DnsConfigAtom = {
    enabled: true,
    upstreamResolvers: ['8.8.8.8'],
    ttlSeconds: 60,
    cacheSize: 1000,
    ownedDomain: 'lan',
    hostnames: ['bridge-1'],
    tcpEnabled: true,
    tcpMaxConnections: 20,
    tcpMaxQueriesPerConn: 100,
    tcpIdleTimeoutMs: 5000,
    tcpMaxMessageBytes: 4096,
    maxTtlSeconds: 0,
    maxCacheTtlSeconds: 0,
    minCacheTtlSeconds: 0,
    negTtlSeconds: 0,
  };
  const PREFIX_ATOM: DnsPrefixOverrideAtom = {
    serveDns: true,
    upstreamOverride: ['1.1.1.1'],
    cidr: '10.0.1.0/24',
  };

  beforeEach(() => {
    writeAtomJson = vi.fn().mockResolvedValue({ written: true });
    delKey = vi.fn().mockResolvedValue(undefined);

    const atomWriter = { writeAtomJson, delKey } as unknown as ConfigAtomWriter;
    const logger = {
      log: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as never;

    service = new DnsConfigRedisWriterService(atomWriter, logger);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('writes zone DNS config at the correct key with TTL 0', async () => {
    await service.setZone(ZONE, ZONE_ATOM);
    expect(writeAtomJson).toHaveBeenCalledWith(
      ZONE,
      DNS_CONFIG_KEY,
      ZONE_ATOM,
      DnsConfigAtomSchema,
      TTL_DNS_CONFIG_SECONDS,
      { request_id: null },
    );
  });

  it('deletes zone DNS config key', async () => {
    await service.clearZone(ZONE);
    expect(delKey).toHaveBeenCalledWith(ZONE, DNS_CONFIG_KEY);
  });

  it('writes prefix DNS override at the correct key with TTL 0', async () => {
    await service.setPrefix(ZONE, PREFIX_ID, PREFIX_ATOM);
    expect(writeAtomJson).toHaveBeenCalledWith(
      ZONE,
      dnsPrefixConfig(PREFIX_ID),
      PREFIX_ATOM,
      DnsPrefixOverrideAtomSchema,
      TTL_DNS_CONFIG_SECONDS,
      { request_id: null },
    );
  });

  it('deletes prefix DNS override key', async () => {
    await service.clearPrefix(ZONE, PREFIX_ID);
    expect(delKey).toHaveBeenCalledWith(ZONE, dnsPrefixConfig(PREFIX_ID));
  });

  it('surfaces the write result when the envelope is stale', async () => {
    writeAtomJson.mockResolvedValueOnce({ written: false, reason: 'stale' });
    await expect(service.setZone(ZONE, ZONE_ATOM)).resolves.toEqual({
      written: false,
      reason: 'stale',
    });
  });

  it('surfaces a contextual error when writeAtomJson rejects', async () => {
    writeAtomJson.mockRejectedValueOnce(new Error('redis down'));
    await expect(service.setZone(ZONE, ZONE_ATOM)).rejects.toThrow('redis down');
  });

  it('verifies TTL_DNS_CONFIG_SECONDS is 0', () => {
    expect(TTL_DNS_CONFIG_SECONDS).toBe(0);
  });

  it('verifies dnsConfig key format', () => {
    expect(DNS_CONFIG_KEY).toBe('config:dns');
  });

  it('verifies dnsPrefixConfig key format', () => {
    expect(dnsPrefixConfig(PREFIX_ID)).toBe(`prefix:${PREFIX_ID}:config:dns`);
  });
});
