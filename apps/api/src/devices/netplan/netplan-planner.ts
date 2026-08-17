import { BondParametersSchema } from '@repo/api-client';
import { InterfaceType } from '@repo/database';
import { ipv4InCidr } from 'src/common/ip-utils';
import type { DeviceContext, DeviceWithRelations, PrefixWithRelations } from '../device-context/device-context.types';
import type { NetplanPhase } from './netplan.service';

type DeviceInterface = DeviceWithRelations['interfaces'][number];
type DeviceIp = DeviceInterface['ipAddresses'][number];

export interface InterfaceIpPlan {
  staticIp: string;
  netmask: string;
  router: string | null;
  routingPriority: number | null;
  role: string;
  prefix: PrefixWithRelations;
  mtu: number | null;
  additionalRoutes: AdditionalRoute[];
}

export interface AdditionalRoute {
  to: string;
  via: string;
  metric: number;
}

export interface InterfacePlan {
  iface: DeviceInterface;
  configuredIps: InterfaceIpPlan[];
  vlanIps: Map<number, VlanGroupEntry>;
}

export interface VlanGroupEntry {
  vlanId: number;
  vlanName: string;
  vlanInterfaceName: string;
  parentInterface: string;
  ips: InterfaceIpPlan[];
}

export interface BondDecision {
  shouldBond: boolean;
  anchor: DeviceInterface | null;
  prefix: PrefixWithRelations | null;
  gateway: string | null;
  gatewayRoutingPriority: number | null;
  members: DeviceInterface[];
}

export interface RenderPlan {
  ctx: DeviceContext;
  phase: NetplanPhase;
  bond: BondDecision;
  interfacePlans: InterfacePlan[];
  deviceRoleSlug: string | null;
}

const EXCLUDED_NAME_LOWER = new Set(['wt0', 'ipmi']);

export function isEligibleInterface(iface: DeviceInterface): boolean {
  const nameLower = iface.name.toLowerCase();
  if (EXCLUDED_NAME_LOWER.has(nameLower)) return false;
  if (iface.type === InterfaceType.VIRTUAL) return false;
  return true;
}

export function hasAnyEligibleIp(interfaces: DeviceInterface[]): boolean {
  return interfaces.some((i) => isEligibleInterface(i) && i.ipAddresses.length > 0);
}

export function planHasDefaultRoute(plan: RenderPlan): boolean {
  const bondMemberNames = new Set(plan.bond.members.map((m) => m.name));
  const bondHasVlans = plan.interfacePlans.some((p) =>
    [...p.vlanIps.values()].some((v) => v.parentInterface === 'bond0'),
  );
  // renderBondBlock emits bond.gateway only when no member VLANs sit on bond0; with VLANs
  // the bond block is interfaces+parameters only and routes must come from the vlan groups.
  if (plan.bond.shouldBond && !bondHasVlans && plan.bond.gateway !== null) return true;
  for (const ifacePlan of plan.interfacePlans) {
    const memberFoldedIntoBond = plan.bond.shouldBond && bondMemberNames.has(ifacePlan.iface.name);
    // Folded members render only bond.gateway + additionalRoutes (renderBondBlock); their
    // per-IP routers never emit, so counting them here would suppress the DHCP fallback.
    const configRoutable = ifacePlan.configuredIps.some((ip) =>
      memberFoldedIntoBond
        ? !bondHasVlans && ip.additionalRoutes.length > 0
        : ip.router !== null || ip.additionalRoutes.length > 0,
    );
    if (configRoutable) return true;
    for (const group of ifacePlan.vlanIps.values()) {
      if (group.ips.some((ip) => ip.router !== null || ip.additionalRoutes.length > 0)) return true;
    }
  }
  return false;
}

interface PlannerOptions {
  deviceRoleSlug: string | null;
}

export function buildInterfacePlans(ctx: DeviceContext, opts: PlannerOptions): InterfacePlan[] {
  const plans: InterfacePlan[] = [];
  for (const iface of ctx.device.interfaces) {
    if (!isEligibleInterface(iface)) continue;
    const plan: InterfacePlan = { iface, configuredIps: [], vlanIps: new Map() };
    if (!iface.enabled) {
      plans.push(plan);
      continue;
    }
    for (const ip of iface.ipAddresses) {
      if (!isIpv4(ip.address)) continue;
      const ipPlan = planIp(ctx, iface, ip);
      if (!ipPlan) continue;
      if (shouldVlanTag(ipPlan.prefix, opts.deviceRoleSlug)) {
        const vlan = ipPlan.prefix.vlan;
        if (!vlan) continue;
        addToVlanGroup(plan, iface.name, vlan.vid, vlan.name, ipPlan);
      } else {
        plan.configuredIps.push(ipPlan);
      }
    }
    plans.push(plan);
  }
  return plans;
}

function planIp(ctx: DeviceContext, iface: DeviceInterface, ip: DeviceIp): InterfaceIpPlan | null {
  const prefix = pickPrefixForIp(ctx, ip, ip.vrfId ?? null);
  if (!prefix) return null;

  const routeVrfId = ip.vrfId ?? prefix.vrfId;
  const gateway = pickGateway(prefix.gateways, routeVrfId);
  const router = gateway?.gatewayIp ? stripMask(gateway.gatewayIp.address) : null;

  return {
    staticIp: stripMask(ip.address),
    netmask: extractMask(prefix.prefix),
    router,
    routingPriority: gateway?.routingPriority ?? null,
    role: prefix.prefixRole?.slug ?? 'secondary',
    prefix,
    mtu: iface.mtu ?? null,
    additionalRoutes: [],
  };
}

// routingPriority is metric-like (lowest wins): operator rows (null → 0) outrank
// auto-derived rows (100), so a concurrent duplicate resolves to the operator's gateway.
export function pickGateway<T extends { vrfId: string | null; routingPriority: number | null }>(
  gateways: T[],
  deviceVrfId: string | null,
): T | null {
  const matches = gateways.filter((g) => g.vrfId === deviceVrfId);
  if (matches.length === 0) return null;
  return matches.reduce((best, g) => ((g.routingPriority ?? 0) < (best.routingPriority ?? 0) ? g : best));
}

// The VRF is a parameter rather than read off `ip` because the bridge and VPC
// renderers resolve some IPs against a VRF the IP row does not itself carry.
export function pickPrefixForIp(ctx: DeviceContext, ip: DeviceIp, vrfId: string | null): PrefixWithRelations | null {
  const host = stripMask(ip.address);
  const candidates = ctx.ipam.prefixes.filter(
    (p) => ipv4InCidr(host, p.prefix) && (vrfId === null || p.vrfId === vrfId),
  );
  if (candidates.length === 0) return null;
  if (vrfId === null) {
    const longestMask = Math.max(...candidates.map((p) => Number(extractMask(p.prefix))));
    const matches = candidates.filter((p) => Number(extractMask(p.prefix)) === longestMask);
    const globalMatches = matches.filter((p) => p.vrfId === null);
    if (globalMatches.length > 0) return globalMatches.length === 1 ? (globalMatches[0] ?? null) : null;
    return matches.length === 1 ? (matches[0] ?? null) : null;
  }
  // Most-specific first: with auto-materialized children, parent and child can both carry
  // gateways — the connected subnet's mask/router must win over the supernet's.
  const ordered = [...candidates].sort((a, b) => Number(extractMask(b.prefix)) - Number(extractMask(a.prefix)));
  const withGateway = ordered.find((p) => p.gateways.some((g) => g.vrfId === vrfId));
  if (withGateway) return withGateway;
  return mostSpecific(candidates);
}

export function mostSpecific(prefixes: PrefixWithRelations[]): PrefixWithRelations {
  return prefixes.reduce((best, p) => {
    const bestLen = Number(extractMask(best.prefix));
    const pLen = Number(extractMask(p.prefix));
    return pLen > bestLen ? p : best;
  });
}

const NEVER_TAG_ROLES = new Set(['marketplace-hosts', 'decommissioned-hosts', 'discovered-hosts']);

function shouldVlanTag(prefix: PrefixWithRelations, deviceRoleSlug: string | null): boolean {
  if (!prefix.vlan) return false;
  if (prefix.enableVlanTag) return true;
  if (deviceRoleSlug === 'brokkr-bridge') return true;
  if (deviceRoleSlug && !NEVER_TAG_ROLES.has(deviceRoleSlug)) return true;
  return false;
}

function hasBondMembers(
  interfacePlans: InterfacePlan[],
  prefixId: string,
  interfaceType: DeviceInterface['type'],
): boolean {
  let memberCount = 0;
  for (const plan of interfacePlans) {
    if (!plan.iface.enabled || plan.iface.type !== interfaceType) continue;
    const allIps = [...plan.configuredIps, ...[...plan.vlanIps.values()].flatMap((v) => v.ips)];
    if (allIps.length === 0 || allIps.some((ip) => ip.prefix.id === prefixId)) {
      memberCount += 1;
      if (memberCount >= 2) return true;
    }
  }
  return false;
}

function addToVlanGroup(
  plan: InterfacePlan,
  parentInterfaceInitial: string,
  vid: number,
  vlanName: string,
  ipPlan: InterfaceIpPlan,
): void {
  let entry = plan.vlanIps.get(vid);
  if (!entry) {
    entry = {
      vlanId: vid,
      vlanName,
      parentInterface: parentInterfaceInitial,
      vlanInterfaceName: `${parentInterfaceInitial}.${vid}`,
      ips: [],
    };
    plan.vlanIps.set(vid, entry);
  }
  entry.ips.push(ipPlan);
}

export function prepareBondingDecision(interfacePlans: InterfacePlan[]): BondDecision {
  const decision: BondDecision = {
    shouldBond: false,
    anchor: null,
    prefix: null,
    gateway: null,
    gatewayRoutingPriority: null,
    members: [],
  };

  for (const plan of interfacePlans) {
    if (!plan.iface.enabled) continue;
    const allIps = [...plan.configuredIps, ...[...plan.vlanIps.values()].flatMap((v) => v.ips)];
    for (const ipPlan of allIps) {
      // Bond only on VALID bondParameters (same schema the renderer uses): a malformed value is
      // treated as "no bond" — matching the API's null — not a fail-open bond0 with empty parameters.
      if (!BondParametersSchema.safeParse(ipPlan.prefix.bondParameters).success) continue;
      if (
        !decision.shouldBond ||
        (ipPlan.router !== null && hasBondMembers(interfacePlans, ipPlan.prefix.id, plan.iface.type))
      ) {
        decision.shouldBond = true;
        decision.anchor = plan.iface;
        decision.prefix = ipPlan.prefix;
        decision.gateway = ipPlan.router;
        decision.gatewayRoutingPriority = ipPlan.routingPriority;
      }
      if (decision.gateway !== null) break;
    }
    if (decision.gateway !== null) break;
  }

  if (!decision.shouldBond || !decision.anchor) return decision;

  const anchorType = decision.anchor.type;
  const anchorPrefixId = decision.prefix!.id;
  const members: DeviceInterface[] = [];
  for (const plan of interfacePlans) {
    if (!plan.iface.enabled) continue;
    if (plan.iface.type !== anchorType) continue;
    const allIps = [...plan.configuredIps, ...[...plan.vlanIps.values()].flatMap((v) => v.ips)];
    if (allIps.length === 0) {
      members.push(plan.iface);
      continue;
    }
    if (allIps.some((ip) => ip.prefix.id === anchorPrefixId)) {
      members.push(plan.iface);
    }
  }

  if (members.length < 2) {
    decision.shouldBond = false;
    decision.members = [];
    return decision;
  }
  decision.members = members;

  const memberNames = new Set(members.map((m) => m.name));
  for (const plan of interfacePlans) {
    if (!memberNames.has(plan.iface.name)) continue;
    for (const vlan of plan.vlanIps.values()) {
      vlan.parentInterface = 'bond0';
      vlan.vlanInterfaceName = `bond0.${vlan.vlanId}`;
    }
  }

  return decision;
}

export function synthesizeL3Routes(ctx: DeviceContext, interfacePlans: InterfacePlan[]): void {
  const L3_ROUTE_METRIC = 200;
  const byPrefix = new Map<string, typeof ctx.ipam.l3RouteIps>();
  for (const ip of ctx.ipam.l3RouteIps) {
    const arr = byPrefix.get(ip.containingPrefixId) ?? [];
    arr.push(ip);
    byPrefix.set(ip.containingPrefixId, arr);
  }

  function attach(ipPlan: InterfaceIpPlan): void {
    const siblings = byPrefix.get(ipPlan.prefix.id);
    if (!siblings) return;
    for (const sib of siblings) {
      ipPlan.additionalRoutes.push({
        to: sib.routingPrefix,
        via: sib.address,
        metric: L3_ROUTE_METRIC,
      });
    }
  }

  for (const plan of interfacePlans) {
    for (const ipPlan of plan.configuredIps) attach(ipPlan);
    for (const vlan of plan.vlanIps.values()) {
      for (const ipPlan of vlan.ips) attach(ipPlan);
    }
  }
}

export function stripMask(addressWithMask: string): string {
  const idx = addressWithMask.indexOf('/');
  return idx === -1 ? addressWithMask : addressWithMask.slice(0, idx);
}

export function extractMask(cidr: string): string {
  const idx = cidr.indexOf('/');
  return idx === -1 ? '' : cidr.slice(idx + 1);
}

export function isIpv4(addressWithMask: string): boolean {
  const host = stripMask(addressWithMask);
  return !host.includes(':');
}

// Deliberately the mirror image of the shared `ipv4InCidr(ip, cidr)` it wraps — the render
// modules were ported with (cidr, host) order, and silently swapping the two resolves every prefix to nothing.
export function prefixContainsIpv4(cidr: string, host: string): boolean {
  return ipv4InCidr(host, cidr);
}
