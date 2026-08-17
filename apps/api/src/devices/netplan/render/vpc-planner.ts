import { TagObjectType } from '@repo/database';
import type { DeviceContext, PrefixWithRelations } from '../../device-context/device-context.types';
import { extractMask, prefixContainsIpv4 } from '../netplan-planner';

/** Most-specific-wins in both passes (gatewayed candidates first), over `ipam.vrfPrefixes` — the
 * customer VRF. `flat` differs: first gatewayed candidate, VRF-matched. */
export function pickVpcPrefix(
  ctx: DeviceContext,
  ip: { address: string; vrfId: string | null },
): PrefixWithRelations | null {
  const host = ip.address.includes('/') ? ip.address.slice(0, ip.address.indexOf('/')) : ip.address;
  const candidates = ctx.ipam.vrfPrefixes.filter((p) => p.vrfId === ip.vrfId && prefixContainsIpv4(p.prefix, host));
  if (candidates.length === 0) return null;

  const longest = (pool: PrefixWithRelations[]): PrefixWithRelations | null =>
    pool.reduce<PrefixWithRelations | null>(
      (best, p) => (best === null || Number(extractMask(p.prefix)) > Number(extractMask(best.prefix)) ? p : best),
      null,
    );

  return longest(candidates.filter((p) => p.gateways.length > 0)) ?? longest(candidates);
}

/** Deliberately NOT VRF-filtered, unlike the flat and bridge-default paths which match the zone
 * VRF — upstream takes the prefix's first gateway with no VRF predicate. */
export function vpcGatewayFor(prefix: PrefixWithRelations): PrefixWithRelations['gateways'][number] | null {
  return prefix.gateways[0] ?? null;
}

export interface VpcInterfaceTags {
  /** `north-south` — customer-facing uplink. Gates config and bonding during discovery. */
  isNorthSouth: boolean;
  /** `in-band-management` — shifts additional-route metrics and adds a fallback default route. */
  isInBand: boolean;
  /** `east-west` — the RoCE fabric side. vpc-roce renders these as /31s, or skips them. */
  isEastWest: boolean;
}

export function vpcInterfaceTags(ctx: DeviceContext, interfaceId: string): VpcInterfaceTags {
  const slugs = new Set(
    ctx.tagAssignments
      .filter((ta) => ta.objectType === TagObjectType.INTERFACE && ta.objectId === interfaceId)
      .map((ta) => ta.tag.slug),
  );
  return {
    isNorthSouth: slugs.has('north-south'),
    isInBand: slugs.has('in-band-management'),
    isEastWest: slugs.has('east-west'),
  };
}

/** One function per metric site. 50 vs 300 on a north-south bond decides whether a deprovisioning
 * host still attracts customer traffic; the VLAN secondary offset is +50 where flat uses +500. */
export const VPC_DEPROVISIONING_METRIC = 300;
export const VPC_NORTHSOUTH_BOND_METRIC = 50;
export const VPC_INBAND_FALLBACK_METRIC = 100;
export const VPC_NORTHSOUTH_OFFSET = 100;
export const VPC_VLAN_SECONDARY_OFFSET = 50;
export const VPC_INBAND_ADDITIONAL_OFFSET = 100;

/** North-south bond default route (trinity 485). Trinity always emits a metric. */
export function northSouthBondMetric(isDeprovisioning: boolean): number {
  return isDeprovisioning ? VPC_DEPROVISIONING_METRIC : VPC_NORTHSOUTH_BOND_METRIC;
}

/** Non-north-south bond default route (trinity 530). */
export function bondMetric(routingPriority: number | null, counter: number): number {
  return routingPriority ?? counter;
}

/** THREE-way branch: north-south, then in-band, then everything else. Returns null for the one arm
 * that emits no metric line (in-band while deprovisioning); the counter advances regardless. */
export function ethernetMetric(
  opts: { isNorthSouth: boolean; isInBand: boolean; isDeprovisioning: boolean; routingPriority: number | null },
  counter: number,
): number | null {
  if (opts.isNorthSouth) {
    if (opts.isDeprovisioning) return VPC_DEPROVISIONING_METRIC;
    return opts.routingPriority ?? counter + VPC_NORTHSOUTH_OFFSET;
  }
  if (opts.isInBand) {
    if (opts.isDeprovisioning) return null;
    return opts.routingPriority ?? counter + VPC_NORTHSOUTH_OFFSET;
  }
  return opts.routingPriority ?? counter;
}

/** In-band fallback: destination is `10.0.0.0/8`, NOT a default route, always at metric 100. */
export const VPC_INBAND_FALLBACK_ROUTE = { to: '10.0.0.0/8', metric: VPC_INBAND_FALLBACK_METRIC };

/** Deduped by `to|via` across an interface's configs, and suppressed entirely on north-south
 * interfaces. Neither behaviour exists in the flat or bridge families. */
export function dedupeAdditionalRoutes<R extends { to: string; via: string }>(routes: R[]): R[] {
  const seen = new Set<string>();
  return routes.filter((r) => {
    const key = `${r.to}|${r.via}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Deduped by gateway across an interface's configs, so two IPs sharing a gateway yield ONE default
 * route. The flat and bridge families emit one per IP. */
export function dedupeByGateway<C extends { router: string | null }>(configs: C[]): C[] {
  const seen = new Set<string>();
  return configs.filter((c) => {
    if (!c.router || seen.has(c.router)) return false;
    seen.add(c.router);
    return true;
  });
}

/** VLAN sub-interface default route (trinity 708-715). Note the +50, not +500. */
export function vlanMetric(
  opts: { isNorthSouth: boolean; isDeprovisioning: boolean; routingPriority: number | null; role: string },
  counter: number,
): number {
  if (opts.isNorthSouth) {
    if (opts.isDeprovisioning) return VPC_DEPROVISIONING_METRIC;
    return opts.routingPriority ?? counter + VPC_NORTHSOUTH_OFFSET;
  }
  if (opts.routingPriority !== null) return opts.routingPriority;
  return opts.role === 'primary' ? counter : counter + VPC_VLAN_SECONDARY_OFFSET;
}

/** Synthesized l3-route metric, bumped for in-band interfaces (trinity 622, 730). */
export function additionalRouteMetric(baseMetric: number, isInBand: boolean): number {
  return isInBand ? baseMetric + VPC_INBAND_ADDITIONAL_OFFSET : baseMetric;
}
