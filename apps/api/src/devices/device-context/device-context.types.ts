import type { Prisma } from '@repo/database';

export const deviceContextInclude = {
  zone: { include: { region: true } },
  supplier: true,
  deviceModel: true,
  interfaces: {
    where: { deletedAt: null },
    include: {
      ipAddresses: {
        where: { deletedAt: null },
        include: { vrf: true },
      },
      untaggedVlan: true,
      lag: true,
      parent: true,
    },
    orderBy: { name: 'asc' as const },
  },
  storageDrives: { orderBy: { name: 'asc' as const } },
  gpus: { orderBy: { index: 'asc' as const } },
  memoryConfig: true,
  server: {
    include: {
      deployments: {
        where: { endDate: null },
        include: {
          baseLayer: true,
          deploymentKeys: { include: { sshKey: true } },
        },
      },
    },
  },
} satisfies Prisma.DeviceInclude;

type PrefixCidrFields = { prefix: string };
type IpRoutingFields = { routingPrefix: string | null };

type RawDeviceWithRelations = Prisma.DeviceGetPayload<{
  include: typeof deviceContextInclude;
}>;

type WithInterfaceIpEnrichment<T> = T & {
  interfaces: Array<
    T extends { interfaces: Array<infer I> }
      ? Omit<I, 'ipAddresses'> & {
          ipAddresses: Array<I extends { ipAddresses: Array<infer Ip> } ? Ip & IpRoutingFields : never>;
        }
      : never
  >;
};

export type DeviceWithRelations = WithInterfaceIpEnrichment<RawDeviceWithRelations>;

export const deviceContextPrefixInclude = {
  vlan: true,
  vrf: true,
  prefixRole: true,
  gateways: { include: { gatewayIp: true, vrf: true } },
} satisfies Prisma.PrefixInclude;

export const deviceContextGatewayInclude = {
  gatewayIp: true,
  vrf: true,
  prefix: true,
} satisfies Prisma.GatewayInclude;

export type RawPrefixWithRelations = Prisma.PrefixGetPayload<{
  include: typeof deviceContextPrefixInclude;
}>;

export type RawGatewayWithRelations = Prisma.GatewayGetPayload<{
  include: typeof deviceContextGatewayInclude;
}>;

export type PrefixWithRelations = RawPrefixWithRelations & PrefixCidrFields;

export type GatewayWithRelations = Omit<RawGatewayWithRelations, 'prefix' | 'gatewayIp'> & {
  prefix: RawGatewayWithRelations['prefix'] & PrefixCidrFields;
  gatewayIp: RawGatewayWithRelations['gatewayIp'] & IpRoutingFields;
};

export type VlanWithRelations = Prisma.VlanGetPayload<object>;
export type VrfWithRelations = Prisma.VrfGetPayload<object>;

export const deviceContextTagAssignmentInclude = {
  tag: true,
} satisfies Prisma.TagAssignmentInclude;

export type TagAssignmentWithTag = Prisma.TagAssignmentGetPayload<{
  include: typeof deviceContextTagAssignmentInclude;
}>;

export interface L3RouteIp {
  id: string;
  address: string;
  routingPrefix: string;
  containingPrefixId: string;
}

export interface BridgeDeviceIp {
  id: string;
  address: string;
  containingPrefixId: string;
}

export interface DeviceContext {
  device: DeviceWithRelations;

  ipam: {
    prefixes: PrefixWithRelations[];
    gateways: GatewayWithRelations[];
    vlans: VlanWithRelations[];
    vrfs: VrfWithRelations[];
    l3RouteIps: L3RouteIp[];
    bridgeDeviceIps: BridgeDeviceIp[];

    /** VRF-scoped prefixes (each carrying its own `gateways`), kept separate from `prefixes` because
     * merging customer VRFs in would change which prefix wins `mostSpecific` for every renderer. */
    vrfPrefixes: PrefixWithRelations[];
  };

  tagAssignments: TagAssignmentWithTag[];

  /** Interfaces terminating a CONNECTED cable — polymorphic, so it cannot ride the device include.
   * Distinct from `markConnected`, the operator's "pretend it is cabled" override. */
  cabledInterfaceIds: string[];

  prefixByIpId: Record<string, PrefixWithRelations | null>;
}
