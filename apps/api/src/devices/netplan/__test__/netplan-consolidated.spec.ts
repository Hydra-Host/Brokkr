/** Dispatch tests: the right family for the right data. Output shapes are pinned by the golden
 * tests in `render/__test__/`; here we only prove routing reaches each module. */
import { DeviceRole, NetplanPopulation, ZoneEastWestNetworkType, ZoneNetworkType } from '@repo/database';
import { describe, expect, it } from 'vitest';
import type { DeviceContext } from '../../device-context/device-context.types';
import { derivePopulation, renderNetplanYaml } from '../netplan-consolidated';

interface Fixture {
  role?: DeviceRole | null;
  /** Explicit population pin — the exception escape hatch. */
  pin?: NetplanPopulation;
  zoneNetworkType?: ZoneNetworkType | null;
  eastWest?: ZoneEastWestNetworkType;
  /** interface IPs as [address, vrfId | null] */
  ips?: Array<[string, string | null]>;
  /** containing prefixes as [cidr, vrfId | null, bondParameters | null] */
  prefixes?: Array<[string, string | null, Record<string, unknown> | null]>;
}

function buildContext(fix: Fixture): DeviceContext {
  return {
    device: {
      id: 'device-1',
      role: fix.role ?? null,
      netplanOverride: null,
      netplanPopulation: fix.pin ?? null,
      zone:
        fix.zoneNetworkType != null
          ? { networkType: fix.zoneNetworkType, eastWestNetworkType: fix.eastWest ?? null }
          : null,
      server: null,
      interfaces: [
        {
          id: 'iface-1',
          name: 'eno1',
          enabled: true,
          type: 'PHYSICAL',
          macAddress: 'aa:bb:cc:dd:ee:01',
          mtu: null,
          mgmtOnly: false,
          markConnected: false,
          parent: null,
          ipAddresses: (fix.ips ?? []).map(([address, vrfId], i) => ({ id: `ip-${i}`, address, vrfId })),
        },
      ],
    },
    ipam: {
      prefixes: (fix.prefixes ?? []).map(([cidr, vrfId, bondParameters], i) => ({
        id: `prefix-${i}`,
        prefix: cidr,
        vrfId,
        bondParameters,
        gateways: [],
        vlan: null,
        prefixRole: null,
        enableVlanTag: false,
      })),
      gateways: [],
      vlans: [],
      vrfs: [],
      l3RouteIps: [],
      bridgeDeviceIps: [],
      vrfPrefixes: [],
    },
    tagAssignments: [],
    cabledInterfaceIds: [],
    prefixByIpId: {},
  } as unknown as DeviceContext;
}

describe('derivePopulation', () => {
  it('routes bridges with a bond-parameters prefix to bridge-bonded', () => {
    const ctx = buildContext({
      role: DeviceRole.Bridge,
      ips: [['10.1.0.5/24', 'vrf-1']],
      prefixes: [['10.1.0.0/24', 'vrf-1', { mode: '802.3ad' }]],
    });
    expect(derivePopulation(ctx)).toBe('bridge-bonded');
  });

  it('routes bridges with VRF-bearing IPs to bridge-default', () => {
    const ctx = buildContext({
      role: DeviceRole.Bridge,
      ips: [['10.1.0.5/24', 'vrf-1']],
      prefixes: [['10.1.0.0/24', 'vrf-1', null]],
    });
    expect(derivePopulation(ctx)).toBe('bridge-default');
  });

  it('routes bridges whose prefix carries the VRF (IP without one) to bridge-default', () => {
    const ctx = buildContext({
      role: DeviceRole.Bridge,
      ips: [['10.1.0.5/24', null]],
      prefixes: [['10.1.0.0/24', 'vrf-1', null]],
    });
    expect(derivePopulation(ctx)).toBe('bridge-default');
  });

  it('routes VRF-less bridges to bridge-sans-vrf', () => {
    const ctx = buildContext({
      role: DeviceRole.Bridge,
      ips: [['10.1.0.5/24', null]],
      prefixes: [['10.1.0.0/24', null, null]],
    });
    expect(derivePopulation(ctx)).toBe('bridge-sans-vrf');
  });

  it('routes VPC zones to vpc, and ROCE east-west to vpc-roce', () => {
    expect(derivePopulation(buildContext({ role: DeviceRole.Baremetal, zoneNetworkType: ZoneNetworkType.VPC }))).toBe(
      'vpc',
    );
    expect(
      derivePopulation(
        buildContext({
          role: DeviceRole.Baremetal,
          zoneNetworkType: ZoneNetworkType.VPC,
          eastWest: ZoneEastWestNetworkType.ROCE,
        }),
      ),
    ).toBe('vpc-roce');
  });

  it('routes everything else to flat, including zoneless devices', () => {
    expect(derivePopulation(buildContext({ role: DeviceRole.Baremetal, zoneNetworkType: ZoneNetworkType.FLAT }))).toBe(
      'flat',
    );
    expect(derivePopulation(buildContext({ role: null }))).toBe('flat');
  });

  it('a bridge never reads the zone network type — bridge template even in a VPC zone', () => {
    const ctx = buildContext({
      role: DeviceRole.Bridge,
      zoneNetworkType: ZoneNetworkType.VPC,
      ips: [['10.1.0.5/24', 'vrf-1']],
      prefixes: [['10.1.0.0/24', 'vrf-1', null]],
    });
    expect(derivePopulation(ctx)).toBe('bridge-default');
  });
});

describe('population pin', () => {
  it('overrides the derivation for every family', () => {
    const cases: Array<[NetplanPopulation, string]> = [
      [NetplanPopulation.FLAT, 'flat'],
      [NetplanPopulation.VPC, 'vpc'],
      [NetplanPopulation.VPC_ROCE, 'vpc-roce'],
      [NetplanPopulation.BRIDGE_DEFAULT, 'bridge-default'],
      [NetplanPopulation.BRIDGE_BONDED, 'bridge-bonded'],
      [NetplanPopulation.BRIDGE_SANS_VRF, 'bridge-sans-vrf'],
    ];
    for (const [pin, expected] of cases) {
      // Role and zone say "bridge"; the pin must win regardless.
      const ctx = buildContext({
        pin,
        role: DeviceRole.Bridge,
        ips: [['10.1.0.5/24', 'vrf-1']],
        prefixes: [['10.1.0.0/24', 'vrf-1', null]],
      });
      expect(derivePopulation(ctx)).toBe(expected);
    }
  });

  it('pins the real class-1 case: a Bridge-role device onto the flat template', () => {
    // bridge-1840 in the dev backup — NetBox renders it with the flat template,
    // so the derivation's role rule sends it to the wrong family.
    const unpinned = buildContext({ role: DeviceRole.Bridge });
    expect(derivePopulation(unpinned)).toBe('bridge-sans-vrf');

    const pinned = buildContext({ role: DeviceRole.Bridge, pin: NetplanPopulation.FLAT });
    expect(derivePopulation(pinned)).toBe('flat');
    expect(renderNetplanYaml(pinned, { phase: 'live' })).toContain('all-interfaces:');
  });

  it('leaves derivation alone when unpinned', () => {
    expect(derivePopulation(buildContext({ role: DeviceRole.Baremetal }))).toBe('flat');
  });
});

describe('empty-IPAM guard', () => {
  it('refuses to render a device that has addresses but resolved no prefixes', () => {
    const ctx = buildContext({ role: DeviceRole.Baremetal, ips: [['10.1.0.5/24', null]], prefixes: [] });

    expect(() => renderNetplanYaml(ctx, { phase: 'live' })).toThrow(/would be dropped and the device would boot/);
    expect(() => renderNetplanYaml(ctx, { phase: 'live' })).toThrow(/supplier organization/);
  });

  it('fires for bridges too — the population is derived after the guard', () => {
    const ctx = buildContext({ role: DeviceRole.Bridge, ips: [['10.1.0.5/24', 'vrf-1']], prefixes: [] });

    expect(() => renderNetplanYaml(ctx, { phase: 'live' })).toThrow(/no IPAM prefixes resolved/);
  });

  it('leaves an addressless device alone so the wildcard DHCP fallback still renders', () => {
    const yaml = renderNetplanYaml(buildContext({ role: DeviceRole.Baremetal, prefixes: [] }), { phase: 'live' });

    expect(yaml).toContain('all-interfaces:');
    expect(yaml).toContain('dhcp4: true');
  });

  it('does not fire when prefixes are present', () => {
    const ctx = buildContext({
      role: DeviceRole.Baremetal,
      ips: [['10.1.0.5/24', null]],
      prefixes: [['10.1.0.0/24', null, null]],
    });

    expect(() => renderNetplanYaml(ctx, { phase: 'live' })).not.toThrow();
  });
});

describe('renderNetplanYaml dispatch', () => {
  it('reaches the bridge module (networkd renderer is bridge-only)', () => {
    const ctx = buildContext({
      role: DeviceRole.Bridge,
      ips: [['10.1.0.5/24', 'vrf-1']],
      prefixes: [['10.1.0.0/24', 'vrf-1', null]],
    });
    expect(renderNetplanYaml(ctx, { phase: 'live' })).toContain('renderer: networkd');
  });

  it('reaches the flat module (wildcard DHCP fallback for an addressless device)', () => {
    const yaml = renderNetplanYaml(buildContext({ role: DeviceRole.Baremetal }), { phase: 'live' });
    expect(yaml).toContain('all-interfaces:');
    expect(yaml).toContain('dhcp4: true');
  });

  it('reaches the vpc module (its wildcard fallback carries the template offset)', () => {
    const yaml = renderNetplanYaml(buildContext({ role: DeviceRole.Baremetal, zoneNetworkType: ZoneNetworkType.VPC }), {
      phase: 'live',
    });
    expect(yaml).toContain('        ethernets:');
  });
});
