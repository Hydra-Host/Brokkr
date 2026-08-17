/** Golden tests for `flat` (upstream NetBox `netplan.j2`, the largest population).
 * Expected YAML derived by hand from the template — these pin the emit shape. */
import { DeviceRole, InterfaceType } from '@repo/database';
import { describe, expect, it } from 'vitest';
import type { DeviceContext } from '../../../device-context/device-context.types';
import { renderFlat } from '../flat';

interface IfaceFixture {
  name: string;
  mac?: string;
  enabled?: boolean;
  type?: InterfaceType;
  mtu?: number | null;
  ips?: string[];
}

interface PrefixFixture {
  id: string;
  cidr: string;
  gatewayIp?: string;
  vlanVid?: number;
  roleSlug?: string;
  bondParameters?: Record<string, unknown> | null;
}

const VRF_ID = 'vrf-1';

function buildContext(fix: {
  role?: DeviceRole | null;
  interfaces: IfaceFixture[];
  prefixes?: PrefixFixture[];
}): DeviceContext {
  const vrf = { id: VRF_ID, name: '10', organizationId: 'org-1' };

  const prefixes = (fix.prefixes ?? []).map((p, idx) => ({
    id: p.id,
    prefix: p.cidr,
    organizationId: 'org-1',
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
    macAddress: iface.mac ?? `aa:bb:cc:00:00:0${idx}`,
    enabled: iface.enabled ?? true,
    markConnected: false,
    mtu: iface.mtu ?? null,
    untaggedVlan: null,
    lag: null,
    parent: null,
    ipAddresses: (iface.ips ?? []).map((address, ipIdx) => ({
      id: `ip-${idx}-${ipIdx}`,
      address,
      routingPrefix: null,
      vrfId: VRF_ID,
      vrf,
    })),
  }));

  return {
    device: {
      id: 'device-1',
      name: 'host-1',
      role: fix.role ?? DeviceRole.Baremetal,
      supplierId: 'org-1',
      netplanOverride: null,
      netplanPopulation: null,
      interfaces,
    },
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
    cabledInterfaceIds: [],
  } as unknown as DeviceContext;
}

const render = (fix: Parameters<typeof buildContext>[0], phase: 'live' | 'deploy' = 'live'): string =>
  renderFlat(buildContext(fix), phase);

describe('flat generator', () => {
  it('falls back to wildcard DHCP when no eligible interface carries an IP', () => {
    const yaml = render({ interfaces: [{ name: 'eno1' }, { name: 'eno2' }] });

    expect(yaml).toBe(
      [
        'network:',
        '  ethernets:',
        '    all-interfaces:',
        '      match:',
        '        name: "*"',
        '      dhcp4: true',
        '      optional: true',
        '  version: 2',
        '',
      ].join('\n'),
    );
  });

  it('ignores wt0 and IPMI when deciding addressability — they are never eligible', () => {
    // Both carry IPs, but the template skips them, so the device still has
    // nothing to configure and takes the DHCP fallback.
    const yaml = render({
      interfaces: [
        { name: 'wt0', ips: ['10.0.0.5/24'] },
        { name: 'IPMI', ips: ['10.0.0.6/24'] },
      ],
      prefixes: [{ id: 'p1', cidr: '10.0.0.0/24', gatewayIp: '10.0.0.1' }],
    });

    expect(yaml).toContain('all-interfaces:');
  });

  it('renders a single addressed NIC: match/macaddress, static address, default route, DNS fallback', () => {
    const yaml = render({
      interfaces: [{ name: 'eno1', mac: 'e0:07:1b:f4:9c:18', ips: ['10.0.0.5/24'] }],
      prefixes: [{ id: 'p1', cidr: '10.0.0.0/24', gatewayIp: '10.0.0.1', roleSlug: 'primary' }],
    });

    // Unlike the bridge templates, flat matches on MAC and falls back to
    // 1.1.1.1 / 8.8.8.8 rather than 1.1.1.1 / 1.0.0.1.
    expect(yaml).toContain('    eno1:');
    expect(yaml).toContain('      match:');
    expect(yaml).toContain('        macaddress: e0:07:1b:f4:9c:18');
    expect(yaml).toContain('      addresses:');
    expect(yaml).toContain('        - 10.0.0.5/24');
    expect(yaml).toContain('          via: 10.0.0.1');
    expect(yaml).toContain('          - 1.1.1.1');
    expect(yaml).toContain('          - 8.8.8.8');
    expect(yaml.endsWith('  version: 2\n')).toBe(true);
    expect(yaml).not.toContain('renderer:');
  });

  it('emits per-interface mtu', () => {
    const yaml = render({
      interfaces: [{ name: 'eno1', mtu: 9000, ips: ['10.0.0.5/24'] }],
      prefixes: [{ id: 'p1', cidr: '10.0.0.0/24', gatewayIp: '10.0.0.1' }],
    });

    expect(yaml).toContain('      mtu: 9000');
  });

  it('leaves an unaddressed sibling NIC as an optional dhcp4: false stub', () => {
    const yaml = render({
      interfaces: [{ name: 'eno1', ips: ['10.0.0.5/24'] }, { name: 'eno2' }],
      prefixes: [{ id: 'p1', cidr: '10.0.0.0/24', gatewayIp: '10.0.0.1' }],
    });

    expect(yaml).toContain('    eno2:');
    expect(yaml).toContain('      optional: true');
  });

  describe('VLAN tagging follows the role slug', () => {
    const vlanFixture = (role: DeviceRole) => ({
      role,
      interfaces: [{ name: 'eno1', ips: ['10.0.0.5/24'] }],
      prefixes: [{ id: 'p1', cidr: '10.0.0.0/24', gatewayIp: '10.0.0.1', vlanVid: 100 }],
    });

    it('tags for a role outside NEVER_TAG_ROLES (Hypervisor → hypervisor)', () => {
      const yaml = render(vlanFixture(DeviceRole.Hypervisor));

      expect(yaml).toContain('  vlans:');
      expect(yaml).toContain('    eno1.100:');
      expect(yaml).toContain('      id: 100');
      expect(yaml).toContain('      link: eno1');
    });

    it('does not tag for Baremetal (marketplace-hosts is in NEVER_TAG_ROLES)', () => {
      expect(render(vlanFixture(DeviceRole.Baremetal))).not.toContain('vlans:');
    });

    it('does not tag for Server — it shares the marketplace-hosts slug', () => {
      // Regression guard: flat used to map Server to null. Null and marketplace-hosts both skip
      // tagging, which is what made the shared-mapper reconciliation behaviour-neutral.
      expect(render(vlanFixture(DeviceRole.Server))).not.toContain('vlans:');
    });

    it('does not tag when the device has no role at all', () => {
      expect(render({ ...vlanFixture(DeviceRole.Baremetal), role: null })).not.toContain('vlans:');
    });
  });

  it('bonds when a containing prefix carries bondParameters', () => {
    // The bond trigger is the prefix, not the interface count — a device with
    // several NICs and no bond-parameters prefix stays unbonded.
    const yaml = render({
      interfaces: [
        { name: 'ens1f0', mac: 'a0:88:c2:ef:5e:18', ips: ['10.0.0.5/24'] },
        { name: 'ens1f1', mac: 'a0:88:c2:ef:5e:19' },
      ],
      prefixes: [
        {
          id: 'p1',
          cidr: '10.0.0.0/24',
          gatewayIp: '10.0.0.1',
          bondParameters: { mode: '802.3ad', 'lacp-rate': 'fast' },
        },
      ],
    });

    expect(yaml).toContain('  bonds:');
    expect(yaml).toContain('        mode: 802.3ad');
  });

  it('does not bond several NICs when no prefix carries bondParameters', () => {
    const yaml = render({
      interfaces: [
        { name: 'ens1f0', ips: ['10.0.0.5/24'] },
        { name: 'ens1f1', ips: ['10.0.0.6/24'] },
      ],
      prefixes: [{ id: 'p1', cidr: '10.0.0.0/24', gatewayIp: '10.0.0.1' }],
    });

    expect(yaml).not.toContain('bonds:');
  });
});
