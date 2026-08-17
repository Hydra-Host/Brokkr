/** Golden tests for `vpc-roce`. Covers only what differs from `vpc-native` (shared render path,
 * tested in vpc.spec.ts): four-space offset, failed-device branch, east-west /31s, `set-name`. */
import {
  DeviceRole,
  InterfaceType,
  ServerLifecycleStatus,
  TagObjectType,
  ZoneEastWestNetworkType,
} from '@repo/database';
import { describe, expect, it } from 'vitest';
import type { DeviceContext } from '../../../device-context/device-context.types';
import type { NetplanPhase } from '../../netplan.service';
import { renderVpc } from '../vpc';

const CUST_VRF = 'cust-vrf';
/** Four spaces here, where vpc-native uses six. */
const O = ' '.repeat(4);

interface IfaceFixture {
  name: string;
  mac?: string | null;
  northSouth?: boolean;
  inBand?: boolean;
  eastWest?: boolean;
  cabled?: boolean;
  ips?: string[];
}

function buildContext(fix: {
  interfaces: IfaceFixture[];
  prefixes?: Array<{ id: string; cidr: string; gatewayIp?: string; roleSlug?: string }>;
  lifecycleStatus?: ServerLifecycleStatus;
  roceZone?: boolean;
}): DeviceContext {
  const tagAssignments: unknown[] = [];
  const vrfPrefixes = (fix.prefixes ?? []).map((p, idx) => ({
    id: p.id,
    prefix: p.cidr,
    vrfId: CUST_VRF,
    bondParameters: null,
    enableVlanTag: false,
    vlan: null,
    prefixRole: p.roleSlug ? { id: `r`, slug: p.roleSlug, name: p.roleSlug } : null,
    gateways: p.gatewayIp
      ? [
          {
            id: `gw${idx}`,
            vrfId: CUST_VRF,
            routingPriority: null,
            gatewayIp: { id: `gwip${idx}`, address: `${p.gatewayIp}/${p.cidr.split('/')[1]}`, routingPrefix: null },
          },
        ]
      : [],
  }));

  const cabledInterfaceIds: string[] = [];
  const interfaces = fix.interfaces.map((iface, idx) => {
    const id = `if${idx}`;
    for (const [flag, slug] of [
      [iface.northSouth, 'north-south'],
      [iface.inBand, 'in-band-management'],
      [iface.eastWest, 'east-west'],
    ] as const) {
      if (flag) tagAssignments.push({ objectType: TagObjectType.INTERFACE, objectId: id, tag: { slug } });
    }
    if (iface.cabled) cabledInterfaceIds.push(id);
    return {
      id,
      name: iface.name,
      type: InterfaceType.ETHERNET_100G,
      macAddress: iface.mac === undefined ? `AA:BB:CC:00:00:0${idx}` : iface.mac,
      enabled: true,
      markConnected: false,
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
      name: 'roce-host',
      role: DeviceRole.Server,
      supplierId: 'org-1',
      interfaces,
      server: { lifecycleStatus: fix.lifecycleStatus ?? ServerLifecycleStatus.PROVISIONED },
      zone: {
        networkType: 'VPC',
        eastWestNetworkType: fix.roceZone === false ? null : ZoneEastWestNetworkType.ROCE,
      },
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
    cabledInterfaceIds,
  } as unknown as DeviceContext;
}

const render = (fix: Parameters<typeof buildContext>[0], phase: NetplanPhase = 'deploy'): string =>
  renderVpc(buildContext(fix), phase, { offset: 4, roce: true });

describe('vpc-roce generator', () => {
  it('renders a failed device as DHCP on its in-band interface and nothing else', () => {
    const yaml = render({
      interfaces: [
        { name: 'eno1', inBand: true, ips: ['10.0.0.5/24'] },
        { name: 'eno2', ips: ['10.0.1.5/24'] },
      ],
      prefixes: [{ id: 'p1', cidr: '10.0.0.0/24', gatewayIp: '10.0.0.1', roleSlug: 'primary' }],
      lifecycleStatus: ServerLifecycleStatus.FAILED,
    });

    // The failed branch wraps the whole template — eno2 must not appear.
    expect(yaml).toBe(
      [
        'network:',
        `${O}  ethernets:`,
        `${O}    eno1:`,
        `${O}      match:`,
        `${O}        macaddress: aa:bb:cc:00:00:00`,
        `${O}      dhcp4: true`,
        `${O}      optional: false`,
        `${O}  version: 2`,
        '',
      ].join('\n'),
    );
  });

  it('falls back to the wildcard config for a failed device with no in-band interface', () => {
    const yaml = render({
      interfaces: [{ name: 'eno1', ips: ['10.0.0.5/24'] }],
      prefixes: [{ id: 'p1', cidr: '10.0.0.0/24' }],
      lifecycleStatus: ServerLifecycleStatus.FAILED,
    });

    expect(yaml).toContain(`${O}    all-interfaces:`);
    expect(yaml).toContain(`${O}      dhcp4: true`);
  });

  it('emits a cabled east-west interface with full CIDR addresses and set-name', () => {
    const yaml = render({
      interfaces: [{ name: 'ens1f0', eastWest: true, cabled: true, ips: ['10.255.0.1/31'] }],
      prefixes: [],
    });

    expect(yaml).toContain(
      [
        `${O}    ens1f0:`,
        `${O}      match:`,
        `${O}        macaddress: aa:bb:cc:00:00:00`,
        `${O}      set-name: ens1f0`,
        `${O}      dhcp4: false`,
        `${O}      addresses:`,
        // Full CIDR, not split into ip + mask like every other block.
        `${O}        - 10.255.0.1/31`,
      ].join('\n'),
    );
  });

  it('omits an east-west interface entirely when it is not cabled', () => {
    const yaml = render({
      interfaces: [
        { name: 'ens1f0', eastWest: true, cabled: false, ips: ['10.255.0.1/31'] },
        { name: 'eno1', ips: ['10.0.0.5/24'] },
      ],
      prefixes: [{ id: 'p1', cidr: '10.0.0.0/24', gatewayIp: '10.0.0.1', roleSlug: 'primary' }],
    });

    // Skipped, not defaulted to DHCP.
    expect(yaml).not.toContain('ens1f0');
    expect(yaml).toContain(`${O}    eno1:`);
  });

  it('omits east-west interfaces on an inventory host and during a discovery render', () => {
    const ew = { name: 'ens1f0', eastWest: true, cabled: true, ips: ['10.255.0.1/31'] };
    expect(render({ interfaces: [ew], prefixes: [], lifecycleStatus: ServerLifecycleStatus.INVENTORY })).not.toContain(
      'ens1f0',
    );
    expect(render({ interfaces: [ew], prefixes: [] }, 'live')).not.toContain('ens1f0');
  });

  it('keeps east-west interfaces in every other lifecycle state', () => {
    // The gate is an EXCLUSION (`not discovery and status != inventory`), not an allowlist:
    // dropping the /31 stanzas would silently remove fabric addressing from a live host.
    const ew = { name: 'ens1f0', eastWest: true, cabled: true, ips: ['10.255.0.1/31'] };
    for (const status of [
      ServerLifecycleStatus.PROVISIONED,
      ServerLifecycleStatus.PROVISIONING,
      ServerLifecycleStatus.DEPROVISIONING,
      ServerLifecycleStatus.OFFLINE,
    ]) {
      expect(render({ interfaces: [ew], prefixes: [], lifecycleStatus: status })).toContain(
        `${O}        - 10.255.0.1/31`,
      );
    }
  });

  it('ignores east-west tagging when the zone is not a RoCE fabric', () => {
    const yaml = render({
      interfaces: [{ name: 'ens1f0', eastWest: true, cabled: true, ips: ['10.0.0.5/24'] }],
      prefixes: [{ id: 'p1', cidr: '10.0.0.0/24', gatewayIp: '10.0.0.1', roleSlug: 'primary' }],
      roceZone: false,
    });

    // Not a RoCE zone, so it is just a normal configured interface.
    expect(yaml).toContain(`${O}    ens1f0:`);
    expect(yaml).toContain(`${O}        - 10.0.0.5/24`);
  });

  it('emits set-name on a configured interface but not on a north-south one', () => {
    const yaml = render({
      interfaces: [
        { name: 'aplain', ips: ['10.0.0.5/24'] },
        { name: 'zns', northSouth: true, ips: ['10.0.1.5/24'] },
      ],
      prefixes: [
        { id: 'p1', cidr: '10.0.0.0/24', gatewayIp: '10.0.0.1', roleSlug: 'primary' },
        { id: 'p2', cidr: '10.0.1.0/24', gatewayIp: '10.0.1.1', roleSlug: 'primary' },
      ],
    });

    // Four-space offset means the interface key sits at 8, match at 10, macaddress at 12.
    expect(yaml).toMatch(/ {8}aplain:\n {10}match:\n {12}macaddress: [\da-f:]+\n {10}set-name: aplain\n/);
    expect(yaml).toMatch(/ {8}zns:\n {10}match:\n {12}macaddress: [\da-f:]+\n {10}dhcp4: false\n/);
  });
});
