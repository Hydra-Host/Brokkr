/** Golden tests for `bridge-default` (upstream `brokkr-bridge-netplan.j2`).
 * Expected YAML derived by hand from the template — these pin the emit shape. */
import { InterfaceType } from '@repo/database';
import { describe, expect, it } from 'vitest';
import type { DeviceContext } from '../../../device-context/device-context.types';
import { renderBridgeDefault } from '../bridge-default';

interface IfaceFixture {
  name: string;
  enabled?: boolean;
  type?: InterfaceType;
  mtu?: number | null;
  parentName?: string;
  cabled?: boolean;
  ips?: string[];
}

interface PrefixFixture {
  id: string;
  cidr: string;
  gatewayIp?: string;
  gatewayRoutingPriority?: number;
  vlanVid?: number;
  roleSlug?: string;
}

const VRF_ID = 'vrf-1';

function buildContext(fix: { interfaces: IfaceFixture[]; prefixes?: PrefixFixture[] }): DeviceContext {
  const vrf = { id: VRF_ID, name: '10', organizationId: 'org-1' };

  const prefixes = (fix.prefixes ?? []).map((p, idx) => ({
    id: p.id,
    prefix: p.cidr,
    organizationId: 'org-1',
    bondParameters: null,
    enableVlanTag: false,
    vlan: p.vlanVid ? { id: `vlan-${p.vlanVid}`, vid: p.vlanVid, name: `vlan${p.vlanVid}` } : null,
    prefixRole: p.roleSlug ? { id: `role-${p.roleSlug}`, slug: p.roleSlug, name: p.roleSlug } : null,
    gateways: p.gatewayIp
      ? [
          {
            id: `gw-${idx}`,
            vrfId: VRF_ID,
            routingPriority: p.gatewayRoutingPriority ?? null,
            gatewayIp: { id: `gw-ip-${idx}`, address: `${p.gatewayIp}/${p.cidr.split('/')[1]}`, routingPrefix: null },
            vrf,
          },
        ]
      : [],
    vrf,
    vrfId: VRF_ID,
  }));

  const interfaces = fix.interfaces.map((iface, idx) => ({
    id: `iface-${idx}`,
    name: iface.name,
    type: iface.type ?? InterfaceType.ETHERNET_1G,
    macAddress: `aa:bb:cc:00:00:0${idx}`,
    enabled: iface.enabled ?? true,
    markConnected: false,
    mtu: iface.mtu ?? null,
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

  const cabledInterfaceIds = fix.interfaces
    .map((iface, idx) => (iface.cabled ? `iface-${idx}` : null))
    .filter((id): id is string => id !== null);

  return {
    device: { id: 'device-1', name: 'bridge-1', supplierId: 'org-1', interfaces },
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
    cabledInterfaceIds,
  } as unknown as DeviceContext;
}

// `generate` takes only the context: unlike the VPC family, this template has no
// platform or lifecycle branch, so its output is identical for both phases.
const render = (fix: Parameters<typeof buildContext>[0]): string => renderBridgeDefault(buildContext(fix));

describe('bridge-default generator', () => {
  it('renders a single addressed interface with routes and networkd trailer', () => {
    const yaml = render({
      interfaces: [{ name: 'eno1', ips: ['10.0.0.5/24'] }],
      prefixes: [{ id: 'p1', cidr: '10.0.0.0/24', gatewayIp: '10.0.0.1', roleSlug: 'primary' }],
    });

    expect(yaml).toBe(
      [
        'network:',
        '  ethernets:',
        '    eno1:',
        '      dhcp4: false',
        '      addresses:',
        '        - 10.0.0.5/24',
        '      routes:',
        '        - to: 0.0.0.0/0',
        '          via: 10.0.0.1',
        '          metric: 100',
        // 1.0.0.1, not flat-default's 8.8.8.8.
        '      nameservers:',
        '        addresses:',
        '          - 1.1.1.1',
        '          - 1.0.0.1',
        '  renderer: networkd',
        '  version: 2',
        '',
      ].join('\n'),
    );
  });

  it('emits mtu after addresses, and no match/optional keys at all', () => {
    const yaml = render({
      interfaces: [{ name: 'eno1', mtu: 9000, ips: ['10.0.0.5/24'] }],
      prefixes: [{ id: 'p1', cidr: '10.0.0.0/24' }],
    });

    expect(yaml).toMatch(/ {6}addresses:\n {8}- 10\.0\.0\.5\/24\n {6}mtu: 9000\n/);
    expect(yaml).not.toContain('match:');
    expect(yaml).not.toContain('optional:');
    expect(yaml).not.toContain('macaddress:');
  });

  it('DHCPs an unaddressed interface but not a VLAN parent', () => {
    const yaml = render({
      interfaces: [{ name: 'eno1', ips: ['10.0.0.5/24'] }, { name: 'eno2' }],
      prefixes: [{ id: 'p1', cidr: '10.0.0.0/24', vlanVid: 100 }],
    });

    // eno1 carries the VLAN prefix, so it becomes the VLAN parent -> dhcp4 false.
    expect(yaml).toMatch(/ {4}eno1:\n {6}dhcp4: false\n {4}eno2:\n {6}dhcp4: true\n/);
  });

  it('omits routes and nameservers entirely when there is no gateway', () => {
    const yaml = render({
      interfaces: [{ name: 'eno1', ips: ['10.0.0.5/24'] }],
      prefixes: [{ id: 'p1', cidr: '10.0.0.0/24' }],
    });

    expect(yaml).not.toContain('routes:');
    // The Jinja puts nameservers inside the has_routes gate.
    expect(yaml).not.toContain('nameservers:');
  });

  it('configures a disabled-but-cabled interface, and skips a disabled uncabled one', () => {
    const yaml = render({
      interfaces: [
        { name: 'eno1', enabled: false, cabled: true, ips: ['10.0.0.5/24'] },
        { name: 'eno2', enabled: false, cabled: false, ips: ['10.0.0.6/24'] },
      ],
      prefixes: [{ id: 'p1', cidr: '10.0.0.0/24' }],
    });

    expect(yaml).toContain('    eno1:');
    expect(yaml).toContain('        - 10.0.0.5/24');
    expect(yaml).not.toContain('    eno2:');
    expect(yaml).not.toContain('        - 10.0.0.6/24');
  });

  it('always tags a VLAN prefix and links through the parent relation', () => {
    const yaml = render({
      interfaces: [{ name: 'eno1.100', type: InterfaceType.VIRTUAL, parentName: 'eno1', ips: ['10.0.100.5/24'] }],
      prefixes: [{ id: 'p1', cidr: '10.0.100.0/24', gatewayIp: '10.0.100.1', vlanVid: 100, roleSlug: 'primary' }],
    });

    // The interface is already named eno1.100, so no second .100 suffix, and the
    // link points at the parent. A virtual interface never reaches `ethernets:`.
    expect(yaml).toBe(
      [
        'network:',
        '  ethernets:',
        '  vlans:',
        '    eno1.100:',
        '      id: 100',
        '      link: eno1',
        '      dhcp4: false',
        '      addresses:',
        '        - 10.0.100.5/24',
        '      routes:',
        '        - to: 0.0.0.0/0',
        '          via: 10.0.100.1',
        '          metric: 100',
        '      nameservers:',
        '        addresses:',
        '          - 1.1.1.1',
        '          - 1.0.0.1',
        '  renderer: networkd',
        '  version: 2',
        '',
      ].join('\n'),
    );
  });

  it('offsets a secondary-role default route by 500', () => {
    const yaml = render({
      interfaces: [{ name: 'eno1', ips: ['10.0.0.5/24'] }],
      prefixes: [{ id: 'p1', cidr: '10.0.0.0/24', gatewayIp: '10.0.0.1', roleSlug: 'secondary' }],
    });

    expect(yaml).toContain('          metric: 600');
  });

  it('prefers an explicit gateway routing priority over the counter', () => {
    const yaml = render({
      interfaces: [{ name: 'eno1', ips: ['10.0.0.5/24'] }],
      prefixes: [{ id: 'p1', cidr: '10.0.0.0/24', gatewayIp: '10.0.0.1', gatewayRoutingPriority: 42 }],
    });

    expect(yaml).toContain('          metric: 42');
  });

  it('shares one metric counter across ethernets and vlans', () => {
    const yaml = render({
      interfaces: [
        { name: 'eno1', ips: ['10.0.0.5/24'] },
        { name: 'eno2.100', type: InterfaceType.VIRTUAL, parentName: 'eno2', ips: ['10.0.100.5/24'] },
      ],
      prefixes: [
        { id: 'p1', cidr: '10.0.0.0/24', gatewayIp: '10.0.0.1', roleSlug: 'primary' },
        { id: 'p2', cidr: '10.0.100.0/24', gatewayIp: '10.0.100.1', vlanVid: 100, roleSlug: 'primary' },
      ],
    });

    // Ethernet takes 100; the VLAN continues at 101 rather than restarting,
    // which is where flat-default diverges.
    expect(yaml).toContain('          metric: 100');
    expect(yaml).toContain('          metric: 101');
  });
});
