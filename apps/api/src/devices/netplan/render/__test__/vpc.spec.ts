/** Golden tests for `vpc-native` (upstream `netplan-vpc-trinity.j2`), six-space base offset.
 * Emit assembly only — resolution/metrics in vpc-planner.spec.ts, lifecycle in vpc-lifecycle.spec.ts. */
import { DeviceRole, InterfaceType, ServerLifecycleStatus, TagObjectType } from '@repo/database';
import { describe, expect, it } from 'vitest';
import type { DeviceContext } from '../../../device-context/device-context.types';
import type { NetplanPhase } from '../../netplan.service';
import { renderVpc } from '../vpc';

const CUST_VRF = 'cust-vrf';
const O = ' '.repeat(6);

interface IfaceFixture {
  name: string;
  type?: InterfaceType;
  enabled?: boolean;
  markConnected?: boolean;
  mac?: string | null;
  northSouth?: boolean;
  inBand?: boolean;
  ips?: string[];
}

interface PrefixFixture {
  id: string;
  cidr: string;
  gatewayIp?: string;
  gatewayRoutingPriority?: number;
  vlanVid?: number;
  roleSlug?: string;
  bondParameters?: Record<string, unknown>;
}

function buildContext(fix: {
  interfaces: IfaceFixture[];
  prefixes?: PrefixFixture[];
  role?: DeviceRole;
  lifecycleStatus?: ServerLifecycleStatus;
}): DeviceContext {
  const tagAssignments: unknown[] = [];
  const vrfPrefixes = (fix.prefixes ?? []).map((p, idx) => ({
    id: p.id,
    prefix: p.cidr,
    vrfId: CUST_VRF,
    bondParameters: p.bondParameters ?? null,
    enableVlanTag: false,
    vlan: p.vlanVid ? { id: `v${p.vlanVid}`, vid: p.vlanVid, name: `vlan${p.vlanVid}` } : null,
    prefixRole: p.roleSlug ? { id: `r-${p.roleSlug}`, slug: p.roleSlug, name: p.roleSlug } : null,
    gateways: p.gatewayIp
      ? [
          {
            id: `gw${idx}`,
            vrfId: CUST_VRF,
            routingPriority: p.gatewayRoutingPriority ?? null,
            gatewayIp: { id: `gwip${idx}`, address: `${p.gatewayIp}/${p.cidr.split('/')[1]}`, routingPrefix: null },
          },
        ]
      : [],
  }));

  const interfaces = fix.interfaces.map((iface, idx) => {
    if (iface.northSouth) {
      tagAssignments.push({ objectType: TagObjectType.INTERFACE, objectId: `if${idx}`, tag: { slug: 'north-south' } });
    }
    if (iface.inBand) {
      tagAssignments.push({
        objectType: TagObjectType.INTERFACE,
        objectId: `if${idx}`,
        tag: { slug: 'in-band-management' },
      });
    }
    return {
      id: `if${idx}`,
      name: iface.name,
      type: iface.type ?? InterfaceType.ETHERNET_10G,
      macAddress: iface.mac === undefined ? `AA:BB:CC:00:00:0${idx}` : iface.mac,
      enabled: iface.enabled ?? true,
      markConnected: iface.markConnected ?? false,
      mtu: null,
      untaggedVlan: null,
      lag: null,
      parent: null,
      ipAddresses: (iface.ips ?? []).map((address, i) => ({
        id: `ip${idx}-${i}`,
        address,
        routingPrefix: null,
        vrfId: CUST_VRF,
        vrf: { id: CUST_VRF, name: 'cust' },
      })),
    };
  });

  return {
    device: {
      id: 'd1',
      name: 'vpc-host',
      role: fix.role ?? DeviceRole.Server,
      supplierId: 'org-1',
      interfaces,
      ...(fix.lifecycleStatus ? { server: { lifecycleStatus: fix.lifecycleStatus } } : {}),
    },
    ipam: {
      prefixes: [],
      gateways: [],
      vlans: [],
      vrfs: [],
      l3RouteIps: [],
      bridgeDeviceIps: [],
      vrfPrefixes,
    },
    tagAssignments,
    prefixByIpId: {},
    cabledInterfaceIds: [],
  } as unknown as DeviceContext;
}

const render = (fix: Parameters<typeof buildContext>[0], phase: NetplanPhase = 'deploy'): string =>
  renderVpc(buildContext(fix), phase, { offset: 6, roce: false });

describe('vpc-native generator', () => {
  it('renders a plain configured interface at the six-space offset', () => {
    const yaml = render({
      interfaces: [{ name: 'eno1', ips: ['10.0.0.5/24'] }],
      prefixes: [{ id: 'p1', cidr: '10.0.0.0/24', gatewayIp: '10.0.0.1', roleSlug: 'primary' }],
    });

    expect(yaml).toBe(
      [
        'network:',
        `${O}  ethernets:`,
        `${O}    eno1:`,
        `${O}      match:`,
        `${O}        macaddress: aa:bb:cc:00:00:00`,
        `${O}      dhcp4: false`,
        `${O}      addresses:`,
        `${O}        - 10.0.0.5/24`,
        `${O}      routes:`,
        `${O}        - to: 0.0.0.0/0`,
        `${O}          via: 10.0.0.1`,
        `${O}          metric: 100`,
        // 8.8.8.8 on ethernets — the VLAN block uses 1.0.0.1 instead.
        `${O}      nameservers:`,
        `${O}        addresses:`,
        `${O}          - 1.1.1.1`,
        `${O}          - 8.8.8.8`,
        `${O}      optional: false`,
        `${O}  version: 2`,
        '',
      ].join('\n'),
    );
  });

  it('emits the wildcard DHCP fallback when nothing resolves, at the same offset', () => {
    const yaml = render({ interfaces: [{ name: 'eno1' }], prefixes: [] });
    expect(yaml).toBe(
      [
        'network:',
        `${O}  ethernets:`,
        `${O}    all-interfaces:`,
        `${O}      match:`,
        `${O}        name: "*"`,
        `${O}      dhcp4: true`,
        `${O}      optional: true`,
        `${O}  version: 2`,
        '',
      ].join('\n'),
    );
  });

  it('bonds two north-south interfaces and uses the 50 metric, macaddress after nameservers', () => {
    const yaml = render({
      interfaces: [
        { name: 'eno1', northSouth: true, ips: ['10.0.0.5/24'] },
        { name: 'eno2', northSouth: true, ips: ['10.0.0.6/24'] },
      ],
      prefixes: [{ id: 'p1', cidr: '10.0.0.0/24', gatewayIp: '10.0.0.1', roleSlug: 'primary' }],
    });

    expect(yaml).toContain(`${O}  bonds:`);
    expect(yaml).toContain(`${O}        - eno1`);
    expect(yaml).toContain(`${O}        - eno2`);
    // macaddress AFTER nameservers, and NOT lowercased.
    expect(yaml).toMatch(/ {16}- 8\.8\.8\.8\n {12}macaddress: AA:BB:CC:00:00:00\n/);
    expect(yaml).toContain(`${O}          metric: 50`);
  });

  it('uses metric 300 on the north-south bond when deprovisioning', () => {
    const yaml = render({
      interfaces: [
        { name: 'eno1', northSouth: true, ips: ['10.0.0.5/24'] },
        { name: 'eno2', northSouth: true, ips: ['10.0.0.6/24'] },
      ],
      prefixes: [{ id: 'p1', cidr: '10.0.0.0/24', gatewayIp: '10.0.0.1', roleSlug: 'primary' }],
      lifecycleStatus: ServerLifecycleStatus.DEPROVISIONING,
    });

    expect(yaml).toContain(`${O}          metric: 300`);
    expect(yaml).not.toContain('metric: 50');
  });

  it('never bonds during a live/discovery render, and skips north-south config there', () => {
    const yaml = render(
      {
        interfaces: [
          { name: 'eno1', northSouth: true, ips: ['10.0.0.5/24'] },
          { name: 'eno2', northSouth: true, ips: ['10.0.0.6/24'] },
        ],
        prefixes: [{ id: 'p1', cidr: '10.0.0.0/24', gatewayIp: '10.0.0.1', roleSlug: 'primary' }],
      },
      'live',
    );

    // is_brokkr_discovery gates both bonding and north-south addressing, so with
    // only north-south interfaces there is nothing left to configure.
    expect(yaml).not.toContain('bonds:');
    expect(yaml).toContain('all-interfaces:');
  });

  it('dedupes default routes by gateway', () => {
    const yaml = render({
      interfaces: [{ name: 'eno1', ips: ['10.0.0.5/24', '10.0.0.6/24'] }],
      prefixes: [{ id: 'p1', cidr: '10.0.0.0/24', gatewayIp: '10.0.0.1', roleSlug: 'primary' }],
    });

    // Two addresses, one shared gateway -> ONE default route.
    expect(yaml).toContain(`${O}        - 10.0.0.5/24`);
    expect(yaml).toContain(`${O}        - 10.0.0.6/24`);
    expect(yaml.match(/- to: 0\.0\.0\.0\/0/g)).toHaveLength(1);
  });

  it('adds the in-band fallback route to 10.0.0.0/8 at metric 100', () => {
    const yaml = render({
      interfaces: [{ name: 'eno1', inBand: true, ips: ['10.0.0.5/24'] }],
      prefixes: [{ id: 'p1', cidr: '10.0.0.0/24', gatewayIp: '10.0.0.1', roleSlug: 'primary' }],
    });

    expect(yaml).toContain(`${O}        - to: 10.0.0.0/8`);
    expect(yaml).toContain(`${O}          via: 10.0.0.1`);
  });

  it('omits the metric on an in-band interface while deprovisioning', () => {
    const yaml = render({
      interfaces: [{ name: 'eno1', inBand: true, ips: ['10.0.0.5/24'] }],
      prefixes: [{ id: 'p1', cidr: '10.0.0.0/24', gatewayIp: '10.0.0.1', roleSlug: 'primary' }],
      lifecycleStatus: ServerLifecycleStatus.DEPROVISIONING,
    });

    // The default route is present with no metric line; the 10.0.0.0/8 fallback
    // still carries its own 100.
    expect(yaml).toMatch(/ {14}- to: 0\.0\.0\.0\/0\n {16}via: 10\.0\.0\.1\n {14}- to: 10\.0\.0\.0\/8/);
  });

  it('falls back to 1.0.0.1 for VLAN nameservers, not 8.8.8.8', () => {
    const yaml = render({
      // Hypervisor tags VLANs by role, unlike marketplace-hosts.
      role: DeviceRole.Hypervisor,
      interfaces: [{ name: 'eno1', ips: ['10.0.100.5/24'] }],
      prefixes: [{ id: 'p1', cidr: '10.0.100.0/24', gatewayIp: '10.0.100.1', vlanVid: 100, roleSlug: 'primary' }],
    });

    expect(yaml).toContain(`${O}  vlans:`);
    expect(yaml).toContain(`${O}    eno1.100:`);
    expect(yaml).toMatch(/ {8}vlans:[\s\S]*\n {16}- 1\.1\.1\.1\n {16}- 1\.0\.0\.1/);
  });
});
