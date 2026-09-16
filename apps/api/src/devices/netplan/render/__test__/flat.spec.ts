/** Golden tests for `flat` (upstream NetBox `netplan.j2`, the largest population).
 * Expected YAML derived by hand from the template — these pin the emit shape. */
import { Logger } from '@nestjs/common';
import { DeviceRole, InterfaceType } from '@repo/database';
import { describe, expect, it, vi } from 'vitest';
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

function netplanStructure(yaml: string, offset = 0) {
  const base = offset + 2;
  const ethernets: string[] = [];
  const bondMembers: string[] = [];
  const vlanLinks: string[] = [];
  let section: string | null = null;
  let inBondInterfaces = false;
  for (const line of yaml.split('\n')) {
    const text = line.trim();
    if (text === '') continue;
    const indent = line.length - line.trimStart().length;
    if (indent === base) {
      section = text.replace(/:$/, '');
      inBondInterfaces = false;
    } else if (section === 'ethernets' && indent === base + 2 && text.endsWith(':')) {
      ethernets.push(text.slice(0, -1));
    } else if (section === 'bonds' && indent === base + 4) {
      inBondInterfaces = text === 'interfaces:';
    } else if (section === 'bonds' && inBondInterfaces && indent === base + 6 && text.startsWith('- ')) {
      bondMembers.push(text.slice(2));
    } else if (section === 'vlans' && text.startsWith('link: ')) {
      vlanLinks.push(text.slice('link: '.length));
    }
  }
  return { ethernets, bondMembers, vlanLinks };
}

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

  it('emits one ethernets entry per mac and warns about the duplicate', () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const yaml = render({
      interfaces: [
        { name: 'eno2', mac: 'E0:07:1B:F4:9C:18' },
        { name: 'eno1', mac: 'e0:07:1b:f4:9c:18', ips: ['10.0.0.5/24'] },
        { name: 'eno3', mac: 'e0:07:1b:f4:9c:19' },
      ],
      prefixes: [{ id: 'p1', cidr: '10.0.0.0/24', gatewayIp: '10.0.0.1', roleSlug: 'primary' }],
    });

    expect(yaml).toContain('    eno1:');
    expect(yaml).toContain('    eno3:');
    expect(yaml).not.toContain('    eno2:');
    expect(yaml.match(/macaddress: e0:07:1b:f4:9c:18/g)).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('eno2'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('device-1'));
    warn.mockRestore();
  });

  it('keeps the duplicate-mac interface that carries an address even when it sorts later by name', () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const yaml = render({
      interfaces: [
        { name: 'eno1', mac: 'e0:07:1b:f4:9c:18' },
        { name: 'eno2', mac: 'E0:07:1B:F4:9C:18', ips: ['10.0.0.5/24'] },
      ],
      prefixes: [{ id: 'p1', cidr: '10.0.0.0/24', gatewayIp: '10.0.0.1', roleSlug: 'primary' }],
    });

    expect(yaml).toContain('    eno2:');
    expect(yaml).toContain('        - 10.0.0.5/24');
    expect(yaml).not.toContain('    eno1:');
    expect(yaml.match(/macaddress: e0:07:1b:f4:9c:18/g)).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('eno1 (e0:07:1b:f4:9c:18 already on eno2)'));
    warn.mockRestore();
  });

  it('keeps a duplicate-mac bond member so every bond0 member has an ethernets entry', () => {
    const yaml = render({
      interfaces: [
        { name: 'ens1f0', mac: 'a0:88:c2:ef:5e:18', ips: ['10.0.0.5/24'] },
        { name: 'ens1f1', mac: 'A0:88:C2:EF:5E:18' },
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

    const { ethernets, bondMembers } = netplanStructure(yaml);

    expect(bondMembers).toEqual(['ens1f0', 'ens1f1']);
    expect(ethernets).toContain('ens1f0');
    expect(ethernets).toContain('ens1f1');
    expect(bondMembers.filter((m) => !ethernets.includes(m))).toEqual([]);
  });

  it('keeps a duplicate-mac vlan parent so every vlan link resolves', () => {
    const yaml = render({
      role: DeviceRole.Hypervisor,
      interfaces: [
        { name: 'eno1', mac: 'e0:07:1b:f4:9c:18', ips: ['10.0.0.5/24'] },
        { name: 'eno2', mac: 'E0:07:1B:F4:9C:18', ips: ['10.0.100.5/24'] },
      ],
      prefixes: [
        { id: 'p1', cidr: '10.0.0.0/24', gatewayIp: '10.0.0.1', roleSlug: 'primary' },
        { id: 'p2', cidr: '10.0.100.0/24', gatewayIp: '10.0.100.1', vlanVid: 100, roleSlug: 'primary' },
      ],
    });

    const { ethernets, vlanLinks } = netplanStructure(yaml);

    expect(vlanLinks).toEqual(['eno2']);
    expect(ethernets).toContain('eno2');
    expect(vlanLinks.filter((l) => !ethernets.includes(l))).toEqual([]);
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
