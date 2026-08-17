import { describe, expect, it } from 'vitest';
import { DhcpAtomValueSchema } from '../../../../../bridge/src/dhcp/dhcp-atom-value.schema';
import { DhcpAtomSchema } from '../dhcp-atom.schema';

const SHARED_FIXTURES = [
  {
    name: 'authoritative with all fields populated',
    input: {
      mode: 'AUTHORITATIVE' as const,
      subnet: '10.0.1.0/24',
      pools: [{ start: '10.0.1.100', end: '10.0.1.200' }],
      routers: ['10.0.1.1'],
      dnsServers: ['8.8.8.8'],
      leaseTtlSeconds: 3600,
      reservations: [{ mac: 'aa:bb:cc:dd:ee:ff', ip: '10.0.1.50' }],
      proxyAllowedMacs: [],
      dhcpOptions: [{ code: 43, value: '0a:0b:0c' }],
      nextServer: '10.0.1.1',
      ipxeBuildTarget: 'IPXE' as const,
      relay: { relayAgentIp: '10.0.1.254' },
    },
  },
  {
    name: 'proxy mode with allowed MACs',
    input: {
      mode: 'PROXY' as const,
      subnet: '192.168.0.0/24',
      pools: [],
      routers: [],
      dnsServers: [],
      leaseTtlSeconds: 600,
      reservations: [
        { mac: 'aa:bb:cc:00:11:22', ip: '192.168.0.10', bootFilename: 'custom-image.efi' },
        { mac: 'aa:bb:cc:00:11:33', ip: '192.168.0.11' },
      ],
      proxyAllowedMacs: ['aa:bb:cc:00:11:22', 'aa:bb:cc:00:11:33'],
      dhcpOptions: [],
      nextServer: null,
      ipxeBuildTarget: null,
      relay: null,
    },
  },
  {
    name: 'reservation with a per-device ipxeBuildTarget override',
    input: {
      mode: 'AUTHORITATIVE' as const,
      subnet: '10.0.1.0/24',
      pools: [{ start: '10.0.1.100', end: '10.0.1.200' }],
      routers: ['10.0.1.1'],
      dnsServers: [],
      leaseTtlSeconds: 600,
      reservations: [
        { mac: 'aa:bb:cc:dd:ee:01', ip: '10.0.1.50', ipxeBuildTarget: 'SNP' as const },
        { mac: 'aa:bb:cc:dd:ee:02', ip: '10.0.1.51' },
      ],
      proxyAllowedMacs: [],
      dhcpOptions: [],
      nextServer: '10.0.1.1',
      ipxeBuildTarget: 'IPXE' as const,
      relay: null,
    },
  },
  {
    name: 'off mode (minimal)',
    input: {
      mode: 'OFF' as const,
      subnet: '172.16.0.0/16',
      pools: [],
      routers: [],
      dnsServers: [],
      leaseTtlSeconds: 120,
      reservations: [],
      proxyAllowedMacs: [],
      dhcpOptions: [],
      nextServer: null,
      ipxeBuildTarget: 'SNPONLY' as const,
      relay: null,
    },
  },
];

describe('DHCP atom schema agreement (hub + bridge)', () => {
  it('both schemas reject an invalid bootFilename', () => {
    const input = {
      ...SHARED_FIXTURES[1].input,
      reservations: [{ mac: 'aa:bb:cc:00:11:22', ip: '192.168.0.10', bootFilename: 'bad/path.efi' }],
    };
    expect(DhcpAtomSchema.safeParse(input).success).toBe(false);
    expect(DhcpAtomValueSchema.safeParse(input).success).toBe(false);
  });

  for (const fixture of SHARED_FIXTURES) {
    it(`both schemas parse "${fixture.name}" identically`, () => {
      const hubResult = DhcpAtomSchema.safeParse(fixture.input);
      const bridgeResult = DhcpAtomValueSchema.safeParse(fixture.input);

      expect(hubResult.success).toBe(true);
      expect(bridgeResult.success).toBe(true);

      if (hubResult.success && bridgeResult.success) {
        expect(hubResult.data).toEqual(bridgeResult.data);
      }
    });
  }

  it('hub and bridge schemas have the same top-level field names', () => {
    const hubKeys = Object.keys(DhcpAtomSchema.shape).sort();
    const bridgeKeys = Object.keys(DhcpAtomValueSchema.shape).sort();
    expect(hubKeys).toEqual(bridgeKeys);
  });

  it('hub schema rejects extra properties (strict mode)', () => {
    const input = { ...SHARED_FIXTURES[0].input, bogus: true };
    const hubResult = DhcpAtomSchema.safeParse(input);
    expect(hubResult.success).toBe(false);
  });

  it('bridge schema allows extra properties (top-level lax for rolling upgrades)', () => {
    const input = { ...SHARED_FIXTURES[0].input, bogus: true };
    const bridgeResult = DhcpAtomValueSchema.safeParse(input);
    expect(bridgeResult.success).toBe(true);
  });
});
