import type { ConfigAtomWriter } from 'src/common/redis';
import { DHCP_ZONE_CONFIG_KEY, TTL_DHCP_CONFIG_SECONDS, dhcpConfig } from 'src/common/redis';
import { vi } from 'vitest';
import { DhcpAtomSchema, DhcpZoneOpsAtomSchema, type DhcpAtom, type DhcpZoneOpsAtom } from '../dhcp-atom.schema';
import { DhcpConfigRedisWriterService } from '../dhcp-config-redis-writer.service';

describe('DhcpConfigRedisWriterService', () => {
  let service: DhcpConfigRedisWriterService;
  let writeAtomJson: ReturnType<typeof vi.fn>;
  let delKey: ReturnType<typeof vi.fn>;
  const ZONE = '99999999-0000-0000-0000-000000000000';
  const PREFIX_ID = '11111111-2222-3333-4444-555555555555';
  const VALUE: DhcpAtom = {
    mode: 'AUTHORITATIVE',
    subnet: '10.0.1.0/24',
    pools: [{ start: '10.0.1.100', end: '10.0.1.200' }],
    routers: ['10.0.1.1'],
    dnsServers: [],
    leaseTtlSeconds: 3600,
    reservations: [],
    dhcpOptions: [],
    nextServer: null,
    ipxeBuildTarget: null,
    relay: null,
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

    service = new DhcpConfigRedisWriterService(atomWriter, logger);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('writes the DHCP config as an ok envelope at the correct key with TTL 0 using DhcpAtomSchema', async () => {
    await service.set(ZONE, PREFIX_ID, VALUE);
    expect(writeAtomJson).toHaveBeenCalledWith(
      ZONE,
      dhcpConfig(PREFIX_ID),
      VALUE,
      DhcpAtomSchema,
      TTL_DHCP_CONFIG_SECONDS,
      { request_id: null },
    );
  });

  it('deletes the DHCP config key via the atom writer', async () => {
    await service.clear(ZONE, PREFIX_ID);
    expect(delKey).toHaveBeenCalledWith(ZONE, dhcpConfig(PREFIX_ID));
  });

  it('surfaces the write result (no throw) when the envelope is stale', async () => {
    writeAtomJson.mockResolvedValueOnce({ written: false, reason: 'stale' });
    await expect(service.set(ZONE, PREFIX_ID, VALUE)).resolves.toEqual({
      written: false,
      reason: 'stale',
    });
  });

  it('surfaces a contextual error when writeAtomJson rejects', async () => {
    writeAtomJson.mockRejectedValueOnce(new Error('redis down'));
    await expect(service.set(ZONE, PREFIX_ID, VALUE)).rejects.toThrow('redis down');
  });

  it('verifies TTL_DHCP_CONFIG_SECONDS is 0 (durable, no expiry)', () => {
    expect(TTL_DHCP_CONFIG_SECONDS).toBe(0);
  });

  it('verifies dhcpConfig key format', () => {
    expect(dhcpConfig(PREFIX_ID)).toBe(`prefix:${PREFIX_ID}:config:dhcp`);
  });

  describe('zone ops atom', () => {
    const OPS_VALUE: DhcpZoneOpsAtom = {
      leaderPollMs: 2000,
      pruneIntervalMs: 60000,
      declineBackoffSeconds: 600,
    };

    it('verifies DHCP_ZONE_CONFIG_KEY matches the wire literal the bridge reads', () => {
      expect(DHCP_ZONE_CONFIG_KEY).toBe('config:dhcp');
    });

    it('writes the zone ops atom at the zone-global key with TTL 0 using DhcpZoneOpsAtomSchema', async () => {
      await service.setZoneOps(ZONE, OPS_VALUE);
      expect(writeAtomJson).toHaveBeenCalledWith(
        ZONE,
        DHCP_ZONE_CONFIG_KEY,
        OPS_VALUE,
        DhcpZoneOpsAtomSchema,
        TTL_DHCP_CONFIG_SECONDS,
        { request_id: null },
      );
    });

    it('deletes the zone ops key via the atom writer', async () => {
      await service.clearZoneOps(ZONE);
      expect(delKey).toHaveBeenCalledWith(ZONE, DHCP_ZONE_CONFIG_KEY);
    });

    it('surfaces the write result (no throw) when the envelope is stale', async () => {
      writeAtomJson.mockResolvedValueOnce({ written: false, reason: 'stale' });
      await expect(service.setZoneOps(ZONE, OPS_VALUE)).resolves.toEqual({
        written: false,
        reason: 'stale',
      });
    });
  });
});
