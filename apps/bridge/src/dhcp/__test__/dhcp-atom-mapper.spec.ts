import { describe, expect, it } from 'vitest';

import { atomServedInterfaceIps, cidrToSubnetMask, mapAtomsToEngine, relayedSubnetCidrs } from '../dhcp-atom-mapper.js';
import type { DhcpAtomValue } from '../dhcp-atom-value.schema.js';
import { parseDhcpOptionValue } from '../dhcp.config.js';
import { makeAtom, makeIface, silentLogger } from './test-factories.js';

describe('mapAtomsToEngine', () => {
  it('maps a single atom to the matching interface shared network', () => {
    const atoms = new Map([['prefix-1', makeAtom({ dnsServers: ['8.8.8.8'] })]]);
    const ifaces = [makeIface()];
    const result = mapAtomsToEngine(atoms, ifaces, silentLogger());

    expect(result.networks).toHaveLength(1);
    expect(result.networks[0].interfaceKey).toBe('eth0');
    expect(result.networks[0].subnets).toHaveLength(1);
    expect(result.networks[0].subnets[0].subnetMask).toBe('255.255.255.0');
    expect(result.networks[0].subnets[0].rangeStart).toBe('10.0.1.100');
    expect(result.networks[0].subnets[0].rangeEnd).toBe('10.0.1.200');
    expect(result.networks[0].subnets[0].routers).toEqual(['10.0.1.1']);
    expect(result.networks[0].subnets[0].dnsServers).toEqual(['8.8.8.8']);
    expect(result.networks[0].subnets[0].leaseTtlSeconds).toBe(3600);
    expect(result.relayed).toHaveLength(0);
  });

  it('groups multiple atoms on the same interface into one shared network', () => {
    const atoms = new Map([
      ['prefix-1', makeAtom({ subnet: '10.0.1.0/24', pools: [{ start: '10.0.1.10', end: '10.0.1.50' }] })],
      ['prefix-2', makeAtom({ subnet: '10.0.1.0/24', pools: [{ start: '10.0.1.100', end: '10.0.1.200' }] })],
    ]);
    const ifaces = [makeIface({ ip: '10.0.1.5' })];
    const result = mapAtomsToEngine(atoms, ifaces, silentLogger());

    expect(result.networks).toHaveLength(1);
    expect(result.networks[0].subnets).toHaveLength(2);
  });

  it('maps atoms to different interfaces based on CIDR match', () => {
    const atoms = new Map([
      ['prefix-1', makeAtom({ subnet: '10.0.1.0/24' })],
      [
        'prefix-2',
        makeAtom({ subnet: '10.0.2.0/24', pools: [{ start: '10.0.2.100', end: '10.0.2.200' }], routers: ['10.0.2.1'] }),
      ],
    ]);
    const ifaces = [
      makeIface({ name: 'eth0', ip: '10.0.1.5', network: '10.0.1.0/24' }),
      makeIface({ name: 'eth1', ip: '10.0.2.5', network: '10.0.2.0/24', isPrimary: false }),
    ];
    const result = mapAtomsToEngine(atoms, ifaces, silentLogger());

    expect(result.networks).toHaveLength(2);
    const eth0 = result.networks.find((n) => n.interfaceKey === 'eth0');
    const eth1 = result.networks.find((n) => n.interfaceKey === 'eth1');
    expect(eth0).toBeDefined();
    expect(eth1).toBeDefined();
    expect(eth0?.subnets).toHaveLength(1);
    expect(eth1?.subnets).toHaveLength(1);
    expect(eth0?.subnets[0].serverId).toBe('10.0.1.5');
    expect(eth1?.subnets[0].serverId).toBe('10.0.2.5');
  });

  it('maps an atom hosted on a br-brokkr data-plane bridge interface', () => {
    const atoms = new Map([['prefix-1', makeAtom({ subnet: '10.0.1.0/24' })]]);
    const ifaces = [makeIface({ name: 'br-brokkr', ip: '10.0.1.5', network: '10.0.1.0/24' })];
    const result = mapAtomsToEngine(atoms, ifaces, silentLogger());

    expect(result.networks).toHaveLength(1);
    expect(result.networks[0].interfaceKey).toBe('br-brokkr');
    expect(result.networks[0].subnets).toHaveLength(1);
    expect(result.networks[0].subnets[0].serverId).toBe('10.0.1.5');
  });

  it('routes relay atoms with no matching interface to relayedSubnets', () => {
    const atoms = new Map([
      [
        'prefix-1',
        makeAtom({
          subnet: '192.168.0.0/24',
          relay: { relayAgentIp: '192.168.0.1' },
        }),
      ],
    ]);
    const ifaces = [makeIface({ ip: '10.0.1.5' })];
    const result = mapAtomsToEngine(atoms, ifaces, silentLogger());

    expect(result.networks).toHaveLength(0);
    expect(result.relayed).toHaveLength(1);
    expect(result.relayed[0].subnetMask).toBe('255.255.255.0');
    expect(result.relayed[0].serverId).toBe('');
    expect(result.relayed[0].relayAgentIp).toBe('192.168.0.1');
    expect(result.relayed[0].excludeIps).toContain('192.168.0.1');
  });

  it('excludes all local interface IPs within the subnet CIDR, not just the matched one', () => {
    const ifaces = [makeIface({ name: 'eth0', ip: '10.0.1.5' }), makeIface({ name: 'eth0:1', ip: '10.0.1.6' })];
    const atoms = new Map([['prefix-1', makeAtom()]]);
    const result = mapAtomsToEngine(atoms, ifaces, silentLogger());

    const subnet = result.networks[0]!.subnets[0]!;
    expect(subnet.excludeIps).toContain('10.0.1.5');
    expect(subnet.excludeIps).toContain('10.0.1.6');
  });

  it('skips atoms with no matching interface and no relay (logs warning)', () => {
    const logger = silentLogger();
    const atoms = new Map([['prefix-1', makeAtom({ subnet: '192.168.0.0/24', relay: null })]]);
    const ifaces = [makeIface({ ip: '10.0.1.5' })];
    const result = mapAtomsToEngine(atoms, ifaces, logger);

    expect(result.networks).toHaveLength(0);
    expect(result.relayed).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('no local interface in CIDR and no relay'));
  });

  it('skips OFF-mode atoms', () => {
    const atoms = new Map([['prefix-1', makeAtom({ mode: 'OFF' })]]);
    const ifaces = [makeIface()];
    const result = mapAtomsToEngine(atoms, ifaces, silentLogger());

    expect(result.networks).toHaveLength(0);
    expect(result.relayed).toHaveLength(0);
  });

  it('passes reservations through to subnet config', () => {
    const atoms = new Map([
      [
        'prefix-1',
        makeAtom({
          reservations: [
            { mac: 'aa:bb:cc:dd:ee:01', ip: '10.0.1.50' },
            { mac: 'aa:bb:cc:dd:ee:02', ip: '10.0.1.51' },
          ],
        }),
      ],
    ]);
    const ifaces = [makeIface()];
    const result = mapAtomsToEngine(atoms, ifaces, silentLogger());

    expect(result.networks[0].subnets[0].reservations).toEqual([
      { mac: 'aa:bb:cc:dd:ee:01', ip: '10.0.1.50' },
      { mac: 'aa:bb:cc:dd:ee:02', ip: '10.0.1.51' },
    ]);
  });

  it('resolves a per-device ipxeBuildTarget reservation into its own bootfile when the subnet does PXE', () => {
    const atoms = new Map([
      [
        'prefix-1',
        makeAtom({
          nextServer: '10.0.1.254',
          ipxeBuildTarget: 'SNPONLY',
          reservations: [
            { mac: 'aa:bb:cc:dd:ee:01', ip: '10.0.1.50', ipxeBuildTarget: 'IPXE' },
            { mac: 'aa:bb:cc:dd:ee:02', ip: '10.0.1.51' },
          ],
        }),
      ],
    ]);
    const result = mapAtomsToEngine(atoms, [makeIface()], silentLogger());
    const [overridden, inherited] = result.networks[0].subnets[0].reservations;

    expect(overridden.mac).toBe('aa:bb:cc:dd:ee:01');
    expect(overridden.bootfile).toMatch(/^ipxe-/);
    expect(overridden.bootfileByArch?.size).toBeGreaterThan(0);
    expect(inherited.bootfile).toBeUndefined();
  });

  it('serves an exact per-device bootFilename for all arches, beating the ipxeBuildTarget override', () => {
    const atoms = new Map([
      [
        'prefix-1',
        makeAtom({
          ipxeBuildTarget: 'SNPONLY',
          reservations: [
            { mac: 'aa:bb:cc:dd:ee:01', ip: '10.0.1.50', ipxeBuildTarget: 'IPXE', bootFilename: 'custom-image.efi' },
          ],
        }),
      ],
    ]);
    const result = mapAtomsToEngine(atoms, [makeIface()], silentLogger());
    const [reservation] = result.networks[0].subnets[0].reservations;

    expect(reservation.bootfile).toBe('custom-image.efi');
    expect(reservation.bootfileByArch?.size).toBe(0);
  });

  it('ignores a per-device bootFilename when the subnet does not do PXE', () => {
    const atoms = new Map([
      [
        'prefix-1',
        makeAtom({
          nextServer: null,
          ipxeBuildTarget: null,
          reservations: [{ mac: 'aa:bb:cc:dd:ee:01', ip: '10.0.1.50', bootFilename: 'custom-image.efi' }],
        }),
      ],
    ]);
    const result = mapAtomsToEngine(atoms, [makeIface()], silentLogger());
    expect(result.networks[0].subnets[0].reservations[0].bootfile).toBeUndefined();
  });

  it('ignores a per-device ipxeBuildTarget when the subnet does not do PXE (no nextServer)', () => {
    const atoms = new Map([
      [
        'prefix-1',
        makeAtom({
          nextServer: null,
          reservations: [{ mac: 'aa:bb:cc:dd:ee:01', ip: '10.0.1.50', ipxeBuildTarget: 'IPXE' }],
        }),
      ],
    ]);
    const result = mapAtomsToEngine(atoms, [makeIface()], silentLogger());
    expect(result.networks[0].subnets[0].reservations[0].bootfile).toBeUndefined();
  });

  it('encodes dhcpOptions value via parseDhcpOptionValue', () => {
    const atoms = new Map([
      [
        'prefix-1',
        makeAtom({
          dhcpOptions: [{ code: 6, value: '10.0.1.1' }],
        }),
      ],
    ]);
    const ifaces = [makeIface()];
    const result = mapAtomsToEngine(atoms, ifaces, silentLogger());

    const opts = result.networks[0].subnets[0].dhcpOptions;
    expect(opts).toHaveLength(1);
    expect(opts[0].code).toBe(6);
    expect(opts[0].value).toEqual(Buffer.from([10, 0, 1, 1]));
  });

  it('skips invalid dhcpOptions with a warning', () => {
    const logger = silentLogger();
    const ifaces = [makeIface()];
    const atoms = new Map([
      [
        'prefix-1',
        makeAtom({
          dhcpOptions: [{ code: 6, value: '' }],
        }),
      ],
    ]);
    const result = mapAtomsToEngine(atoms, ifaces, logger);

    expect(result.networks[0].subnets[0].dhcpOptions).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('encoding failed'));
  });

  it('sets PXE boot fields when nextServer is present', () => {
    const atoms = new Map([['prefix-1', makeAtom({ nextServer: '10.0.1.254' })]]);
    const ifaces = [makeIface()];
    const result = mapAtomsToEngine(atoms, ifaces, silentLogger());

    const sc = result.networks[0].subnets[0];
    expect(sc.tftpServer).toBe('10.0.1.254');
    expect(sc.bootfile).not.toBe('');
    expect(sc.bootfileByArch.size).toBeGreaterThan(0);
  });

  it('respects a non-default ipxeBuildTarget when nextServer is set', () => {
    const atoms = new Map([['prefix-1', makeAtom({ nextServer: '10.0.1.254', ipxeBuildTarget: 'SNP' })]]);
    const ifaces = [makeIface()];
    const result = mapAtomsToEngine(atoms, ifaces, silentLogger());

    const sc = result.networks[0].subnets[0];
    expect(sc.bootfile).toBe('snp-amd64.efi');
    for (const bf of sc.bootfileByArch.values()) {
      expect(bf).toMatch(/^snp-/);
    }
  });

  it('leaves PXE boot fields empty when neither nextServer nor ipxeBuildTarget is set', () => {
    const atoms = new Map([['prefix-1', makeAtom({ nextServer: null, ipxeBuildTarget: null })]]);
    const ifaces = [makeIface()];
    const result = mapAtomsToEngine(atoms, ifaces, silentLogger());

    const sc = result.networks[0].subnets[0];
    expect(sc.tftpServer).toBe('');
    expect(sc.bootfile).toBe('');
    expect(sc.bootfileByArch.size).toBe(0);
  });

  it('derives the next-server from the serving bridge IP when nextServer is null but ipxeBuildTarget is set', () => {
    const atoms = new Map([['prefix-1', makeAtom({ nextServer: null, ipxeBuildTarget: 'IPXE' })]]);
    const ifaces = [makeIface({ ip: '10.0.1.2' })];
    const result = mapAtomsToEngine(atoms, ifaces, silentLogger());

    const sc = result.networks[0].subnets[0];
    expect(sc.tftpServer).toBe('10.0.1.2');
    expect(sc.bootfile).toBe('ipxe-amd64.efi');
    expect(sc.bootfileByArch.size).toBeGreaterThan(0);
  });

  it('does not PXE a relayed subnet with a null next-server (no local IP to derive from)', () => {
    const atoms = new Map([
      [
        'prefix-1',
        makeAtom({
          subnet: '192.168.0.0/24',
          relay: { relayAgentIp: '192.168.0.1' },
          nextServer: null,
          ipxeBuildTarget: 'IPXE',
        }),
      ],
    ]);
    const ifaces = [makeIface({ ip: '10.0.1.5' })];
    const result = mapAtomsToEngine(atoms, ifaces, silentLogger());

    expect(result.relayed[0].serverId).toBe('');
    expect(result.relayed[0].tftpServer).toBe('');
    expect(result.relayed[0].bootfile).toBe('');
  });

  it('sets dnsSelf=true when atom dnsServers is empty', () => {
    const atoms = new Map([['prefix-1', makeAtom({ dnsServers: [] })]]);
    const ifaces = [makeIface()];
    const result = mapAtomsToEngine(atoms, ifaces, silentLogger());

    expect(result.networks[0].subnets[0].dnsSelf).toBe(true);
  });

  it('sets dnsSelf=false when atom dnsServers is populated', () => {
    const atoms = new Map([['prefix-1', makeAtom({ dnsServers: ['8.8.8.8'] })]]);
    const ifaces = [makeIface()];
    const result = mapAtomsToEngine(atoms, ifaces, silentLogger());

    expect(result.networks[0].subnets[0].dnsSelf).toBe(false);
  });

  it('passes declineBackoffSeconds through to subnet configs', () => {
    const atoms = new Map([['prefix-1', makeAtom()]]);
    const ifaces = [makeIface()];
    const result = mapAtomsToEngine(atoms, ifaces, silentLogger(), 1200);

    expect(result.networks[0].subnets[0].declineBackoffSeconds).toBe(1200);
  });

  it('defaults declineBackoffSeconds to 600 when omitted', () => {
    const atoms = new Map([['prefix-1', makeAtom()]]);
    const ifaces = [makeIface()];
    const result = mapAtomsToEngine(atoms, ifaces, silentLogger());

    expect(result.networks[0].subnets[0].declineBackoffSeconds).toBe(600);
  });

  it('handles an empty atom map', () => {
    const atoms = new Map<string, DhcpAtomValue>();
    const ifaces = [makeIface()];
    const result = mapAtomsToEngine(atoms, ifaces, silentLogger());

    expect(result.networks).toHaveLength(0);
    expect(result.relayed).toHaveLength(0);
  });

  it('maps proxyAllowedMacs to a Set with the right members', () => {
    const atoms = new Map([
      [
        'prefix-1',
        makeAtom({
          mode: 'PROXY',
          proxyAllowedMacs: ['aa:bb:cc:dd:ee:01', 'aa:bb:cc:dd:ee:02'],
        }),
      ],
    ]);
    const ifaces = [makeIface()];
    const result = mapAtomsToEngine(atoms, ifaces, silentLogger());

    const sc = result.networks[0].subnets[0];
    expect(sc.proxyAllowedMacs).toBeInstanceOf(Set);
    expect(sc.proxyAllowedMacs).toEqual(new Set(['aa:bb:cc:dd:ee:01', 'aa:bb:cc:dd:ee:02']));
  });

  it('maps empty proxyAllowedMacs to an empty Set', () => {
    const atoms = new Map([['prefix-1', makeAtom({ proxyAllowedMacs: [] })]]);
    const ifaces = [makeIface()];
    const result = mapAtomsToEngine(atoms, ifaces, silentLogger());

    const sc = result.networks[0].subnets[0];
    expect(sc.proxyAllowedMacs).toBeInstanceOf(Set);
    expect(sc.proxyAllowedMacs!.size).toBe(0);
  });
});

describe('cidrToSubnetMask', () => {
  it('converts /24 to 255.255.255.0', () => {
    expect(cidrToSubnetMask('10.0.1.0/24')).toBe('255.255.255.0');
  });

  it('converts /16 to 255.255.0.0', () => {
    expect(cidrToSubnetMask('10.0.0.0/16')).toBe('255.255.0.0');
  });

  it('converts /32 to 255.255.255.255', () => {
    expect(cidrToSubnetMask('10.0.1.1/32')).toBe('255.255.255.255');
  });

  it('converts /0 to 0.0.0.0', () => {
    expect(cidrToSubnetMask('0.0.0.0/0')).toBe('0.0.0.0');
  });

  it('defaults to /24 for malformed input', () => {
    expect(cidrToSubnetMask('bad')).toBe('255.255.255.0');
  });
});

describe('parseDhcpOptionValue encoding', () => {
  it('encodes a single IPv4 address to 4 bytes', () => {
    const result = parseDhcpOptionValue(6, ['10.0.1.1']);
    expect(result).toEqual(Buffer.from([10, 0, 1, 1]));
  });

  it('encodes hex-colon notation to bytes', () => {
    const result = parseDhcpOptionValue(43, ['0a:0b:0c']);
    expect(result).toEqual(Buffer.from([0x0a, 0x0b, 0x0c]));
  });

  it('encodes a decimal value to a single byte', () => {
    const result = parseDhcpOptionValue(53, ['42b']);
    expect(result).toEqual(Buffer.from([42]));
  });

  it('encodes a string value', () => {
    const result = parseDhcpOptionValue(12, ['myhost']);
    expect(result).toEqual(Buffer.from('myhost', 'ascii'));
  });
});

describe('mapAtomsToEngine option encoding limits', () => {
  it('drops a dhcpOption whose ENCODED length exceeds 255 bytes (RFC1035 expansion)', () => {
    const longDomain = Array(128).fill('a').join('.');
    const logger = silentLogger();
    const atoms = new Map([['prefix-1', makeAtom({ dhcpOptions: [{ code: 119, value: longDomain }] })]]);
    const result = mapAtomsToEngine(atoms, [makeIface()], logger);
    expect(result.networks[0]!.subnets[0]!.dhcpOptions.find((o) => o.code === 119)).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('exceeds'));
  });

  it('keeps an in-bounds dhcpOption (encoded <= 255 bytes)', () => {
    const atoms = new Map([['prefix-1', makeAtom({ dhcpOptions: [{ code: 12, value: 'myhost' }] })]]);
    const result = mapAtomsToEngine(atoms, [makeIface()], silentLogger());
    expect(result.networks[0]!.subnets[0]!.dhcpOptions.find((o) => o.code === 12)).toBeDefined();
  });
});

describe('PXE-04 no-lease-authority warning', () => {
  it('warns for a PROXY atom without proxyPeerAuthoritative', () => {
    const atoms = new Map([['prefix-1', makeAtom({ mode: 'PROXY' })]]);
    const logger = silentLogger();
    mapAtomsToEngine(atoms, [makeIface()], logger);
    expect(logger.warn.mock.calls.some(([message]) => message.startsWith('PXE-04:'))).toBe(true);
  });

  it('does not warn when proxyPeerAuthoritative is true', () => {
    const atoms = new Map([['prefix-1', makeAtom({ mode: 'PROXY', proxyPeerAuthoritative: true })]]);
    const logger = silentLogger();
    mapAtomsToEngine(atoms, [makeIface()], logger);
    expect(logger.warn.mock.calls.some(([message]) => message.startsWith('PXE-04:'))).toBe(false);
  });

  it('does not warn for AUTHORITATIVE or OFF atoms', () => {
    const atoms = new Map([
      ['p1', makeAtom({ subnet: '10.0.1.0/24' })],
      ['p2', makeAtom({ subnet: '192.168.9.0/24', mode: 'OFF' })],
    ]);
    const logger = silentLogger();
    mapAtomsToEngine(atoms, [makeIface()], logger);
    expect(logger.warn.mock.calls.some(([message]) => message.startsWith('PXE-04:'))).toBe(false);
  });
});

describe('atomServedInterfaceIps', () => {
  it('returns interfaces hosting a live (post-mapping) subnet, deduped; OFF/unmatched excluded', () => {
    const atoms = new Map([
      ['p1', makeAtom({ subnet: '10.0.1.0/24' })],
      ['p2', makeAtom({ subnet: '192.168.9.0/24', mode: 'OFF' })],
    ]);
    const ifaces = [makeIface(), makeIface({ name: 'eth1', ip: '192.168.9.5', network: '192.168.9.0/24' })];
    const { networks } = mapAtomsToEngine(atoms, ifaces, silentLogger());
    expect(atomServedInterfaceIps(networks)).toEqual([{ interface: 'eth0', ip: '10.0.1.5', cidr: '10.0.1.0/24' }]);
  });

  it('emits one entry per served subnet server ip when an interface hosts multiple subnets', () => {
    const atoms = new Map([
      ['p1', makeAtom({ subnet: '10.0.1.0/24' })],
      [
        'p2',
        makeAtom({ subnet: '10.0.2.0/24', pools: [{ start: '10.0.2.100', end: '10.0.2.200' }], routers: ['10.0.2.1'] }),
      ],
    ]);
    const ifaces = [
      makeIface({ name: 'eth0', ip: '10.0.1.5', network: '10.0.1.0/24' }),
      makeIface({ name: 'eth0', ip: '10.0.2.5', network: '10.0.2.0/24' }),
    ];
    const { networks } = mapAtomsToEngine(atoms, ifaces, silentLogger());
    expect(atomServedInterfaceIps(networks)).toEqual([
      { interface: 'eth0', ip: '10.0.1.5', cidr: '10.0.1.0/24' },
      { interface: 'eth0', ip: '10.0.2.5', cidr: '10.0.2.0/24' },
    ]);
  });

  it('dedupes identical server ips across subnets on the same interface', () => {
    const atoms = new Map([
      ['p1', makeAtom({ subnet: '10.0.1.0/24', pools: [{ start: '10.0.1.10', end: '10.0.1.50' }] })],
      ['p2', makeAtom({ subnet: '10.0.1.0/24', pools: [{ start: '10.0.1.100', end: '10.0.1.200' }] })],
    ]);
    const { networks } = mapAtomsToEngine(atoms, [makeIface({ ip: '10.0.1.5' })], silentLogger());
    expect(atomServedInterfaceIps(networks)).toEqual([{ interface: 'eth0', ip: '10.0.1.5', cidr: '10.0.1.0/24' }]);
  });
});

describe('relayedSubnetCidrs', () => {
  it('derives the relayed subnet cidr from the relay agent ip', () => {
    const atoms = new Map([
      [
        'p1',
        makeAtom({
          subnet: '172.16.80.0/24',
          relay: { relayAgentIp: '172.16.80.1' },
          pools: [],
          routers: ['172.16.80.1'],
        }),
      ],
    ]);
    const { relayed } = mapAtomsToEngine(atoms, [makeIface()], silentLogger());
    expect(relayed).toHaveLength(1);
    expect(relayedSubnetCidrs(relayed)).toEqual(['172.16.80.0/24']);
  });

  it('returns nothing when no relayed subnets exist', () => {
    const { relayed } = mapAtomsToEngine(new Map([['p1', makeAtom()]]), [makeIface()], silentLogger());
    expect(relayedSubnetCidrs(relayed)).toEqual([]);
  });
});
