/** Golden tests for `bridge-sans-vrf` (upstream `brokkr-bridge-netplan-sans-vrf.j2`).
 * The ten-space base indent is real: that template was pre-indented and the whitespace renders. */
import { InterfaceType, TagObjectType } from '@repo/database';
import { describe, expect, it } from 'vitest';
import type { DeviceContext } from '../../../device-context/device-context.types';
import { renderBridgeSansVrf } from '../bridge-sans-vrf';

interface IfaceFixture {
  name: string;
  enabled?: boolean;
  type?: InterfaceType;
  mac?: string | null;
  parentName?: string;
  bridgePrimary?: boolean;
  ips?: string[];
}

interface PrefixFixture {
  id: string;
  cidr: string;
  gatewayIp?: string;
  gatewayRoutingPriority?: number;
  vlanVid?: number;
  roleSlug?: string;
  oobUpstream?: boolean;
}

function buildContext(fix: { interfaces: IfaceFixture[]; prefixes?: PrefixFixture[] }): DeviceContext {
  const tagAssignments: unknown[] = [];

  const prefixes = (fix.prefixes ?? []).map((p, idx) => {
    if (p.oobUpstream) {
      tagAssignments.push({
        objectType: TagObjectType.PREFIX,
        objectId: p.id,
        tag: { slug: 'oob-upstream', name: 'oob-upstream' },
      });
    }
    return {
      id: p.id,
      prefix: p.cidr,
      bondParameters: null,
      enableVlanTag: false,
      vlan: p.vlanVid ? { id: `vlan-${p.vlanVid}`, vid: p.vlanVid, name: `vlan${p.vlanVid}` } : null,
      prefixRole: p.roleSlug ? { id: `role-${p.roleSlug}`, slug: p.roleSlug, name: p.roleSlug } : null,
      gateways: p.gatewayIp
        ? [
            {
              id: `gw-${idx}`,
              vrfId: null,
              routingPriority: p.gatewayRoutingPriority ?? null,
              gatewayIp: { id: `gw-ip-${idx}`, address: `${p.gatewayIp}/${p.cidr.split('/')[1]}`, routingPrefix: null },
            },
          ]
        : [],
      vrf: null,
      vrfId: null,
    };
  });

  const interfaces = fix.interfaces.map((iface, idx) => {
    if (iface.bridgePrimary) {
      tagAssignments.push({
        objectType: TagObjectType.INTERFACE,
        objectId: `iface-${idx}`,
        tag: { slug: 'bridge-primary', name: 'bridge-primary' },
      });
    }
    return {
      id: `iface-${idx}`,
      name: iface.name,
      type: iface.type ?? InterfaceType.ETHERNET_1G,
      macAddress: iface.mac === undefined ? `AA:BB:CC:00:00:0${idx}` : iface.mac,
      enabled: iface.enabled ?? true,
      markConnected: false,
      mtu: null,
      untaggedVlan: null,
      lag: null,
      parent: iface.parentName ? { name: iface.parentName } : null,
      ipAddresses: (iface.ips ?? []).map((address, ipIdx) => ({
        id: `ip-${idx}-${ipIdx}`,
        address,
        routingPrefix: null,
        vrfId: null,
        vrf: null,
      })),
    };
  });

  return {
    device: { id: 'device-1', name: 'bridge-1', supplierId: 'org-1', interfaces },
    ipam: {
      prefixes,
      gateways: [],
      vlans: [],
      vrfs: [],
      l3RouteIps: [],
      bridgeDeviceIps: [],
      vrfPrefixes: [],
    },
    tagAssignments,
    prefixByIpId: {},
    cabledInterfaceIds: [],
  } as unknown as DeviceContext;
}

const render = (fix: Parameters<typeof buildContext>[0]): string => renderBridgeSansVrf(buildContext(fix));

// Ten spaces, per the rendered-indentation table.
const I = ' '.repeat(10);

describe('bridge-sans-vrf generator', () => {
  it('renders at the ten-space base indent with match/set-name and optional', () => {
    const yaml = render({
      interfaces: [{ name: 'eno1', ips: ['10.0.0.5/24'] }],
      prefixes: [{ id: 'p1', cidr: '10.0.0.0/24', gatewayIp: '10.0.0.1', roleSlug: 'primary' }],
    });

    expect(yaml).toBe(
      [
        'network:',
        `${I}ethernets:`,
        `${I}  eno1:`,
        `${I}    match:`,
        // Lowercased, as the Jinja does with `| lower`.
        `${I}      macaddress: aa:bb:cc:00:00:00`,
        `${I}    set-name: eno1`,
        `${I}    dhcp4: false`,
        `${I}    addresses:`,
        `${I}      - 10.0.0.5/24`,
        `${I}    routes:`,
        `${I}      - to: 0.0.0.0/0`,
        `${I}        via: 10.0.0.1`,
        `${I}        metric: 100`,
        `${I}    nameservers:`,
        `${I}      addresses:`,
        `${I}        - 1.1.1.1`,
        `${I}        - 1.0.0.1`,
        `${I}    optional: false`,
        `${I}renderer: networkd`,
        `${I}version: 2`,
        '',
      ].join('\n'),
    );
  });

  it('emits a disabled interface as optional: true rather than skipping it', () => {
    // The key divergence from bridge-default, which drops disabled+uncabled
    // interfaces entirely. Here `enabled` only drives `optional:`.
    const yaml = render({
      interfaces: [{ name: 'eno1', enabled: false, ips: ['10.0.0.5/24'] }],
      prefixes: [{ id: 'p1', cidr: '10.0.0.0/24' }],
    });

    expect(yaml).toContain(`${I}  eno1:`);
    expect(yaml).toContain(`${I}    optional: true`);
  });

  it('keeps optional outside the routes gate', () => {
    const yaml = render({
      interfaces: [{ name: 'eno1', ips: ['10.0.0.5/24'] }],
      prefixes: [{ id: 'p1', cidr: '10.0.0.0/24' }],
    });

    // No gateway -> no routes and no nameservers, but optional still lands.
    expect(yaml).not.toContain('routes:');
    expect(yaml).not.toContain('nameservers:');
    expect(yaml).toContain(`${I}    optional: false`);
  });

  it('omits match/set-name when the interface has no MAC', () => {
    const yaml = render({
      interfaces: [{ name: 'eno1', mac: null, ips: ['10.0.0.5/24'] }],
      prefixes: [{ id: 'p1', cidr: '10.0.0.0/24' }],
    });

    expect(yaml).not.toContain('match:');
    expect(yaml).not.toContain('set-name:');
  });

  it('appends the literal bridge-primary route, with no metric, after the default route', () => {
    const yaml = render({
      interfaces: [{ name: 'eno1', bridgePrimary: true, ips: ['10.0.0.5/24'] }],
      prefixes: [{ id: 'p1', cidr: '10.0.0.0/24', gatewayIp: '10.0.0.1', roleSlug: 'primary' }],
    });

    expect(yaml).toContain(
      [
        `${I}      - to: 0.0.0.0/0`,
        `${I}        via: 10.0.0.1`,
        `${I}        metric: 100`,
        `${I}      - to: 10.0.0.0/12`,
        `${I}        via: 10.2.0.1`,
        `${I}    nameservers:`,
      ].join('\n'),
    );
  });

  it('opens a routes block for a bridge-primary interface that has no gateway at all', () => {
    const yaml = render({
      interfaces: [{ name: 'eno1', bridgePrimary: true, ips: ['10.0.0.5/24'] }],
      prefixes: [{ id: 'p1', cidr: '10.0.0.0/24' }],
    });

    // bridge-primary counts as has_routes on its own.
    expect(yaml).toContain(`${I}    routes:`);
    expect(yaml).toContain(`${I}      - to: 10.0.0.0/12`);
    expect(yaml).toContain(`${I}    nameservers:`);
    expect(yaml).not.toContain('- to: 0.0.0.0/0');
  });

  it('suppresses only the metric line for an oob-upstream prefix, keeping the route', () => {
    const yaml = render({
      interfaces: [{ name: 'eno1', ips: ['10.0.0.5/24'] }],
      prefixes: [{ id: 'p1', cidr: '10.0.0.0/24', gatewayIp: '10.0.0.1', roleSlug: 'primary', oobUpstream: true }],
    });

    expect(yaml).toContain(
      [`${I}      - to: 0.0.0.0/0`, `${I}        via: 10.0.0.1`, `${I}    nameservers:`].join('\n'),
    );
    expect(yaml).not.toContain('metric:');
  });

  it('still advances the metric counter across an oob-upstream route', () => {
    const yaml = render({
      interfaces: [
        { name: 'eno1', ips: ['10.0.0.5/24'] },
        { name: 'eno2', ips: ['10.1.0.5/24'] },
      ],
      prefixes: [
        { id: 'p1', cidr: '10.0.0.0/24', gatewayIp: '10.0.0.1', roleSlug: 'primary', oobUpstream: true },
        { id: 'p2', cidr: '10.1.0.0/24', gatewayIp: '10.1.0.1', roleSlug: 'primary' },
      ],
    });

    // eno1 consumed 100 without printing it, so eno2 gets 101 — the Jinja
    // increments outside the metric-emitting branch.
    expect(yaml).toContain(`${I}        metric: 101`);
    expect(yaml).not.toContain('metric: 100');
  });

  it('resolves prefixes without any VRF filter', () => {
    // Both fixture prefixes contain the IP; the gateway-bearing one wins even
    // though no VRF matches anything.
    const yaml = render({
      interfaces: [{ name: 'eno1', ips: ['10.0.0.5/24'] }],
      prefixes: [
        { id: 'p-wide', cidr: '10.0.0.0/16' },
        { id: 'p-gw', cidr: '10.0.0.0/24', gatewayIp: '10.0.0.1', roleSlug: 'primary' },
      ],
    });

    expect(yaml).toContain(`${I}      - 10.0.0.5/24`);
    expect(yaml).toContain(`${I}        via: 10.0.0.1`);
  });
});
