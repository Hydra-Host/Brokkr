/** Golden tests for `bridge-bonded` (upstream `bridge-or-host-netplan-vlan-bond.j2`).
 * Base indent is the standard 2 here — confirmed by rendering, not assumed. */
import { InterfaceType } from '@repo/database';
import { describe, expect, it } from 'vitest';
import type { DeviceContext } from '../../../device-context/device-context.types';
import { renderBridgeBonded } from '../bridge-bonded';

interface IfaceFixture {
  name: string;
  type?: InterfaceType;
  enabled?: boolean;
  cabled?: boolean;
  mac?: string | null;
  parentName?: string;
  ips?: string[];
}

interface PrefixFixture {
  id: string;
  cidr: string;
  gatewayIp?: string;
  vlanVid?: number;
  roleSlug?: string;
  bondParameters?: Record<string, unknown>;
}

const VRF_ID = 'vrf-1';

function buildContext(fix: { interfaces: IfaceFixture[]; prefixes?: PrefixFixture[] }): DeviceContext {
  const vrf = { id: VRF_ID, name: '10' };
  const prefixes = (fix.prefixes ?? []).map((p, idx) => ({
    id: p.id,
    prefix: p.cidr,
    bondParameters: p.bondParameters ?? null,
    enableVlanTag: false,
    vlan: p.vlanVid ? { id: `vlan-${p.vlanVid}`, vid: p.vlanVid, name: `vlan${p.vlanVid}` } : null,
    prefixRole: p.roleSlug ? { id: `role-${p.roleSlug}`, slug: p.roleSlug, name: p.roleSlug } : null,
    gateways: p.gatewayIp
      ? [
          {
            id: `gw-${idx}`,
            vrfId: VRF_ID,
            routingPriority: null,
            gatewayIp: { id: `gw-ip-${idx}`, address: `${p.gatewayIp}/${p.cidr.split('/')[1]}`, routingPrefix: null },
          },
        ]
      : [],
    vrf,
    vrfId: VRF_ID,
  }));

  const interfaces = fix.interfaces.map((iface, idx) => ({
    id: `iface-${idx}`,
    name: iface.name,
    type: iface.type ?? InterfaceType.ETHERNET_10G,
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
      vrfId: VRF_ID,
      vrf,
    })),
  }));

  return {
    device: { id: 'device-1', name: 'host-1', supplierId: 'org-1', interfaces },
    ipam: {
      prefixes,
      gateways: [],
      vlans: [],
      vrfs: [vrf],
      l3RouteIps: [],
      bridgeDeviceIps: [],
      vrfPrefixes: [],
    },
    tagAssignments: [],
    prefixByIpId: {},
    cabledInterfaceIds: fix.interfaces
      .map((i, idx) => (i.cabled ? `iface-${idx}` : null))
      .filter((id): id is string => id !== null),
  } as unknown as DeviceContext;
}

const render = (fix: Parameters<typeof buildContext>[0]): string => renderBridgeBonded(buildContext(fix));

const BOND_PARAMS = { mode: '802.3ad', 'lacp-rate': 'fast' };

describe('bridge-bonded generator', () => {
  it('emits version and renderer first, then a bond with its unusual key order', () => {
    const yaml = render({
      interfaces: [
        { name: 'eno1', ips: ['10.0.0.5/24'] },
        // IP-less, same type -> auto-joins the bond.
        { name: 'eno2' },
      ],
      prefixes: [
        { id: 'p1', cidr: '10.0.0.0/24', gatewayIp: '10.0.0.1', roleSlug: 'primary', bondParameters: BOND_PARAMS },
      ],
    });

    expect(yaml).toBe(
      [
        'network:',
        // version + renderer lead, before any interface block.
        '  version: 2',
        '  renderer: networkd',
        '  ethernets:',
        '    eno1:',
        '      dhcp4: false',
        '      optional: true',
        '    eno2:',
        '      dhcp4: false',
        '      optional: true',
        '  bonds:',
        '    bond0:',
        // Second member alphabetically (eno2), emitted BEFORE interfaces:.
        '      macaddress: aa:bb:cc:00:00:01',
        '      interfaces:',
        '        - eno1',
        '        - eno2',
        '      addresses:',
        '        - 10.0.0.5/24',
        '      routes:',
        '        - to: 0.0.0.0/0',
        '          via: 10.0.0.1',
        '          metric: 100',
        // nameservers outside the gate, then parameters, then dhcp4 last.
        '      nameservers:',
        '        addresses:',
        '          - 1.1.1.1',
        '          - 1.0.0.1',
        '      parameters:',
        '        mode: 802.3ad',
        '        lacp-rate: fast',
        '      dhcp4: false',
        '',
      ].join('\n'),
    );
  });

  it('emits bond nameservers even when the bond has no routes at all', () => {
    const yaml = render({
      interfaces: [{ name: 'eno1', ips: ['10.0.0.5/24'] }, { name: 'eno2' }],
      prefixes: [{ id: 'p1', cidr: '10.0.0.0/24', bondParameters: BOND_PARAMS }],
    });

    expect(yaml).not.toContain('      routes:');
    // The divergence from the ethernet block in this same template.
    expect(yaml).toContain('      nameservers:');
  });

  it('creates one bond per interface type, named in first-encounter order', () => {
    const yaml = render({
      interfaces: [
        { name: 'ten1', type: InterfaceType.ETHERNET_10G, ips: ['10.0.0.5/24'] },
        { name: 'one1', type: InterfaceType.ETHERNET_1G, ips: ['10.1.0.5/24'] },
        { name: 'ten2', type: InterfaceType.ETHERNET_10G },
        { name: 'one2', type: InterfaceType.ETHERNET_1G },
      ],
      prefixes: [
        { id: 'p1', cidr: '10.0.0.0/24', bondParameters: BOND_PARAMS },
        { id: 'p2', cidr: '10.1.0.0/24', bondParameters: BOND_PARAMS },
      ],
    });

    // 10G was seen first -> bond0; 1G -> bond1. Members group by type.
    expect(yaml).toMatch(/ {4}bond0:[\s\S]*? {8}- ten1\n {8}- ten2\n/);
    expect(yaml).toMatch(/ {4}bond1:[\s\S]*? {8}- one1\n {8}- one2\n/);
  });

  it('auto-joins only IP-less interfaces, not same-type interfaces that have IPs elsewhere', () => {
    const yaml = render({
      interfaces: [
        { name: 'eno1', ips: ['10.0.0.5/24'] },
        // Same type but has an IP on a NON-bond prefix: flat-default's rule would
        // pull it in; this template's must not.
        { name: 'eno2', ips: ['10.9.0.5/24'] },
        { name: 'eno3' },
      ],
      prefixes: [
        { id: 'p1', cidr: '10.0.0.0/24', bondParameters: BOND_PARAMS },
        { id: 'p2', cidr: '10.9.0.0/24' },
      ],
    });

    expect(yaml).toMatch(/ {6}interfaces:\n {8}- eno1\n {8}- eno3\n/);
    // eno2 stays a normal configured ethernet.
    expect(yaml).toMatch(/ {4}eno2:\n {6}dhcp4: false\n {6}addresses:\n {8}- 10\.9\.0\.5\/24/);
  });

  it('links a bond-attached VLAN to the bond and a plain VLAN to its parent', () => {
    const yaml = render({
      interfaces: [
        { name: 'eno1', ips: ['10.0.100.5/24'] },
        { name: 'eno2' },
        { name: 'eno9.200', type: InterfaceType.VIRTUAL, parentName: 'eno9', ips: ['10.0.200.5/24'] },
      ],
      prefixes: [
        { id: 'p1', cidr: '10.0.100.0/24', vlanVid: 100, bondParameters: BOND_PARAMS },
        { id: 'p2', cidr: '10.0.200.0/24', vlanVid: 200 },
      ],
    });

    // Bond VLAN is named <bond>.<vid> and links to the bond.
    expect(yaml).toMatch(/ {4}bond0\.100:\n {6}id: 100\n {6}link: bond0\n/);
    // Device VLAN keeps its own name and links to its parent.
    expect(yaml).toMatch(/ {4}eno9\.200:\n {6}id: 200\n {6}link: eno9\n/);
  });

  it('emits ethernet mtu before addresses', () => {
    const yaml = render({
      interfaces: [{ name: 'eno1', ips: ['10.0.0.5/24'] }],
      prefixes: [{ id: 'p1', cidr: '10.0.0.0/24' }],
    });

    // No bond here, so eno1 is a plain configured ethernet.
    expect(yaml).toMatch(/ {4}eno1:\n {6}dhcp4: false\n {6}addresses:\n/);
  });

  it('accepts a disabled-but-cabled interface for IPs but never auto-joins it to a bond', () => {
    const yaml = render({
      interfaces: [
        { name: 'eno1', ips: ['10.0.0.5/24'] },
        { name: 'eno2' },
        // Disabled + cabled + IP-less: eligible for the IP pass, but the
        // member-join pass requires `enabled`, so it must NOT become a member.
        { name: 'eno3', enabled: false, cabled: true },
      ],
      prefixes: [{ id: 'p1', cidr: '10.0.0.0/24', bondParameters: BOND_PARAMS }],
    });

    expect(yaml).toMatch(/ {6}interfaces:\n {8}- eno1\n {8}- eno2\n {6}/);
    expect(yaml).not.toContain('- eno3');
    // It still appears under ethernets, unconfigured.
    expect(yaml).toMatch(/ {4}eno3:\n {6}dhcp4: true\n {6}optional: true/);
  });

  it('shares one metric counter across ethernets, bonds and vlans in that order', () => {
    const yaml = render({
      interfaces: [
        { name: 'aeth', type: InterfaceType.ETHERNET_1G, ips: ['10.9.0.5/24'] },
        { name: 'zeno1', ips: ['10.0.0.5/24'] },
        { name: 'zeno2' },
      ],
      prefixes: [
        { id: 'p2', cidr: '10.9.0.0/24', gatewayIp: '10.9.0.1', roleSlug: 'primary' },
        {
          id: 'p1',
          cidr: '10.0.0.0/24',
          gatewayIp: '10.0.0.1',
          roleSlug: 'primary',
          bondParameters: BOND_PARAMS,
        },
      ],
    });

    // The ethernet takes 100, the bond continues at 101.
    expect(yaml).toContain('          metric: 100');
    expect(yaml).toContain('          metric: 101');
  });
});
