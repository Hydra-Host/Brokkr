import { Test, TestingModule } from '@nestjs/testing';
import { DeviceRole, InterfaceType, ZoneNetworkType } from '@repo/database';
import { load } from 'js-yaml';
import { ContextService } from 'src/common/context/context.service';
import { PrismaClient } from 'src/prisma/prisma.client';
import { Mock, vi } from 'vitest';
import { z } from 'zod';
import { DeviceContextBuilder } from '../../device-context/device-context.builder';
import type { DeviceContext } from '../../device-context/device-context.types';
import * as netplanConsolidated from '../netplan-consolidated';
import { pickGateway } from '../netplan-planner';
import { NetplanService } from '../netplan.service';

const CALLER_ORG_ID = 'org-caller-1';

interface IfaceFixture {
  name: string;
  macAddress: string;
  type?: InterfaceType;
  enabled?: boolean;
  markConnected?: boolean;
  mtu?: number | null;
  ips?: IpFixture[];
}

interface IpFixture {
  address: string;
  prefixId?: string;
  vrfId?: string | null;
}

interface L3RouteFixture {
  containingPrefixId: string;
  routingPrefix: string;
  address: string;
}

interface PrefixFixture {
  id: string;
  cidr: string;
  gatewayIp?: string;
  gatewayRoutingPriority?: number;
  gatewayVrfId?: string | null;
  vrfId?: string | null;
  vlanVid?: number;
  vlanName?: string;
  enableVlanTag?: boolean;
  bondParameters?: Record<string, unknown> | null;
  roleSlug?: string;
}

interface ContextFixture {
  deviceName?: string;
  role?: DeviceRole | null;
  netplanOverride?: string | null;
  interfaces: IfaceFixture[];
  prefixes?: PrefixFixture[];
  l3RouteIps?: L3RouteFixture[];
  vrfName?: string;
  zoneNetworkType?: ZoneNetworkType;
}

function buildContext(fix: ContextFixture): DeviceContext {
  const vrfs = [
    {
      id: 'vrf-1',
      name: fix.vrfName ?? 'zone-vrf',
      organizationId: 'org-1',
    },
    {
      id: 'vrf-2',
      name: 'tenant-vpc-vrf',
      organizationId: 'org-1',
    },
  ] as unknown as DeviceContext['ipam']['vrfs'];
  const defaultVrf = vrfs[0];
  const vrfById = new Map(vrfs.map((vrf) => [vrf.id, vrf]));

  const prefixes = (fix.prefixes ?? []).map((p, idx) => {
    const prefixVrfId = p.vrfId === undefined ? defaultVrf.id : p.vrfId;
    const gatewayVrfId = p.gatewayVrfId === undefined ? prefixVrfId : p.gatewayVrfId;
    const gateway = p.gatewayIp
      ? [
          {
            id: `gw-${idx}`,
            vrfId: gatewayVrfId,
            routingPriority: p.gatewayRoutingPriority ?? null,
            gatewayIp: {
              id: `gw-ip-${idx}`,
              address: `${p.gatewayIp}/${p.cidr.split('/')[1]}`,
              routingPrefix: null,
            },
            vrf: gatewayVrfId ? (vrfById.get(gatewayVrfId) ?? null) : null,
          },
        ]
      : [];
    return {
      id: p.id,
      prefix: p.cidr,
      organizationId: 'org-1',
      bondParameters: p.bondParameters ?? null,
      enableVlanTag: p.enableVlanTag ?? false,
      vlan: p.vlanVid ? { id: `vlan-${p.vlanVid}`, vid: p.vlanVid, name: p.vlanName ?? `vlan${p.vlanVid}` } : null,
      prefixRole: p.roleSlug ? { id: `role-${p.roleSlug}`, slug: p.roleSlug, name: p.roleSlug } : null,
      gateways: gateway,
      vrf: prefixVrfId ? (vrfById.get(prefixVrfId) ?? null) : null,
      vrfId: prefixVrfId,
    } as unknown as DeviceContext['ipam']['prefixes'][number];
  });

  const interfaces = fix.interfaces.map((iface, idx) => ({
    id: `iface-${idx}`,
    name: iface.name,
    type: iface.type ?? InterfaceType.ETHERNET_1G,
    macAddress: iface.macAddress,
    enabled: iface.enabled ?? true,
    markConnected: iface.markConnected ?? false,
    mtu: iface.mtu ?? null,
    untaggedVlan: null,
    lag: null,
    parent: null,
    ipAddresses: (iface.ips ?? []).map((ip, ipIdx) => {
      const vrfId = ip.vrfId === undefined ? defaultVrf.id : ip.vrfId;
      return {
        id: `ip-${idx}-${ipIdx}`,
        address: ip.address,
        routingPrefix: null,
        vrfId,
        vrf: vrfId ? (vrfById.get(vrfId) ?? null) : null,
      };
    }),
  }));

  const device = {
    id: 'device-1',
    name: fix.deviceName ?? 'dev1',
    role: fix.role ?? DeviceRole.Baremetal,
    supplierId: 'org-1',
    zone: fix.zoneNetworkType ? { id: 'zone-1', networkType: fix.zoneNetworkType } : null,
    netplanOverride: fix.netplanOverride ?? null,
    ...(fix.netplanOverride != null ? { server: { netplanOverride: fix.netplanOverride, deployments: [] } } : {}),
    interfaces,
  } as unknown as DeviceContext['device'];

  return {
    device,
    ipam: {
      prefixes,
      gateways: [],
      vlans: [],
      vrfs,
      l3RouteIps: (fix.l3RouteIps ?? []).map((r, i) => ({
        id: `l3-${i}`,
        address: r.address,
        routingPrefix: r.routingPrefix,
        containingPrefixId: r.containingPrefixId,
      })) as unknown as DeviceContext['ipam']['l3RouteIps'],
      bridgeDeviceIps: [],
      vrfPrefixes: [],
    },
    tagAssignments: [],
    cabledInterfaceIds: [],
    prefixByIpId: {},
  };
}

describe('NetplanService', () => {
  let service: NetplanService;
  let mockBuild: Mock;
  let mockDeviceFindUnique: Mock;

  beforeEach(async () => {
    mockBuild = vi.fn();
    mockDeviceFindUnique = vi.fn();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NetplanService,
        {
          provide: DeviceContextBuilder,
          useValue: { build: mockBuild },
        },
        {
          provide: ContextService,
          useValue: { organizationId: CALLER_ORG_ID },
        },
        {
          provide: PrismaClient,
          useValue: { device: { findUnique: mockDeviceFindUnique } },
        },
        {
          provide: `LoggerService${NetplanService.name}`,
          useValue: {
            log: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
            debug: vi.fn(),
            verbose: vi.fn(),
            setContext: vi.fn().mockReturnThis(),
          },
        },
      ],
    }).compile();
    service = module.get(NetplanService);
  });

  it('returns the verbatim override when set', async () => {
    mockBuild.mockResolvedValue(
      buildContext({
        netplanOverride: 'network:\n  bonds:\n    bond0:\n      interfaces: [eth0]\n',
        interfaces: [{ name: 'eth0', macAddress: 'aa:bb:cc:dd:ee:ff' }],
      }),
    );
    const yaml = await service.renderForDevice('device-1');
    expect(yaml).toBe('network:\n  bonds:\n    bond0:\n      interfaces: [eth0]\n');
  });

  it('returns 422 when the renderer produces empty YAML', async () => {
    const renderSpy = vi.spyOn(netplanConsolidated, 'renderNetplanYaml').mockReturnValueOnce('   ');
    mockBuild.mockResolvedValue(
      buildContext({
        interfaces: [{ name: 'eno1', macAddress: 'aa:bb:cc:00:00:01' }],
      }),
    );

    await expect(service.renderForDevice('device-1')).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining('Unable to render live netplan'),
    });
    renderSpy.mockRestore();
  });

  it('emits the wildcard DHCP fallback when no eligible interface has IPs', async () => {
    mockBuild.mockResolvedValue(
      buildContext({
        interfaces: [
          { name: 'eno1', macAddress: 'aa:bb:cc:00:00:01' },
          { name: 'IPMI', macAddress: 'aa:bb:cc:00:00:02' },
        ],
      }),
    );
    const yaml = await service.renderForDevice('device-1');
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

  it('falls back to DHCP when a vrf-less device only has gateways inside a vrf', async () => {
    mockBuild.mockResolvedValue(
      buildContext({
        interfaces: [
          { name: 'eth0', macAddress: 'aa:bb:cc:00:00:03', ips: [{ address: '192.168.200.14/24', vrfId: null }] },
        ],
        prefixes: [
          { id: 'p1', cidr: '192.168.200.0/24', gatewayIp: '192.168.200.1', vrfId: null, gatewayVrfId: 'vrf-1' },
        ],
      }),
    );
    const yaml = await service.renderForDevice('device-1');
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

  it('falls back to DHCP when an IP and its gateway have different vrfs', async () => {
    mockBuild.mockResolvedValue(
      buildContext({
        interfaces: [
          {
            name: 'eth0',
            macAddress: 'aa:bb:cc:00:00:03',
            ips: [{ address: '192.168.200.14/24', vrfId: 'vrf-1' }],
          },
        ],
        prefixes: [
          {
            id: 'p1',
            cidr: '192.168.200.0/24',
            gatewayIp: '192.168.200.1',
            vrfId: 'vrf-1',
            gatewayVrfId: 'vrf-2',
          },
        ],
      }),
    );

    const yaml = await service.renderForDevice('device-1');
    expect(yaml).toContain('dhcp4: true');
    expect(yaml).not.toContain('via: 192.168.200.1');
  });

  it('falls back to DHCP when a vrf IP only matches a global prefix', async () => {
    mockBuild.mockResolvedValue(
      buildContext({
        interfaces: [
          {
            name: 'eth0',
            macAddress: 'aa:bb:cc:00:00:03',
            ips: [{ address: '192.168.200.14/24', vrfId: 'vrf-1' }],
          },
        ],
        prefixes: [{ id: 'p1', cidr: '192.168.200.0/24', gatewayIp: '192.168.200.1', vrfId: null }],
      }),
    );

    const yaml = await service.renderForDevice('device-1');
    expect(yaml).toContain('dhcp4: true');
    expect(yaml).not.toContain('192.168.200.14/24');
  });

  it('selects a gateway for each IP vrfId', async () => {
    mockBuild.mockResolvedValue(
      buildContext({
        interfaces: [
          {
            name: 'eth0',
            macAddress: 'aa:bb:cc:00:00:03',
            ips: [{ address: '192.168.100.14/24', vrfId: 'vrf-1' }],
          },
          {
            name: 'eth1',
            macAddress: 'aa:bb:cc:00:00:04',
            ips: [{ address: '192.168.200.14/24', vrfId: 'vrf-2' }],
          },
        ],
        prefixes: [
          { id: 'p1', cidr: '192.168.100.0/24', gatewayIp: '192.168.100.1', vrfId: 'vrf-1' },
          { id: 'p2', cidr: '192.168.200.0/24', gatewayIp: '192.168.200.1', vrfId: 'vrf-2' },
        ],
      }),
    );

    const yaml = await service.renderForDevice('device-1');
    const netplan = z
      .object({
        network: z.object({
          ethernets: z.record(
            z.object({
              addresses: z.array(z.string()),
              routes: z.array(z.object({ to: z.string(), via: z.string(), metric: z.number() })),
            }),
          ),
        }),
      })
      .parse(load(yaml));

    expect(netplan.network.ethernets.eth0?.addresses).toEqual(['192.168.100.14/24']);
    expect(netplan.network.ethernets.eth0?.routes).toEqual([{ to: '0.0.0.0/0', via: '192.168.100.1', metric: 100 }]);
    expect(netplan.network.ethernets.eth1?.addresses).toEqual(['192.168.200.14/24']);
    expect(netplan.network.ethernets.eth1?.routes).toEqual([{ to: '0.0.0.0/0', via: '192.168.200.1', metric: 101 }]);
  });

  it('uses Prefix.vrfId when the IP vrfId is null', async () => {
    mockBuild.mockResolvedValue(
      buildContext({
        interfaces: [
          { name: 'eth0', macAddress: 'aa:bb:cc:00:00:03', ips: [{ address: '192.168.200.14/24', vrfId: null }] },
        ],
        prefixes: [{ id: 'p1', cidr: '192.168.200.0/24', gatewayIp: '192.168.200.1', vrfId: 'vrf-2' }],
      }),
    );

    const yaml = await service.renderForDevice('device-1');
    expect(yaml).not.toContain('dhcp4: true');
    expect(yaml).toContain('via: 192.168.200.1');
  });

  it('uses the most-specific prefix before selecting a gateway for a vrf-less IP', async () => {
    mockBuild.mockResolvedValue(
      buildContext({
        interfaces: [
          { name: 'eth0', macAddress: 'aa:bb:cc:00:00:03', ips: [{ address: '192.168.200.14/24', vrfId: null }] },
        ],
        prefixes: [
          { id: 'p1', cidr: '192.168.0.0/16', gatewayIp: '192.168.0.1', vrfId: 'vrf-2' },
          { id: 'p2', cidr: '192.168.200.0/24', gatewayIp: '192.168.200.1', vrfId: null },
        ],
      }),
    );

    const yaml = await service.renderForDevice('device-1');
    expect(yaml).toContain('via: 192.168.200.1');
    expect(yaml).not.toContain('via: 192.168.0.1');
  });

  it('uses a global prefix when equal-length prefixes from other vrfs also match', async () => {
    mockBuild.mockResolvedValue(
      buildContext({
        interfaces: [
          { name: 'eth0', macAddress: 'aa:bb:cc:00:00:03', ips: [{ address: '192.168.200.14/24', vrfId: null }] },
        ],
        prefixes: [
          { id: 'p1', cidr: '192.168.200.0/24', gatewayIp: '192.168.200.2', vrfId: 'vrf-2' },
          { id: 'p2', cidr: '192.168.200.0/24', gatewayIp: '192.168.200.1', vrfId: null },
        ],
      }),
    );

    const yaml = await service.renderForDevice('device-1');
    expect(yaml).toContain('via: 192.168.200.1');
    expect(yaml).not.toContain('via: 192.168.200.2');
  });

  it('falls back to DHCP for equal-length prefix matches across multiple vrfs', async () => {
    mockBuild.mockResolvedValue(
      buildContext({
        interfaces: [
          { name: 'eth0', macAddress: 'aa:bb:cc:00:00:03', ips: [{ address: '192.168.200.14/24', vrfId: null }] },
        ],
        prefixes: [
          { id: 'p1', cidr: '192.168.200.0/24', gatewayIp: '192.168.200.1', vrfId: 'vrf-1' },
          { id: 'p2', cidr: '192.168.200.0/24', gatewayIp: '192.168.200.2', vrfId: 'vrf-2' },
        ],
      }),
    );

    const yaml = await service.renderForDevice('device-1');
    expect(yaml).toContain('dhcp4: true');
  });

  // Dropped with the cutover: asserted flat-family resolution for a VPC-zone device, which now
  // dispatches to the VPC family. Covered by render/__test__/vpc*.spec.ts.

  it('resolves a default route from a global-table gateway when the device IPs have no vrf', async () => {
    mockBuild.mockResolvedValue(
      buildContext({
        interfaces: [
          { name: 'eth0', macAddress: 'aa:bb:cc:00:00:03', ips: [{ address: '192.168.200.14/24', vrfId: null }] },
        ],
        prefixes: [{ id: 'p1', cidr: '192.168.200.0/24', gatewayIp: '192.168.200.1', vrfId: null }],
      }),
    );
    const yaml = await service.renderForDevice('device-1');
    expect(yaml).not.toContain('dhcp4: true');
    expect(yaml).toContain('192.168.200.14/24');
    expect(yaml).toContain('via: 192.168.200.1');
  });

  it('applies the most-specific gateway-bearing prefix when parent and child both carry gateways', async () => {
    mockBuild.mockResolvedValue(
      buildContext({
        interfaces: [{ name: 'eth0', macAddress: 'aa:bb:cc:00:00:03', ips: [{ address: '10.9.5.7/24' }] }],
        prefixes: [
          { id: 'parent', cidr: '10.9.0.0/16', gatewayIp: '10.9.0.1' },
          { id: 'child', cidr: '10.9.5.0/24', gatewayIp: '10.9.5.1' },
        ],
      }),
    );
    const yaml = await service.renderForDevice('device-1');
    expect(yaml).toContain('via: 10.9.5.1');
    expect(yaml).not.toContain('via: 10.9.0.1');
    expect(yaml).toContain('10.9.5.7/24');
  });

  it('does not give a vrf-assigned device a global-table gateway (vrf isolation)', async () => {
    mockBuild.mockResolvedValue(
      buildContext({
        interfaces: [{ name: 'eth0', macAddress: 'aa:bb:cc:00:00:03', ips: [{ address: '192.168.200.14/24' }] }],
        prefixes: [{ id: 'p1', cidr: '192.168.200.0/24', gatewayIp: '192.168.200.1', gatewayVrfId: null }],
      }),
    );
    const yaml = await service.renderForDevice('device-1');
    expect(yaml).toContain('dhcp4: true');
  });

  it('renders a static config (not DHCP) when the only route is a synthesized L3 static route', async () => {
    mockBuild.mockResolvedValue(
      buildContext({
        interfaces: [{ name: 'eth0', macAddress: 'aa:bb:cc:00:00:04', ips: [{ address: '192.168.200.14/24' }] }],
        prefixes: [{ id: 'p1', cidr: '192.168.200.0/24' }],
        l3RouteIps: [{ containingPrefixId: 'p1', routingPrefix: '10.0.0.0/8', address: '192.168.200.254' }],
      }),
    );
    const yaml = await service.renderForDevice('device-1');
    expect(yaml).not.toContain('dhcp4: true');
    expect(yaml).toContain('192.168.200.14/24');
    expect(yaml).toContain('10.0.0.0/8');
  });

  it('matches the NetBox Jinja output for the dev device-956 shape', async () => {
    mockBuild.mockResolvedValue(
      buildContext({
        role: DeviceRole.Baremetal,
        interfaces: [
          { name: 'eno1', macAddress: '7c:c2:55:e0:b7:04' },
          {
            name: 'eno2',
            macAddress: '7c:c2:55:e0:b7:05',
            ips: [{ address: '172.16.28.6/22' }],
          },
          { name: 'eno3', macAddress: '7c:c2:55:e0:b7:06' },
          { name: 'eno4', macAddress: '7c:c2:55:e0:b7:07' },
          { name: 'eno5', macAddress: '7c:c2:55:e0:b7:08' },
          { name: 'eno6', macAddress: '7c:c2:55:e0:b7:09' },
          {
            name: 'eno7',
            macAddress: '7c:c2:55:e0:b8:6a',
            ips: [{ address: '172.16.12.6/22' }],
          },
          { name: 'eno8', macAddress: '7c:c2:55:e0:b8:6b' },
        ],
        prefixes: [
          { id: 'pfx-mgmt', cidr: '172.16.28.0/22' },
          {
            id: 'pfx-data',
            cidr: '172.16.12.0/22',
            gatewayIp: '172.16.12.1',
          },
        ],
      }),
    );

    const yaml = await service.renderForDevice('device-1');
    expect(yaml).toBe(
      [
        'network:',
        '  ethernets:',
        '    eno1:',
        '      match:',
        '        macaddress: 7c:c2:55:e0:b7:04',
        '      dhcp4: false',
        '      optional: true',
        '    eno2:',
        '      match:',
        '        macaddress: 7c:c2:55:e0:b7:05',
        '      dhcp4: false',
        '      addresses:',
        '        - 172.16.28.6/22',
        '      nameservers:',
        '        addresses:',
        '          - 1.1.1.1',
        '          - 8.8.8.8',
        '      optional: false',
        '    eno3:',
        '      match:',
        '        macaddress: 7c:c2:55:e0:b7:06',
        '      dhcp4: false',
        '      optional: true',
        '    eno4:',
        '      match:',
        '        macaddress: 7c:c2:55:e0:b7:07',
        '      dhcp4: false',
        '      optional: true',
        '    eno5:',
        '      match:',
        '        macaddress: 7c:c2:55:e0:b7:08',
        '      dhcp4: false',
        '      optional: true',
        '    eno6:',
        '      match:',
        '        macaddress: 7c:c2:55:e0:b7:09',
        '      dhcp4: false',
        '      optional: true',
        '    eno7:',
        '      match:',
        '        macaddress: 7c:c2:55:e0:b8:6a',
        '      dhcp4: false',
        '      addresses:',
        '        - 172.16.12.6/22',
        '      routes:',
        '        - to: 0.0.0.0/0',
        '          via: 172.16.12.1',
        '          metric: 100',
        '      nameservers:',
        '        addresses:',
        '          - 1.1.1.1',
        '          - 8.8.8.8',
        '      optional: false',
        '    eno8:',
        '      match:',
        '        macaddress: 7c:c2:55:e0:b8:6b',
        '      dhcp4: false',
        '      optional: true',
        '  version: 2',
        '',
      ].join('\n'),
    );
  });

  it('tags VLAN sub-interfaces for non-excluded roles when prefix has a VLAN', async () => {
    mockBuild.mockResolvedValue(
      buildContext({
        role: DeviceRole.Hypervisor,
        interfaces: [
          {
            name: 'enp1s0',
            macAddress: 'aa:bb:cc:00:00:01',
            ips: [{ address: '10.0.5.10/24' }],
          },
        ],
        prefixes: [
          {
            id: 'pfx-vlan100',
            cidr: '10.0.5.0/24',
            gatewayIp: '10.0.5.1',
            vlanVid: 100,
            vlanName: 'mgmt',
            roleSlug: 'primary',
          },
        ],
      }),
    );

    const yaml = await service.renderForDevice('device-1', 'deploy');
    expect(yaml).toContain('  vlans:');
    expect(yaml).toContain('    enp1s0.100:');
    expect(yaml).toContain('      id: 100');
    expect(yaml).toContain('      link: enp1s0');
    expect(yaml).toContain('        - 10.0.5.10/24');
    expect(yaml).toContain('          via: 10.0.5.1');
    expect(yaml).toMatch(
      /enp1s0:\n {6}match:\n {8}macaddress: aa:bb:cc:00:00:01\n {6}dhcp4: false\n {6}optional: false/,
    );
    expect(yaml).toContain('          - 1.0.0.1');
  });

  it('does not tag VLAN for marketplace-hosts role even when prefix has a VLAN', async () => {
    mockBuild.mockResolvedValue(
      buildContext({
        role: DeviceRole.Baremetal,
        interfaces: [
          {
            name: 'enp1s0',
            macAddress: 'aa:bb:cc:00:00:01',
            ips: [{ address: '10.0.5.10/24' }],
          },
        ],
        prefixes: [
          {
            id: 'pfx-vlan',
            cidr: '10.0.5.0/24',
            gatewayIp: '10.0.5.1',
            vlanVid: 100,
            vlanName: 'mgmt',
          },
        ],
      }),
    );

    const yaml = await service.renderForDevice('device-1');
    expect(yaml).not.toContain('vlans:');
    expect(yaml).toContain('        - 10.0.5.10/24');
  });

  it('tags VLAN when prefix.enableVlanTag is true, regardless of role', async () => {
    mockBuild.mockResolvedValue(
      buildContext({
        role: DeviceRole.Baremetal,
        interfaces: [
          {
            name: 'enp1s0',
            macAddress: 'aa:bb:cc:00:00:01',
            ips: [{ address: '10.0.5.10/24' }],
          },
        ],
        prefixes: [
          {
            id: 'pfx-vlan',
            cidr: '10.0.5.0/24',
            gatewayIp: '10.0.5.1',
            vlanVid: 100,
            vlanName: 'mgmt',
            enableVlanTag: true,
          },
        ],
      }),
    );

    const yaml = await service.renderForDevice('device-1');
    expect(yaml).toContain('  vlans:');
    expect(yaml).toContain('    enp1s0.100:');
  });

  it('bonds two same-type NICs sharing a prefix with bondParameters', async () => {
    mockBuild.mockResolvedValue(
      buildContext({
        role: DeviceRole.Baremetal,
        interfaces: [
          {
            name: 'eno1',
            macAddress: 'aa:bb:cc:00:00:01',
            type: InterfaceType.ETHERNET_10G,
            ips: [{ address: '10.10.0.5/24' }],
          },
          {
            name: 'eno2',
            macAddress: 'aa:bb:cc:00:00:02',
            type: InterfaceType.ETHERNET_10G,
            ips: [{ address: '10.10.0.6/24' }],
          },
        ],
        prefixes: [
          {
            id: 'pfx-bond',
            cidr: '10.10.0.0/24',
            gatewayIp: '10.10.0.1',
            gatewayRoutingPriority: 50,
            bondParameters: { mode: '802.3ad', 'lacp-rate': 'fast' },
          },
        ],
      }),
    );

    const yaml = await service.renderForDevice('device-1');

    expect(yaml).toContain('  bonds:');
    expect(yaml).toContain('    bond0:');
    expect(yaml).toContain('      interfaces:');
    expect(yaml).toContain('        - eno1');
    expect(yaml).toContain('        - eno2');
    expect(yaml).toContain('      parameters:');
    expect(yaml).toContain('        mode: 802.3ad');
    expect(yaml).toContain('        lacp-rate: fast');
    expect(yaml).toContain('      dhcp4: false');
    expect(yaml).toContain('      addresses:');
    expect(yaml).toContain('        - 10.10.0.5/24');
    expect(yaml).toContain('        - 10.10.0.6/24');
    expect(yaml).toContain('      macaddress: aa:bb:cc:00:00:01');
    expect(yaml).toContain('      routes:');
    expect(yaml).toContain('        - to: 0.0.0.0/0');
    expect(yaml).toContain('          via: 10.10.0.1');
    expect(yaml).toContain('          metric: 50');

    expect(yaml).toMatch(/eno1:\n {6}match:\n {8}macaddress: aa:bb:cc:00:00:01\n {4}eno2:/);
    expect(yaml).toMatch(/eno2:\n {6}match:\n {8}macaddress: aa:bb:cc:00:00:02\n {2}version: 2/);
  });

  it('uses a routable IP when the first bonded IP has no gateway', async () => {
    mockBuild.mockResolvedValue(
      buildContext({
        role: DeviceRole.Baremetal,
        interfaces: [
          {
            name: 'eno1',
            macAddress: 'aa:bb:cc:00:00:01',
            type: InterfaceType.ETHERNET_10G,
            ips: [
              { address: '10.10.0.5/24', vrfId: 'vrf-1' },
              { address: '10.20.0.5/24', vrfId: 'vrf-2' },
            ],
          },
          {
            name: 'eno2',
            macAddress: 'aa:bb:cc:00:00:02',
            type: InterfaceType.ETHERNET_10G,
            ips: [
              { address: '10.10.0.6/24', vrfId: 'vrf-1' },
              { address: '10.20.0.6/24', vrfId: 'vrf-2' },
            ],
          },
        ],
        prefixes: [
          { id: 'pfx-no-route', cidr: '10.10.0.0/24', vrfId: 'vrf-1', bondParameters: { mode: '802.3ad' } },
          {
            id: 'pfx-route',
            cidr: '10.20.0.0/24',
            vrfId: 'vrf-2',
            gatewayIp: '10.20.0.1',
            bondParameters: { mode: '802.3ad' },
          },
        ],
      }),
    );

    const yaml = await service.renderForDevice('device-1');
    expect(yaml).not.toContain('dhcp4: true');
    expect(yaml).toContain('    bond0:');
    expect(yaml).toContain('          via: 10.20.0.1');
  });

  it('keeps a no-gateway bond anchor when another prefix has a gateway', async () => {
    mockBuild.mockResolvedValue(
      buildContext({
        role: DeviceRole.Baremetal,
        interfaces: [
          {
            name: 'eno1',
            macAddress: 'aa:bb:cc:00:00:01',
            type: InterfaceType.ETHERNET_10G,
            ips: [{ address: '10.10.0.5/24' }],
          },
          {
            name: 'eno2',
            macAddress: 'aa:bb:cc:00:00:02',
            type: InterfaceType.ETHERNET_10G,
            ips: [{ address: '10.10.0.6/24' }],
          },
          {
            name: 'eno3',
            macAddress: 'aa:bb:cc:00:00:03',
            type: InterfaceType.ETHERNET_10G,
            ips: [{ address: '10.20.0.5/24' }],
          },
        ],
        prefixes: [
          { id: 'pfx-bond', cidr: '10.10.0.0/24', bondParameters: { mode: '802.3ad' } },
          {
            id: 'pfx-route',
            cidr: '10.20.0.0/24',
            gatewayIp: '10.20.0.1',
            bondParameters: { mode: '802.3ad' },
          },
        ],
      }),
    );

    const yaml = await service.renderForDevice('device-1');
    const bondBlock = yaml.slice(0, yaml.indexOf('  ethernets:'));

    expect(bondBlock).toContain('    bond0:');
    expect(bondBlock).toContain('        - eno1');
    expect(bondBlock).toContain('        - eno2');
    expect(bondBlock).not.toContain('        - eno3');
    expect(bondBlock).not.toContain('10.20.0.1');
  });

  it('falls back to dhcp when the bond has no gateway and only a folded member ip carries a router', async () => {
    mockBuild.mockResolvedValue(
      buildContext({
        role: DeviceRole.Baremetal,
        interfaces: [
          {
            name: 'eno1',
            macAddress: 'aa:bb:cc:00:00:01',
            type: InterfaceType.ETHERNET_10G,
            ips: [{ address: '10.10.0.5/24' }, { address: '10.30.0.5/24', vrfId: 'vrf-2' }],
          },
          {
            name: 'eno2',
            macAddress: 'aa:bb:cc:00:00:02',
            type: InterfaceType.ETHERNET_10G,
            ips: [{ address: '10.10.0.6/24' }],
          },
        ],
        prefixes: [
          { id: 'pfx-bond', cidr: '10.10.0.0/24', bondParameters: { mode: '802.3ad' } },
          { id: 'pfx-mgmt', cidr: '10.30.0.0/24', vrfId: 'vrf-2', gatewayIp: '10.30.0.1' },
        ],
      }),
    );

    const yaml = await service.renderForDevice('device-1');
    expect(yaml).toContain('dhcp4: true');
    expect(yaml).not.toContain('bond0');
  });

  it('falls back to dhcp when bond vlans drop the bond gateway and the vlan ips have no router', async () => {
    mockBuild.mockResolvedValue(
      buildContext({
        role: DeviceRole.Baremetal,
        interfaces: [
          {
            name: 'eno1',
            macAddress: 'aa:bb:cc:00:00:01',
            type: InterfaceType.ETHERNET_10G,
            ips: [{ address: '10.10.0.5/24' }, { address: '10.40.0.5/24' }],
          },
          {
            name: 'eno2',
            macAddress: 'aa:bb:cc:00:00:02',
            type: InterfaceType.ETHERNET_10G,
            ips: [{ address: '10.10.0.6/24' }],
          },
        ],
        prefixes: [
          { id: 'pfx-bond', cidr: '10.10.0.0/24', gatewayIp: '10.10.0.1', bondParameters: { mode: '802.3ad' } },
          { id: 'pfx-vlan', cidr: '10.40.0.0/24', vlanVid: 100, enableVlanTag: true },
        ],
      }),
    );

    const yaml = await service.renderForDevice('device-1');
    expect(yaml).toContain('dhcp4: true');
    expect(yaml).not.toContain('bond0');
  });

  it('does NOT bond when bondParameters is invalid — no fail-open bond0 without a mode', async () => {
    mockBuild.mockResolvedValue(
      buildContext({
        role: DeviceRole.Baremetal,
        interfaces: [
          {
            name: 'eno1',
            macAddress: 'aa:bb:cc:00:00:01',
            type: InterfaceType.ETHERNET_10G,
            ips: [{ address: '10.10.0.5/24' }],
          },
          {
            name: 'eno2',
            macAddress: 'aa:bb:cc:00:00:02',
            type: InterfaceType.ETHERNET_10G,
            ips: [{ address: '10.10.0.6/24' }],
          },
        ],
        prefixes: [
          {
            id: 'pfx-bond',
            cidr: '10.10.0.0/24',
            gatewayIp: '10.10.0.1',
            gatewayRoutingPriority: 50,
            bondParameters: { mode: { nested: true } },
          },
        ],
      }),
    );

    const yaml = await service.renderForDevice('device-1');

    expect(yaml).not.toContain('bonds:');
    expect(yaml).not.toContain('bond0');
  });

  it('renders the static bond config when the only route is a synthesized L3 route on bond members', async () => {
    mockBuild.mockResolvedValue(
      buildContext({
        role: DeviceRole.Baremetal,
        interfaces: [
          {
            name: 'eno1',
            macAddress: 'aa:bb:cc:00:00:01',
            type: InterfaceType.ETHERNET_10G,
            ips: [{ address: '10.10.0.5/24' }],
          },
          {
            name: 'eno2',
            macAddress: 'aa:bb:cc:00:00:02',
            type: InterfaceType.ETHERNET_10G,
            ips: [{ address: '10.10.0.6/24' }],
          },
        ],
        prefixes: [{ id: 'pfx-bond', cidr: '10.10.0.0/24', bondParameters: { mode: '802.3ad' } }],
        l3RouteIps: [{ containingPrefixId: 'pfx-bond', routingPrefix: '10.0.0.0/8', address: '10.10.0.254' }],
      }),
    );

    const yaml = await service.renderForDevice('device-1');

    expect(yaml).not.toContain('dhcp4: true');
    expect(yaml).toContain('    bond0:');
    expect(yaml).toContain('      routes:');
    expect(yaml).toContain('        - to: 10.0.0.0/8');
    expect(yaml).toContain('          via: 10.10.0.254');
    expect(yaml.match(/- to: 10\.0\.0\.0\/8/g)).toHaveLength(1);
    expect(yaml).not.toContain('        - to: 0.0.0.0/0');
  });

  it("falls back to DHCP when a VLAN-trunk bond member's only route is a dropped non-VLAN L3 route", async () => {
    mockBuild.mockResolvedValue(
      buildContext({
        role: DeviceRole.Hypervisor,
        interfaces: [
          {
            name: 'eno1',
            macAddress: 'aa:bb:cc:00:00:01',
            type: InterfaceType.ETHERNET_10G,
            ips: [{ address: '10.10.0.5/24' }, { address: '10.20.5.5/24' }],
          },
          {
            name: 'eno2',
            macAddress: 'aa:bb:cc:00:00:02',
            type: InterfaceType.ETHERNET_10G,
            ips: [{ address: '10.10.0.6/24' }],
          },
        ],
        prefixes: [
          { id: 'pfx-bond', cidr: '10.10.0.0/24', bondParameters: { mode: '802.3ad' } },
          { id: 'pfx-vlan', cidr: '10.20.5.0/24', vlanVid: 200, vlanName: 'mgmt' },
        ],
        l3RouteIps: [{ containingPrefixId: 'pfx-bond', routingPrefix: '10.0.0.0/8', address: '10.10.0.254' }],
      }),
    );

    const yaml = await service.renderForDevice('device-1');

    expect(yaml).toContain('dhcp4: true');
    expect(yaml).not.toContain('10.0.0.0/8');
  });

  it('cancels bonding when fewer than 2 members share the bond prefix', async () => {
    mockBuild.mockResolvedValue(
      buildContext({
        role: DeviceRole.Baremetal,
        interfaces: [
          {
            name: 'eno1',
            macAddress: 'aa:bb:cc:00:00:01',
            type: InterfaceType.ETHERNET_10G,
            ips: [{ address: '10.10.0.5/24' }],
          },
          {
            name: 'eno2',
            macAddress: 'aa:bb:cc:00:00:02',
            type: InterfaceType.ETHERNET_10G,
            ips: [{ address: '10.20.0.6/24' }],
          },
        ],
        prefixes: [
          {
            id: 'pfx-bond',
            cidr: '10.10.0.0/24',
            gatewayIp: '10.10.0.1',
            bondParameters: { mode: '802.3ad' },
          },
          { id: 'pfx-other', cidr: '10.20.0.0/24', gatewayIp: '10.20.0.1' },
        ],
      }),
    );

    const yaml = await service.renderForDevice('device-1');
    expect(yaml).not.toContain('  bonds:');
    expect(yaml).toContain('        - 10.10.0.5/24');
    expect(yaml).toContain('        - 10.20.0.6/24');
  });

  it('only re-parents VLANs on bond-member interfaces, not other VLAN-tagged interfaces', async () => {
    mockBuild.mockResolvedValue(
      buildContext({
        role: DeviceRole.Hypervisor,
        interfaces: [
          {
            name: 'eno1',
            macAddress: 'aa:bb:cc:00:00:01',
            type: InterfaceType.ETHERNET_10G,
            ips: [{ address: '10.10.0.5/24' }],
          },
          {
            name: 'eno2',
            macAddress: 'aa:bb:cc:00:00:02',
            type: InterfaceType.ETHERNET_10G,
            ips: [{ address: '10.10.0.6/24' }],
          },
          {
            name: 'enp7s0',
            macAddress: 'aa:bb:cc:00:00:07',
            type: InterfaceType.ETHERNET_1G,
            ips: [{ address: '10.20.5.7/24' }],
          },
        ],
        prefixes: [
          {
            id: 'pfx-bond',
            cidr: '10.10.0.0/24',
            gatewayIp: '10.10.0.1',
            bondParameters: { mode: '802.3ad' },
          },
          {
            id: 'pfx-mgmt-vlan',
            cidr: '10.20.5.0/24',
            gatewayIp: '10.20.5.1',
            vlanVid: 200,
            vlanName: 'mgmt',
          },
        ],
      }),
    );

    const yaml = await service.renderForDevice('device-1');

    expect(yaml).toContain('  bonds:');
    expect(yaml).toContain('    bond0:');

    expect(yaml).toContain('    enp7s0.200:');
    expect(yaml).toContain('      link: enp7s0');
    expect(yaml).not.toContain('    bond0.200:');
    expect(yaml).not.toMatch(/enp7s0\.200:[\s\S]*link: bond0/);
  });

  it('silently ignores IPv6 IPs on a device', async () => {
    mockBuild.mockResolvedValue(
      buildContext({
        role: DeviceRole.Baremetal,
        interfaces: [
          {
            name: 'eno1',
            macAddress: 'aa:bb:cc:00:00:01',
            ips: [{ address: '10.0.0.5/24' }, { address: '2001:db8::5/64' }],
          },
        ],
        prefixes: [
          { id: 'pfx-v4', cidr: '10.0.0.0/24', gatewayIp: '10.0.0.1' },
          { id: 'pfx-v6', cidr: '2001:db8::/64' },
        ],
      }),
    );

    const yaml = await service.renderForDevice('device-1');
    expect(yaml).toContain('        - 10.0.0.5/24');
    expect(yaml).not.toContain('2001:db8');
    expect(yaml).not.toContain('::');
  });

  describe('renderForUserDevice (org-scope)', () => {
    it('allows the supplier org to render', async () => {
      mockDeviceFindUnique.mockResolvedValue({ id: 'device-1' });
      mockBuild.mockResolvedValue(
        buildContext({
          interfaces: [{ name: 'eno1', macAddress: 'aa:bb:cc:00:00:01' }],
        }),
      );

      const yaml = await service.renderForUserDevice('device-1');
      expect(yaml).toContain('network:');

      const where = mockDeviceFindUnique.mock.calls[0][0].where;
      expect(where.id).toBe('device-1');
      expect(where.OR).toEqual([
        { supplierId: CALLER_ORG_ID },
        { server: { deployments: { some: { customerId: CALLER_ORG_ID, endDate: null } } } },
      ]);
    });

    it('allows the owning organization to render bridge netplan', async () => {
      mockDeviceFindUnique.mockResolvedValue({ id: 'device-1' });
      mockBuild.mockResolvedValue(
        buildContext({
          role: DeviceRole.Bridge,
          interfaces: [{ name: 'eno1', macAddress: 'aa:bb:cc:00:00:01' }],
        }),
      );

      await expect(service.renderForUserDevice('device-1')).resolves.toContain('network:');
      expect(mockDeviceFindUnique.mock.calls[0][0].where.OR).toContainEqual({ supplierId: CALLER_ORG_ID });
    });

    it('allows the customer org of an active deployment to render', async () => {
      mockDeviceFindUnique.mockResolvedValue({ id: 'device-1' });
      mockBuild.mockResolvedValue(
        buildContext({
          interfaces: [{ name: 'eno1', macAddress: 'aa:bb:cc:00:00:01' }],
        }),
      );

      const yaml = await service.renderForUserDevice('device-1');
      expect(yaml).toContain('network:');
    });

    it('throws 403 when the caller is neither supplier nor active customer', async () => {
      mockDeviceFindUnique.mockResolvedValue(null);

      await expect(service.renderForUserDevice('device-1')).rejects.toMatchObject({
        status: 403,
        message: expect.stringContaining('device-1'),
      });
      expect(mockBuild).not.toHaveBeenCalled();
    });

    it('filters deployments by endDate IS NULL so past customers do not retain access', async () => {
      mockDeviceFindUnique.mockResolvedValue(null);

      await expect(service.renderForUserDevice('device-1')).rejects.toMatchObject({
        status: 403,
      });
      const where = mockDeviceFindUnique.mock.calls[0][0].where;
      const customerClause = where.OR.find((clause: Record<string, unknown>) => 'server' in clause);
      expect(customerClause).toEqual({
        server: { deployments: { some: { customerId: CALLER_ORG_ID, endDate: null } } },
      });
    });

    it('returns 422 when accessible device data cannot produce a safe config', async () => {
      mockDeviceFindUnique.mockResolvedValue({ id: 'device-1' });
      mockBuild.mockResolvedValue(
        buildContext({
          interfaces: [{ name: 'eno1', macAddress: 'aa:bb:cc:00:00:01', ips: [{ address: '192.0.2.10/24' }] }],
        }),
      );

      await expect(service.renderForUserDevice('device-1')).rejects.toMatchObject({
        status: 422,
        message: expect.stringContaining('Unable to render live netplan'),
      });
    });
  });
});

describe('pickGateway', () => {
  it('prefers the lowest routing priority with null treated as highest preference', () => {
    const auto = { vrfId: null, routingPriority: 100 };
    const operator = { vrfId: null, routingPriority: null };
    expect(pickGateway([auto, operator], null)).toBe(operator);
    expect(pickGateway([operator, auto], null)).toBe(operator);
    const explicit = { vrfId: null, routingPriority: 10 };
    expect(pickGateway([auto, explicit], null)).toBe(explicit);
  });

  it('only considers gateways in the device vrf', () => {
    const otherVrf = { vrfId: 'vrf-1', routingPriority: null };
    const auto = { vrfId: null, routingPriority: 100 };
    expect(pickGateway([otherVrf, auto], null)).toBe(auto);
    expect(pickGateway([auto], 'vrf-1')).toBeNull();
  });
});
