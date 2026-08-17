import { TagObjectType } from '@repo/database';
import { describe, expect, it } from 'vitest';
import type { DeviceContext } from '../../../device-context/device-context.types';
import {
  additionalRouteMetric,
  bondMetric,
  dedupeAdditionalRoutes,
  dedupeByGateway,
  ethernetMetric,
  northSouthBondMetric,
  pickVpcPrefix,
  vlanMetric,
  VPC_INBAND_FALLBACK_ROUTE,
  vpcGatewayFor,
  vpcInterfaceTags,
} from '../vpc-planner';

interface VrfPrefixFixture {
  id: string;
  cidr: string;
  vrfId: string | null;
  gatewayIp?: string;
}

function ctxWith(fix: { vrfPrefixes?: VrfPrefixFixture[]; interfaceTags?: Array<[string, string]> }): DeviceContext {
  return {
    device: { interfaces: [] },
    ipam: {
      prefixes: [],
      gateways: [],
      vlans: [],
      vrfs: [],
      l3RouteIps: [],
      bridgeDeviceIps: [],
      vrfPrefixes: (fix.vrfPrefixes ?? []).map((p, idx) => ({
        id: p.id,
        prefix: p.cidr,
        vrfId: p.vrfId,
        vlan: null,
        prefixRole: null,
        bondParameters: null,
        gateways: p.gatewayIp
          ? [
              {
                id: `gw-${idx}`,
                vrfId: null,
                routingPriority: null,
                gatewayIp: { id: `gwip-${idx}`, address: `${p.gatewayIp}/24`, routingPrefix: null },
              },
            ]
          : [],
      })),
    },
    tagAssignments: (fix.interfaceTags ?? []).map(([objectId, slug]) => ({
      objectType: TagObjectType.INTERFACE,
      objectId,
      tag: { slug },
    })),
    prefixByIpId: {},
    cabledInterfaceIds: [],
  } as unknown as DeviceContext;
}

describe('pickVpcPrefix', () => {
  const ip = { address: '10.0.0.5/24', vrfId: 'cust-vrf' };

  it('resolves against the customer VRF, ignoring prefixes in other VRFs', () => {
    const ctx = ctxWith({
      vrfPrefixes: [
        { id: 'other', cidr: '10.0.0.0/24', vrfId: 'someone-else', gatewayIp: '10.0.0.9' },
        { id: 'mine', cidr: '10.0.0.0/24', vrfId: 'cust-vrf', gatewayIp: '10.0.0.1' },
      ],
    });
    expect(pickVpcPrefix(ctx, ip)?.id).toBe('mine');
  });

  it('takes the MOST SPECIFIC gateway-bearing prefix, not the first', () => {
    // The distinguishing behaviour vs flat-default, which takes the first hit.
    const ctx = ctxWith({
      vrfPrefixes: [
        { id: 'wide', cidr: '10.0.0.0/16', vrfId: 'cust-vrf', gatewayIp: '10.0.255.1' },
        { id: 'narrow', cidr: '10.0.0.0/24', vrfId: 'cust-vrf', gatewayIp: '10.0.0.1' },
      ],
    });
    expect(pickVpcPrefix(ctx, ip)?.id).toBe('narrow');
  });

  it('prefers a gateway-bearing prefix over a more specific one without a gateway', () => {
    const ctx = ctxWith({
      vrfPrefixes: [
        { id: 'wide-gw', cidr: '10.0.0.0/16', vrfId: 'cust-vrf', gatewayIp: '10.0.255.1' },
        { id: 'narrow-nogw', cidr: '10.0.0.0/28', vrfId: 'cust-vrf' },
      ],
    });
    expect(pickVpcPrefix(ctx, ip)?.id).toBe('wide-gw');
  });

  it('falls back to the most specific prefix when none has a gateway', () => {
    const ctx = ctxWith({
      vrfPrefixes: [
        { id: 'wide', cidr: '10.0.0.0/16', vrfId: 'cust-vrf' },
        { id: 'narrow', cidr: '10.0.0.0/28', vrfId: 'cust-vrf' },
      ],
    });
    expect(pickVpcPrefix(ctx, ip)?.id).toBe('narrow');
  });

  it('returns null when nothing contains the IP', () => {
    const ctx = ctxWith({ vrfPrefixes: [{ id: 'elsewhere', cidr: '192.168.0.0/24', vrfId: 'cust-vrf' }] });
    expect(pickVpcPrefix(ctx, ip)).toBeNull();
  });

  it('matches a VRF-less IP against VRF-less prefixes', () => {
    const ctx = ctxWith({ vrfPrefixes: [{ id: 'novrf', cidr: '10.0.0.0/24', vrfId: null }] });
    expect(pickVpcPrefix(ctx, { address: '10.0.0.5/24', vrfId: null })?.id).toBe('novrf');
  });
});

describe('vpcGatewayFor', () => {
  it('takes the first gateway with no VRF filtering', () => {
    const ctx = ctxWith({ vrfPrefixes: [{ id: 'p', cidr: '10.0.0.0/24', vrfId: null, gatewayIp: '10.0.0.1' }] });
    const prefix = ctx.ipam.vrfPrefixes[0];
    expect(vpcGatewayFor(prefix)?.gatewayIp.address).toBe('10.0.0.1/24');
  });

  it('returns null for a prefix with no gateway', () => {
    const ctx = ctxWith({ vrfPrefixes: [{ id: 'p', cidr: '10.0.0.0/24', vrfId: null }] });
    expect(vpcGatewayFor(ctx.ipam.vrfPrefixes[0])).toBeNull();
  });
});

describe('vpcInterfaceTags', () => {
  it('reads north-south, in-band-management and east-west off the interface', () => {
    const ctx = ctxWith({
      interfaceTags: [
        ['if-1', 'north-south'],
        ['if-1', 'in-band-management'],
        ['if-2', 'north-south'],
        ['if-4', 'east-west'],
      ],
    });
    expect(vpcInterfaceTags(ctx, 'if-1')).toEqual({ isNorthSouth: true, isInBand: true, isEastWest: false });
    expect(vpcInterfaceTags(ctx, 'if-2')).toEqual({ isNorthSouth: true, isInBand: false, isEastWest: false });
    expect(vpcInterfaceTags(ctx, 'if-3')).toEqual({ isNorthSouth: false, isInBand: false, isEastWest: false });
    expect(vpcInterfaceTags(ctx, 'if-4')).toEqual({ isNorthSouth: false, isInBand: false, isEastWest: true });
  });
});

describe('VPC metric rules', () => {
  it('north-south bond: 50 normally, 300 when deprovisioning (trinity)', () => {
    expect(northSouthBondMetric(false)).toBe(50);
    expect(northSouthBondMetric(true)).toBe(300);
  });


  it('non-north-south bond: routing priority else the counter', () => {
    expect(bondMetric(42, 100)).toBe(42);
    expect(bondMetric(null, 100)).toBe(100);
  });

  it('ethernet: three-way branch, and in-band while deprovisioning emits NO metric', () => {
    const at = (o: Partial<Parameters<typeof ethernetMetric>[0]>) =>
      ethernetMetric(
        { isNorthSouth: false, isInBand: false, isDeprovisioning: false, routingPriority: null, ...o },
        100,
      );

    // north-south arm
    expect(at({ isNorthSouth: true, isDeprovisioning: true })).toBe(300);
    // deprovisioning beats an explicit priority on north-south
    expect(at({ isNorthSouth: true, isDeprovisioning: true, routingPriority: 42 })).toBe(300);
    expect(at({ isNorthSouth: true })).toBe(200);
    expect(at({ isNorthSouth: true, routingPriority: 42 })).toBe(42);

    // in-band arm — the one that emits no metric line at all
    expect(at({ isInBand: true, isDeprovisioning: true })).toBeNull();
    expect(at({ isInBand: true, isDeprovisioning: true, routingPriority: 42 })).toBeNull();
    expect(at({ isInBand: true })).toBe(200);
    expect(at({ isInBand: true, routingPriority: 42 })).toBe(42);

    // plain arm — deprovisioning is irrelevant here
    expect(at({})).toBe(100);
    expect(at({ isDeprovisioning: true })).toBe(100);
    expect(at({ routingPriority: 42 })).toBe(42);

    // north-south wins when an interface is tagged both
    expect(at({ isNorthSouth: true, isInBand: true, isDeprovisioning: true })).toBe(300);
  });

  it('dedupes default routes by gateway and additional routes by to|via', () => {
    expect(
      dedupeByGateway([{ router: '10.0.0.1' }, { router: '10.0.0.1' }, { router: '10.0.0.2' }, { router: null }]),
    ).toEqual([{ router: '10.0.0.1' }, { router: '10.0.0.2' }]);

    expect(
      dedupeAdditionalRoutes([
        { to: '10.1.0.0/16', via: '10.0.0.9' },
        { to: '10.1.0.0/16', via: '10.0.0.9' },
        { to: '10.1.0.0/16', via: '10.0.0.8' },
      ]),
    ).toHaveLength(2);
  });

  it('the in-band fallback route targets 10.0.0.0/8, not a default route', () => {
    expect(VPC_INBAND_FALLBACK_ROUTE).toEqual({ to: '10.0.0.0/8', metric: 100 });
  });

  it('vlan: secondary offset is 50, NOT flat-default’s 500', () => {
    expect(
      vlanMetric({ isNorthSouth: false, isDeprovisioning: false, routingPriority: null, role: 'primary' }, 100),
    ).toBe(100);
    expect(
      vlanMetric({ isNorthSouth: false, isDeprovisioning: false, routingPriority: null, role: 'secondary' }, 100),
    ).toBe(150);
    expect(
      vlanMetric({ isNorthSouth: true, isDeprovisioning: false, routingPriority: null, role: 'primary' }, 100),
    ).toBe(200);
    expect(
      vlanMetric({ isNorthSouth: true, isDeprovisioning: true, routingPriority: null, role: 'primary' }, 100),
    ).toBe(300);
    expect(
      vlanMetric({ isNorthSouth: false, isDeprovisioning: false, routingPriority: 42, role: 'secondary' }, 100),
    ).toBe(42);
  });

  it('additional routes gain 100 only on in-band interfaces', () => {
    expect(additionalRouteMetric(200, false)).toBe(200);
    expect(additionalRouteMetric(200, true)).toBe(300);
  });
});
