import { describe, expect, it, vi } from 'vitest';
import { DhcpAtomSchema } from '../dhcp-atom.schema';
import { DhcpDerivationService } from '../dhcp-derivation.service';

function makePrefixRow(overrides: Record<string, unknown> = {}) {
  return {
    prefixId: 'prefix-1',
    zoneId: 'zone-1',
    prefix: '10.0.1.0/24',
    dhcpMode: 'AUTHORITATIVE',
    dhcpLeaseTtlSeconds: null,
    dhcpOptions: null,
    dhcpProxyAllowedMacs: [],
    dhcpProxyPeerAuthoritative: false,
    ipxeBuildTarget: null,
    role: 'PRIMARY',
    gatewayIp: null,
    dhcpRelayAgentIp: null,
    associatedPrefixId: null,
    ...overrides,
  };
}

function makePool(overrides: Record<string, unknown> = {}) {
  return { prefixId: 'prefix-1', start: '10.0.1.10', end: '10.0.1.100', ...overrides };
}

function makeReservation(overrides: Record<string, unknown> = {}) {
  return {
    prefixId: 'prefix-1',
    mac: 'aa:bb:cc:dd:ee:01',
    ip: '10.0.1.50',
    ipxeBuildTarget: null,
    bootFilename: null,
    hostname: null,
    deviceId: 'device-1',
    interfaceId: 'iface-1',
    ...overrides,
  };
}

function createService(): DhcpDerivationService {
  const logger = { log: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() };
  const prisma = {} as never;
  return new DhcpDerivationService(prisma, logger as never);
}

describe('DhcpDerivationService.buildAtom', () => {
  const service = createService();

  it('produces a valid atom for a minimal prefix', () => {
    const atom = service.buildAtom(makePrefixRow(), [], []);
    expect(() => DhcpAtomSchema.parse(atom)).not.toThrow();
    expect(atom.mode).toBe('AUTHORITATIVE');
    expect(atom.subnet).toBe('10.0.1.0/24');
    expect(atom.pools).toEqual([]);
    expect(atom.routers).toEqual([]);
    expect(atom.dnsServers).toEqual([]);
    expect(atom.leaseTtlSeconds).toBe(600);
    expect(atom.reservations).toEqual([]);
    expect(atom.proxyAllowedMacs).toEqual([]);
    expect(atom.dhcpOptions).toEqual([]);
    expect(atom.nextServer).toBeNull();
    expect(atom.ipxeBuildTarget).toBe('IPXE');
    expect(atom.relay).toBeNull();
  });

  it('maps pools from IpRange rows', () => {
    const pools = [
      makePool({ start: '10.0.1.10', end: '10.0.1.50' }),
      makePool({ start: '10.0.1.100', end: '10.0.1.200' }),
    ];
    const atom = service.buildAtom(makePrefixRow(), pools, []);
    expect(atom.pools).toEqual([
      { start: '10.0.1.10', end: '10.0.1.50' },
      { start: '10.0.1.100', end: '10.0.1.200' },
    ]);
    expect(() => DhcpAtomSchema.parse(atom)).not.toThrow();
  });

  it('sets routers from the prefix gateway IP', () => {
    const atom = service.buildAtom(makePrefixRow({ gatewayIp: '10.0.1.1' }), [], []);
    expect(atom.routers).toEqual(['10.0.1.1']);
  });

  it('omits a non-IPv4 gateway from routers instead of failing derivation', () => {
    const atom = service.buildAtom(makePrefixRow({ gatewayIp: 'fe80::1' }), [], []);
    expect(atom.routers).toEqual([]);
    expect(() => DhcpAtomSchema.parse(atom)).not.toThrow();
  });

  it('omits a non-IPv4 relay agent IP instead of failing derivation', () => {
    const atom = service.buildAtom(makePrefixRow({ dhcpRelayAgentIp: 'fe80::2' }), [], []);
    expect(atom.relay).toBeNull();
    expect(() => DhcpAtomSchema.parse(atom)).not.toThrow();
  });

  it('omits a non-routable IPv4 relay agent IP instead of failing derivation', () => {
    for (const nonRoutable of ['0.0.0.0', '127.0.0.1', '169.254.1.1', '224.0.0.1', '240.1.2.3', '255.255.255.255']) {
      const atom = service.buildAtom(makePrefixRow({ dhcpRelayAgentIp: nonRoutable }), [], []);
      expect(atom.relay).toBeNull();
      expect(() => DhcpAtomSchema.parse(atom)).not.toThrow();
    }
  });

  it('uses dhcpLeaseTtlSeconds when set', () => {
    const atom = service.buildAtom(makePrefixRow({ dhcpLeaseTtlSeconds: 3600 }), [], []);
    expect(atom.leaseTtlSeconds).toBe(3600);
  });

  it('falls back to the default for a non-positive stored TTL (0 must not fail parse)', () => {
    const atom = service.buildAtom(makePrefixRow({ dhcpLeaseTtlSeconds: 0 }), [], []);
    expect(atom.leaseTtlSeconds).toBe(600);
    expect(() => DhcpAtomSchema.parse(atom)).not.toThrow();
  });

  it('maps reservations from interface MAC + IP', () => {
    const reservations = [
      makeReservation({ mac: 'AA:BB:CC:DD:EE:01', ip: '10.0.1.50' }),
      makeReservation({ mac: 'aa:bb:cc:dd:ee:02', ip: '10.0.1.51' }),
    ];
    const atom = service.buildAtom(makePrefixRow(), [], reservations);
    expect(atom.reservations).toEqual([
      { mac: 'aa:bb:cc:dd:ee:01', ip: '10.0.1.50' },
      { mac: 'aa:bb:cc:dd:ee:02', ip: '10.0.1.51' },
    ]);
    expect(() => DhcpAtomSchema.parse(atom)).not.toThrow();
  });

  it('deduplicates reservations by MAC (first wins)', () => {
    const reservations = [
      makeReservation({ mac: 'aa:bb:cc:dd:ee:01', ip: '10.0.1.50' }),
      makeReservation({ mac: 'aa:bb:cc:dd:ee:01', ip: '10.0.1.99' }),
    ];
    const atom = service.buildAtom(makePrefixRow(), [], reservations);
    expect(atom.reservations).toHaveLength(1);
    expect(atom.reservations[0].ip).toBe('10.0.1.50');
  });

  it('skips a malformed / non-48-bit reservation MAC instead of failing the whole prefix', () => {
    const reservations = [
      makeReservation({ mac: 'aa:bb:cc:dd:ee:01', ip: '10.0.1.50' }),
      makeReservation({ mac: '00:11:22:33:44:55:66:77', ip: '10.0.1.51' }),
      makeReservation({ mac: 'not-a-mac', ip: '10.0.1.52' }),
    ];
    const atom = service.buildAtom(makePrefixRow(), [], reservations);
    expect(atom.reservations).toEqual([{ mac: 'aa:bb:cc:dd:ee:01', ip: '10.0.1.50' }]);
    expect(() => DhcpAtomSchema.parse(atom)).not.toThrow();
  });

  it('skips a reservation with an invalid IPv4 instead of failing the whole prefix', () => {
    const reservations = [
      makeReservation({ mac: 'aa:bb:cc:dd:ee:01', ip: '10.0.1.50' }),
      makeReservation({ mac: 'aa:bb:cc:dd:ee:02', ip: 'not-an-ip' }),
      makeReservation({ mac: 'aa:bb:cc:dd:ee:03', ip: '999.999.999.999' }),
    ];
    const atom = service.buildAtom(makePrefixRow(), [], reservations);
    expect(atom.reservations).toEqual([{ mac: 'aa:bb:cc:dd:ee:01', ip: '10.0.1.50' }]);
    expect(() => DhcpAtomSchema.parse(atom)).not.toThrow();
  });

  it('carries a per-device ipxeBuildTarget onto the reservation, omitting it when the device has none', () => {
    const reservations = [
      makeReservation({ mac: 'aa:bb:cc:dd:ee:01', ip: '10.0.1.50', ipxeBuildTarget: 'SNP' }),
      makeReservation({ mac: 'aa:bb:cc:dd:ee:02', ip: '10.0.1.51', ipxeBuildTarget: null }),
    ];
    const atom = service.buildAtom(makePrefixRow(), [], reservations);
    expect(atom.reservations).toEqual([
      { mac: 'aa:bb:cc:dd:ee:01', ip: '10.0.1.50', ipxeBuildTarget: 'SNP' },
      { mac: 'aa:bb:cc:dd:ee:02', ip: '10.0.1.51' },
    ]);
    expect(() => DhcpAtomSchema.parse(atom)).not.toThrow();
  });

  it('sets nextServer to null for directly-attached prefixes (bridge self-derives)', () => {
    const atom = service.buildAtom(makePrefixRow({ role: 'PRIMARY' }), [], []);
    expect(atom.nextServer).toBeNull();
  });

  it('always sets dnsServers to empty (bridge self-derives)', () => {
    const atom = service.buildAtom(makePrefixRow(), [], []);
    expect(atom.dnsServers).toEqual([]);
    expect(() => DhcpAtomSchema.parse(atom)).not.toThrow();
  });

  it('maps the stored relay agent IP when the gateway is null', () => {
    const atom = service.buildAtom(makePrefixRow({ gatewayIp: null, dhcpRelayAgentIp: '10.0.2.1' }), [], []);
    expect(atom.relay).toEqual({ relayAgentIp: '10.0.2.1' });
    expect(atom.routers).toEqual([]);
    expect(() => DhcpAtomSchema.parse(atom)).not.toThrow();
  });

  it('carries a valid per-device bootFilename onto the reservation', () => {
    const atom = service.buildAtom(makePrefixRow(), [], [makeReservation({ bootFilename: 'custom-image.efi' })]);
    expect(atom.reservations[0].bootFilename).toBe('custom-image.efi');
    expect(() => DhcpAtomSchema.parse(atom)).not.toThrow();
  });

  it('omits an invalid bootFilename instead of failing derivation', () => {
    const atom = service.buildAtom(makePrefixRow(), [], [makeReservation({ bootFilename: '../../etc/passwd' })]);
    expect(atom.reservations[0].bootFilename).toBeUndefined();
    expect(() => DhcpAtomSchema.parse(atom)).not.toThrow();
  });

  it('omits a bootFilename exceeding the 127-char bootp file field and keeps one at the boundary', () => {
    const over = 'a'.repeat(128);
    const max = 'a'.repeat(127);
    const dropped = service.buildAtom(makePrefixRow(), [], [makeReservation({ bootFilename: over })]);
    expect(dropped.reservations[0].bootFilename).toBeUndefined();
    const kept = service.buildAtom(makePrefixRow(), [], [makeReservation({ bootFilename: max })]);
    expect(kept.reservations[0].bootFilename).toBe(max);
    expect(() => DhcpAtomSchema.parse(kept)).not.toThrow();
  });

  it('sets dnsServers and nextServer from relay bridge ips for a relayed prefix with an ipxe target', () => {
    const atom = service.buildAtom(
      makePrefixRow({ dhcpRelayAgentIp: '10.0.2.1', associatedPrefixId: 'prefix-assoc', ipxeBuildTarget: 'IPXE' }),
      [],
      [],
      ['10.0.9.2', '10.0.9.3'],
    );
    expect(atom.nextServer).toBe('10.0.9.2');
    expect(atom.dnsServers).toEqual(['10.0.9.2', '10.0.9.3']);
  });

  it('materializes the default target for a relayed prefix with a stale null target, so nextServer is still offered', () => {
    const atom = service.buildAtom(
      makePrefixRow({ dhcpRelayAgentIp: '10.0.2.1', associatedPrefixId: 'prefix-assoc' }),
      [],
      [],
      ['10.0.9.2'],
    );
    expect(atom.ipxeBuildTarget).toBe('IPXE');
    expect(atom.nextServer).toBe('10.0.9.2');
    expect(atom.dnsServers).toEqual(['10.0.9.2']);
  });

  it('leaves dnsServers and nextServer empty for a relayed prefix with no relay bridge ips', () => {
    const atom = service.buildAtom(makePrefixRow({ dhcpRelayAgentIp: '10.0.2.1' }), [], []);
    expect(atom.nextServer).toBeNull();
    expect(atom.dnsServers).toEqual([]);
  });

  it('ignores relay bridge ips for a directly-attached prefix', () => {
    const atom = service.buildAtom(makePrefixRow(), [], [], ['10.0.9.2']);
    expect(atom.nextServer).toBeNull();
    expect(atom.dnsServers).toEqual([]);
  });

  it('sets relay to null when the relay agent IP is null', () => {
    const atom = service.buildAtom(makePrefixRow(), [], []);
    expect(atom.relay).toBeNull();
  });

  it('maps dhcpOptions from stored [{code,value}] to [{code,value}]', () => {
    const atom = service.buildAtom(
      makePrefixRow({
        dhcpOptions: [
          { code: 43, value: '0a0001fe' },
          { code: 66, value: '0a000102' },
        ],
      }),
      [],
      [],
    );
    expect(atom.dhcpOptions).toEqual([
      { code: 43, value: '0a0001fe' },
      { code: 66, value: '0a000102' },
    ]);
    expect(() => DhcpAtomSchema.parse(atom)).not.toThrow();
  });

  it('treats malformed dhcpOptions as empty array', () => {
    const atom = service.buildAtom(makePrefixRow({ dhcpOptions: 'not-an-array' }), [], []);
    expect(atom.dhcpOptions).toEqual([]);
  });

  it('treats null dhcpOptions as empty array', () => {
    const atom = service.buildAtom(makePrefixRow({ dhcpOptions: null }), [], []);
    expect(atom.dhcpOptions).toEqual([]);
  });

  it('emits empty dnsServers (bridge self-derives from its own IP and peers)', () => {
    const atom = service.buildAtom(makePrefixRow(), [], []);
    expect(atom.dnsServers).toEqual([]);
  });

  it('maps ipxeBuildTarget from prefix field', () => {
    const atom = service.buildAtom(makePrefixRow({ ipxeBuildTarget: 'SNP' }), [], []);
    expect(atom.ipxeBuildTarget).toBe('SNP');
    expect(() => DhcpAtomSchema.parse(atom)).not.toThrow();
  });

  it('falls back to the IPXE default for a null or stale prefix ipxeBuildTarget', () => {
    expect(service.buildAtom(makePrefixRow({ ipxeBuildTarget: null }), [], []).ipxeBuildTarget).toBe('IPXE');
    expect(service.buildAtom(makePrefixRow({ ipxeBuildTarget: 'bios' }), [], []).ipxeBuildTarget).toBe('IPXE');
  });

  it('maps PROXY mode correctly', () => {
    const atom = service.buildAtom(makePrefixRow({ dhcpMode: 'PROXY' }), [], []);
    expect(atom.mode).toBe('PROXY');
    expect(() => DhcpAtomSchema.parse(atom)).not.toThrow();
  });

  it('populates proxyAllowedMacs from reservation MACs for PROXY prefix', () => {
    const reservations = [
      makeReservation({ mac: 'aa:bb:cc:dd:ee:01', ip: '10.0.1.50' }),
      makeReservation({ mac: 'aa:bb:cc:dd:ee:02', ip: '10.0.1.51' }),
    ];
    const atom = service.buildAtom(makePrefixRow({ dhcpMode: 'PROXY' }), [], reservations);
    expect(atom.proxyAllowedMacs).toContain('aa:bb:cc:dd:ee:01');
    expect(atom.proxyAllowedMacs).toContain('aa:bb:cc:dd:ee:02');
    expect(() => DhcpAtomSchema.parse(atom)).not.toThrow();
  });

  it('leaves proxyAllowedMacs empty for AUTHORITATIVE prefix even with reservations', () => {
    const reservations = [makeReservation({ mac: 'aa:bb:cc:dd:ee:01', ip: '10.0.1.50' })];
    const atom = service.buildAtom(makePrefixRow({ dhcpMode: 'AUTHORITATIVE' }), [], reservations);
    expect(atom.proxyAllowedMacs).toEqual([]);
  });

  it('leaves proxyAllowedMacs empty for PROXY prefix with no reservations and no operator MACs', () => {
    const atom = service.buildAtom(makePrefixRow({ dhcpMode: 'PROXY' }), [], []);
    expect(atom.proxyAllowedMacs).toEqual([]);
  });

  it('unions operator dhcpProxyAllowedMacs with device MACs for PROXY prefix (deduped)', () => {
    const reservations = [makeReservation({ mac: 'aa:bb:cc:dd:ee:01', ip: '10.0.1.50' })];
    const atom = service.buildAtom(
      makePrefixRow({
        dhcpMode: 'PROXY',
        dhcpProxyAllowedMacs: ['aa:bb:cc:dd:ee:01', '11:22:33:44:55:66'],
      }),
      [],
      reservations,
    );
    expect(atom.proxyAllowedMacs).toHaveLength(2);
    expect(atom.proxyAllowedMacs).toContain('aa:bb:cc:dd:ee:01');
    expect(atom.proxyAllowedMacs).toContain('11:22:33:44:55:66');
    expect(() => DhcpAtomSchema.parse(atom)).not.toThrow();
  });

  it('ignores operator dhcpProxyAllowedMacs for AUTHORITATIVE prefix', () => {
    const atom = service.buildAtom(
      makePrefixRow({
        dhcpMode: 'AUTHORITATIVE',
        dhcpProxyAllowedMacs: ['11:22:33:44:55:66'],
      }),
      [],
      [],
    );
    expect(atom.proxyAllowedMacs).toEqual([]);
  });

  it('skips malformed operator MACs in dhcpProxyAllowedMacs', () => {
    const atom = service.buildAtom(
      makePrefixRow({
        dhcpMode: 'PROXY',
        dhcpProxyAllowedMacs: ['11:22:33:44:55:66', 'not-a-mac', '00:11:22:33:44:55:66:77'],
      }),
      [],
      [],
    );
    expect(atom.proxyAllowedMacs).toEqual(['11:22:33:44:55:66']);
    expect(() => DhcpAtomSchema.parse(atom)).not.toThrow();
  });

  it('normalizes uppercase operator MACs to lowercase', () => {
    const atom = service.buildAtom(
      makePrefixRow({
        dhcpMode: 'PROXY',
        dhcpProxyAllowedMacs: ['AA:BB:CC:DD:EE:FF'],
      }),
      [],
      [],
    );
    expect(atom.proxyAllowedMacs).toEqual(['aa:bb:cc:dd:ee:ff']);
    expect(() => DhcpAtomSchema.parse(atom)).not.toThrow();
  });

  it('validates the full atom including pools, reservations, and options', () => {
    const atom = service.buildAtom(
      makePrefixRow({
        gatewayIp: '10.0.1.1',
        dhcpLeaseTtlSeconds: 1800,
        ipxeBuildTarget: 'IPXE',
        dhcpOptions: [{ code: 43, value: 'ff' }],
      }),
      [makePool()],
      [makeReservation()],
    );
    const result = DhcpAtomSchema.safeParse(atom);
    expect(result.success).toBe(true);
  });
});

describe('listReservationsForPrefix', () => {
  const DEVICE_ID = '11111111-1111-4111-8111-111111111111';
  const IFACE_ID = '22222222-2222-4222-8222-222222222222';

  function serviceWithRows(rows: unknown[]) {
    const prisma = { $queryRaw: vi.fn().mockResolvedValue(rows) };
    const logger = { warn: vi.fn(), log: vi.fn(), error: vi.fn(), debug: vi.fn() };
    return { service: new DhcpDerivationService(prisma as never, logger as never), logger, prisma };
  }

  it('maps rows to reservations with deviceId/interfaceId for link-to-manage', async () => {
    const { service } = serviceWithRows([
      {
        prefixId: 'prefix-1',
        mac: 'aa:bb:cc:dd:ee:01',
        ip: '10.0.1.50',
        ipxeBuildTarget: 'SNP',
        hostname: 'gpu-1',
        deviceId: DEVICE_ID,
        interfaceId: IFACE_ID,
      },
    ]);

    expect(await service.listReservationsForPrefix('prefix-1')).toEqual([
      {
        mac: 'aa:bb:cc:dd:ee:01',
        ip: '10.0.1.50',
        hostname: 'gpu-1',
        ipxeBuildTarget: 'SNP',
        deviceId: DEVICE_ID,
        interfaceId: IFACE_ID,
      },
    ]);
  });

  it('adds an explicit org scope to the query when an organizationId is passed (request path)', async () => {
    const { service, prisma } = serviceWithRows([]);
    await service.listReservationsForPrefix('prefix-1', 'org-42');
    const sql = prisma.$queryRaw.mock.calls[0][0];
    expect(sql.values).toContain('org-42');
  });

  it('omits the org scope for the cross-tenant path (no organizationId)', async () => {
    const { service, prisma } = serviceWithRows([]);
    await service.listReservationsForPrefix('prefix-1');
    const sql = prisma.$queryRaw.mock.calls[0][0];
    expect(sql.values).not.toContain('org-42');
  });

  it('degrades an over-long hostname to null (keeps the reservation rather than dropping it)', async () => {
    const { service } = serviceWithRows([
      {
        prefixId: 'prefix-1',
        mac: 'aa:bb:cc:dd:ee:02',
        ip: '10.0.1.52',
        ipxeBuildTarget: null,
        hostname: 'x'.repeat(300),
        deviceId: DEVICE_ID,
        interfaceId: IFACE_ID,
      },
    ]);

    expect(await service.listReservationsForPrefix('prefix-1')).toEqual([
      {
        mac: 'aa:bb:cc:dd:ee:02',
        ip: '10.0.1.52',
        hostname: null,
        ipxeBuildTarget: null,
        deviceId: DEVICE_ID,
        interfaceId: IFACE_ID,
      },
    ]);
  });

  it('drops a row that fails the contract shape (e.g. a non-colon-hex MAC) and warns', async () => {
    const { service, logger } = serviceWithRows([
      {
        prefixId: 'prefix-1',
        mac: 'NOT-A-MAC',
        ip: '10.0.1.51',
        ipxeBuildTarget: null,
        hostname: null,
        deviceId: DEVICE_ID,
        interfaceId: IFACE_ID,
      },
    ]);

    expect(await service.listReservationsForPrefix('prefix-1')).toEqual([]);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('dedupes by MAC (first-by-IP wins), matching what the atom builder serves', async () => {
    const { service } = serviceWithRows([
      {
        prefixId: 'prefix-1',
        mac: 'aa:bb:cc:dd:ee:01',
        ip: '10.0.1.50',
        ipxeBuildTarget: null,
        hostname: null,
        deviceId: DEVICE_ID,
        interfaceId: IFACE_ID,
      },
      {
        prefixId: 'prefix-1',
        mac: 'aa:bb:cc:dd:ee:01',
        ip: '10.0.1.99',
        ipxeBuildTarget: null,
        hostname: null,
        deviceId: DEVICE_ID,
        interfaceId: IFACE_ID,
      },
    ]);

    const result = await service.listReservationsForPrefix('prefix-1');

    expect(result).toHaveLength(1);
    expect(result[0].ip).toBe('10.0.1.50');
  });
});

describe('DhcpDerivationService.deriveOne', () => {
  function setup() {
    const service = createService();

    const svc = service as any;
    const listSpy = vi.spyOn(svc, 'listDhcpEnabledPrefixes');
    const poolsSpy = vi.spyOn(svc, 'loadPools');
    const resSpy = vi.spyOn(svc, 'loadReservations');
    const relaySpy = vi.spyOn(svc, 'loadRelayBridgeIps');
    const buildSpy = vi.spyOn(service, 'buildAtom');
    return { service, listSpy, poolsSpy, resSpy, relaySpy, buildSpy };
  }

  it('returns enabled with the derived atom on success', async () => {
    const { service, listSpy, poolsSpy, resSpy } = setup();
    const row = makePrefixRow();
    listSpy.mockResolvedValue([row]);
    poolsSpy.mockResolvedValue(new Map([['prefix-1', [makePool()]]]));
    resSpy.mockResolvedValue(new Map([['prefix-1', [makeReservation()]]]));

    const result = await service.deriveOne('prefix-1');

    expect(result.status).toBe('enabled');
    if (result.status !== 'enabled') throw new Error('unreachable');
    expect(result.zoneId).toBe('zone-1');
    expect(() => DhcpAtomSchema.parse(result.atom)).not.toThrow();
    expect(result.atom.pools).toHaveLength(1);
    expect(result.atom.reservations).toHaveLength(1);
  });

  it('returns disabled when prefix is not DHCP-eligible (no rows)', async () => {
    const { service, listSpy } = setup();
    listSpy.mockResolvedValue([]);

    const result = await service.deriveOne('prefix-gone');

    expect(result.status).toBe('disabled');
  });

  it('passes relay bridge ips through to the derived atom', async () => {
    const { service, listSpy, poolsSpy, resSpy, relaySpy } = setup();
    listSpy.mockResolvedValue([
      makePrefixRow({ dhcpRelayAgentIp: '10.0.2.1', associatedPrefixId: 'prefix-assoc', ipxeBuildTarget: 'IPXE' }),
    ]);
    poolsSpy.mockResolvedValue(new Map());
    resSpy.mockResolvedValue(new Map());
    relaySpy.mockResolvedValue(new Map([['prefix-1', ['10.0.9.2', '10.0.9.3']]]));

    const result = await service.deriveOne('prefix-1');

    expect(result.status).toBe('enabled');
    if (result.status !== 'enabled') throw new Error('unreachable');
    expect(result.atom.nextServer).toBe('10.0.9.2');
    expect(result.atom.dnsServers).toEqual(['10.0.9.2', '10.0.9.3']);
  });

  it('returns error when the prefix query throws (DB unreachable)', async () => {
    const { service, listSpy } = setup();
    listSpy.mockRejectedValue(new Error('connection refused'));

    const result = await service.deriveOne('prefix-1');

    expect(result.status).toBe('error');
  });

  it('returns error when buildAtom throws (data-level failure)', async () => {
    const { service, listSpy, poolsSpy, resSpy, buildSpy } = setup();
    listSpy.mockResolvedValue([makePrefixRow()]);
    poolsSpy.mockResolvedValue(new Map());
    resSpy.mockResolvedValue(new Map());
    buildSpy.mockImplementation(() => {
      throw new Error('Zod validation failed');
    });

    const result = await service.deriveOne('prefix-1');

    expect(result.status).toBe('error');
  });

  it('returns error when loadPools throws', async () => {
    const { service, listSpy, poolsSpy } = setup();
    listSpy.mockResolvedValue([makePrefixRow()]);
    poolsSpy.mockRejectedValue(new Error('query timeout'));

    const result = await service.deriveOne('prefix-1');

    expect(result.status).toBe('error');
  });
});

describe('DhcpDerivationService.deriveAll', () => {
  function setup() {
    const service = createService();

    const svc = service as any;
    const listSpy = vi.spyOn(svc, 'listDhcpEnabledPrefixes');
    const poolsSpy = vi.spyOn(svc, 'loadPools');
    const resSpy = vi.spyOn(svc, 'loadReservations');
    const relaySpy = vi.spyOn(svc, 'loadRelayBridgeIps');
    const buildSpy = vi.spyOn(service, 'buildAtom');
    return { service, listSpy, poolsSpy, resSpy, relaySpy, buildSpy };
  }

  it('passes relay bridge ips through to each derived atom', async () => {
    const { service, listSpy, poolsSpy, resSpy, relaySpy } = setup();
    listSpy.mockResolvedValue([
      makePrefixRow({ dhcpRelayAgentIp: '10.0.2.1', associatedPrefixId: 'prefix-assoc', ipxeBuildTarget: 'IPXE' }),
    ]);
    poolsSpy.mockResolvedValue(new Map());
    resSpy.mockResolvedValue(new Map());
    relaySpy.mockResolvedValue(new Map([['prefix-1', ['10.0.9.2', '10.0.9.3']]]));

    const result = await service.deriveAll();

    expect(result.atoms).toHaveLength(1);
    expect(result.atoms[0].atom.nextServer).toBe('10.0.9.2');
    expect(result.atoms[0].atom.dnsServers).toEqual(['10.0.9.2', '10.0.9.3']);
  });

  it('returns atoms for all healthy prefixes', async () => {
    const { service, listSpy, poolsSpy, resSpy } = setup();
    const row1 = makePrefixRow({ prefixId: 'p-1', zoneId: 'z-1' });
    const row2 = makePrefixRow({ prefixId: 'p-2', zoneId: 'z-1', prefix: '10.0.2.0/24' });
    listSpy.mockResolvedValue([row1, row2]);
    poolsSpy.mockResolvedValue(new Map());
    resSpy.mockResolvedValue(new Map());

    const result = await service.deriveAll();

    expect(result.atoms).toHaveLength(2);
    expect(result.enabledKeys).toEqual(new Set(['z-1:p-1', 'z-1:p-2']));
  });

  it('returns empty atoms and enabledKeys when no prefixes are DHCP-enabled', async () => {
    const { service, listSpy } = setup();
    listSpy.mockResolvedValue([]);

    const result = await service.deriveAll();

    expect(result.atoms).toEqual([]);
    expect(result.enabledKeys.size).toBe(0);
  });

  it('preserves current atoms when the batch pool/reservation load fails', async () => {
    const { service, listSpy, poolsSpy, resSpy } = setup();
    const row1 = makePrefixRow({ prefixId: 'p-1', zoneId: 'z-1' });
    const row2 = makePrefixRow({ prefixId: 'p-2', zoneId: 'z-1', prefix: '10.0.2.0/24' });
    listSpy.mockResolvedValue([row1, row2]);
    poolsSpy.mockRejectedValue(new Error('connection refused'));
    resSpy.mockResolvedValue(new Map());

    const result = await service.deriveAll();

    expect(result.atoms).toEqual([]);
    expect(result.enabledKeys).toEqual(new Set(['z-1:p-1', 'z-1:p-2']));
  });

  it('isolates a failing prefix — healthy siblings still produce atoms', async () => {
    const { service, listSpy, poolsSpy, resSpy, buildSpy } = setup();
    const goodRow = makePrefixRow({ prefixId: 'p-good', zoneId: 'z-1' });
    const badRow = makePrefixRow({ prefixId: 'p-bad', zoneId: 'z-1', prefix: '10.0.2.0/24' });
    listSpy.mockResolvedValue([goodRow, badRow]);
    poolsSpy.mockResolvedValue(new Map());
    resSpy.mockResolvedValue(new Map());

    const original = DhcpDerivationService.prototype.buildAtom;
    buildSpy.mockImplementation(function (this: DhcpDerivationService, ...args: Parameters<typeof original>) {
      if (args[0].prefixId === 'p-bad') throw new Error('bad subnet data');
      return original.apply(this, args);
    });

    const result = await service.deriveAll();

    expect(result.atoms).toHaveLength(1);
    expect(result.atoms[0].prefixId).toBe('p-good');
    expect(result.enabledKeys).toEqual(new Set(['z-1:p-good', 'z-1:p-bad']));
  });

  it('keeps enabledKeys for all prefixes even when all buildAtom calls throw', async () => {
    const { service, listSpy, poolsSpy, resSpy, buildSpy } = setup();
    const row1 = makePrefixRow({ prefixId: 'p-1', zoneId: 'z-1' });
    const row2 = makePrefixRow({ prefixId: 'p-2', zoneId: 'z-2', prefix: '10.0.2.0/24' });
    listSpy.mockResolvedValue([row1, row2]);
    poolsSpy.mockResolvedValue(new Map());
    resSpy.mockResolvedValue(new Map());
    buildSpy.mockImplementation(() => {
      throw new Error('total failure');
    });

    const result = await service.deriveAll();

    expect(result.atoms).toEqual([]);
    expect(result.enabledKeys).toEqual(new Set(['z-1:p-1', 'z-2:p-2']));
  });
});
