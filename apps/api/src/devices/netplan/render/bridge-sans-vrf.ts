import { InterfaceType, TagObjectType } from '@repo/database';
import type { DeviceContext, PrefixWithRelations } from '../../device-context/device-context.types';
import {
  extractMask,
  isIpv4,
  prefixContainsIpv4,
  stripMask,
  synthesizeL3Routes,
  type InterfaceIpPlan,
  type InterfacePlan,
} from '../netplan-planner';

/**
 * Port of NetBox `brokkr-bridge-netplan-sans-vrf.j2` (template 20, 9 devices).
 *
 * A bridge renderer like `bridge-default` but VRF-agnostic, with `bridge-primary`
 * and `oob-upstream` tag behaviours of its own — each noted at its site, because
 * most of them read like they should match `bridge-default` and do not. Output is
 * indented ten spaces: the template was pasted into NetBox pre-indented.
 */
export function renderBridgeSansVrf(ctx: DeviceContext): string {
  const plans = planInterfaces(ctx);
  synthesizeL3Routes(ctx, plans);
  return emit(ctx, plans);
}

const NAMESERVERS = ['1.1.1.1', '1.0.0.1'];
const BASE_METRIC = 100;
const SECONDARY_METRIC_OFFSET = 500;
const EXCLUDED_NAME_LOWER = new Set(['wt0', 'ipmi']);

/** The literal route a `bridge-primary` interface carries. Constants in the template, not data. */
const BRIDGE_PRIMARY_ROUTE = { to: '10.0.0.0/12', via: '10.2.0.1' };

/** Every emitted line below `network:` sits at this depth. */
const IND = ' '.repeat(10);

/**
 * This template needs one extra per-IP flag. Carried on the plan object itself
 * rather than a side map — a generator is pure, and module-level mutable state
 * would be shared across renders.
 */
type SansVrfIp = InterfaceIpPlan & { isOobUpstream: boolean };

interface SansVrfPlan extends InterfacePlan {
  hasMac: boolean;
  isEnabled: boolean;
  isBridgePrimary: boolean;
}

function tagSlugsFor(ctx: DeviceContext, objectType: TagObjectType, objectId: string): Set<string> {
  return new Set(
    ctx.tagAssignments
      .filter((ta) => ta.objectType === objectType && ta.objectId === objectId)
      .map((ta) => ta.tag.slug),
  );
}

/**
 * VRF-agnostic prefix pick: first containing prefix carrying any gateway,
 * otherwise the most specific containing prefix.
 */
function pickPrefix(ctx: DeviceContext, host: string): PrefixWithRelations | null {
  const candidates = ctx.ipam.prefixes.filter((p) => prefixContainsIpv4(p.prefix, host));
  if (candidates.length === 0) return null;
  const withGateway = candidates.find((p) => p.gateways.length > 0);
  if (withGateway) return withGateway;
  return candidates.reduce((best, p) => (Number(extractMask(p.prefix)) > Number(extractMask(best.prefix)) ? p : best));
}

function planInterfaces(ctx: DeviceContext): SansVrfPlan[] {
  const plans: SansVrfPlan[] = [];

  for (const iface of ctx.device.interfaces) {
    if (EXCLUDED_NAME_LOWER.has(iface.name.toLowerCase())) continue;
    if (iface.type === InterfaceType.VIRTUAL) continue;

    const ifaceTags = tagSlugsFor(ctx, TagObjectType.INTERFACE, iface.id);
    const plan: SansVrfPlan = {
      iface,
      configuredIps: [],
      vlanIps: new Map(),
      hasMac: Boolean(iface.macAddress),
      isEnabled: iface.enabled,
      isBridgePrimary: ifaceTags.has('bridge-primary'),
    };

    for (const ip of iface.ipAddresses) {
      if (!isIpv4(ip.address)) continue;
      const host = stripMask(ip.address);
      const prefix = pickPrefix(ctx, host);
      if (!prefix) continue;

      // No VRF filter — the template takes the prefix's first gateway.
      const gateway = prefix.gateways[0] ?? null;
      const ipPlan: SansVrfIp = {
        staticIp: host,
        netmask: extractMask(prefix.prefix),
        router: gateway?.gatewayIp ? stripMask(gateway.gatewayIp.address) : null,
        routingPriority: gateway?.routingPriority ?? null,
        role: prefix.prefixRole?.slug ?? 'secondary',
        prefix,
        mtu: iface.mtu ?? null,
        additionalRoutes: [],
        isOobUpstream: tagSlugsFor(ctx, TagObjectType.PREFIX, prefix.id).has('oob-upstream'),
      };

      if (prefix.vlan) {
        const suffix = `.${prefix.vlan.vid}`;
        const vlanInterfaceName = iface.name.endsWith(suffix) ? iface.name : `${iface.name}${suffix}`;
        let entry = plan.vlanIps.get(prefix.vlan.vid);
        if (!entry) {
          entry = {
            vlanId: prefix.vlan.vid,
            vlanName: prefix.vlan.name,
            parentInterface: iface.parent?.name ?? iface.name,
            vlanInterfaceName,
            ips: [],
          };
          plan.vlanIps.set(prefix.vlan.vid, entry);
        }
        entry.ips.push(ipPlan);
      } else {
        plan.configuredIps.push(ipPlan);
      }
    }
    plans.push(plan);
  }
  return plans;
}

const isOob = (ip: InterfaceIpPlan): boolean => 'isOobUpstream' in ip && ip.isOobUpstream === true;

function emit(ctx: DeviceContext, plans: SansVrfPlan[]): string {
  const lines: string[] = ['network:', `${IND}ethernets:`];
  const sorted = [...plans].sort((a, b) => a.iface.name.localeCompare(b.iface.name));
  const vlanEntries = plans.flatMap((p) => (p.vlanIps.size > 0 ? [{ plan: p, groups: [...p.vlanIps.values()] }] : []));
  const allVlanGroups = vlanEntries.flatMap((e) => e.groups);
  const metric = { value: BASE_METRIC };

  for (const plan of sorted) {
    const name = plan.iface.name;
    lines.push(`${IND}  ${name}:`);
    if (plan.hasMac && plan.iface.macAddress) {
      lines.push(`${IND}    match:`);
      lines.push(`${IND}      macaddress: ${plan.iface.macAddress.toLowerCase()}`);
      lines.push(`${IND}    set-name: ${name}`);
    }

    if (plan.configuredIps.length === 0) {
      const isVlanParent = allVlanGroups.some((g) => g.parentInterface === name);
      lines.push(`${IND}    dhcp4: ${isVlanParent ? 'false' : 'true'}`);
      lines.push(`${IND}    optional: ${plan.isEnabled ? 'false' : 'true'}`);
      continue;
    }

    lines.push(`${IND}    dhcp4: false`);
    lines.push(`${IND}    addresses:`);
    for (const ip of plan.configuredIps) lines.push(`${IND}      - ${ip.staticIp}/${ip.netmask}`);
    const mtu = plan.configuredIps[0]?.mtu ?? null;
    if (mtu != null) lines.push(`${IND}    mtu: ${mtu}`);
    lines.push(...routeBlock(plan.configuredIps, metric, plan.isBridgePrimary, false));
    // Always emitted, unlike nameservers — it sits outside the routes gate.
    lines.push(`${IND}    optional: ${plan.isEnabled ? 'false' : 'true'}`);
  }

  if (allVlanGroups.length > 0) {
    lines.push(`${IND}vlans:`);
    for (const { plan, groups } of vlanEntries) {
      for (const group of groups) {
        lines.push(`${IND}  ${group.vlanInterfaceName}:`);
        lines.push(`${IND}    id: ${group.vlanId}`);
        lines.push(`${IND}    link: ${group.parentInterface}`);
        lines.push(`${IND}    dhcp4: false`);
        lines.push(`${IND}    addresses:`);
        for (const ip of group.ips) lines.push(`${IND}      - ${ip.staticIp}/${ip.netmask}`);
        const vlanMtu = group.ips[0]?.mtu ?? null;
        if (vlanMtu != null) lines.push(`${IND}    mtu: ${vlanMtu}`);
        lines.push(...routeBlock(group.ips, metric, plan.isBridgePrimary, true));
        lines.push(`${IND}    optional: ${plan.isEnabled ? 'false' : 'true'}`);
      }
    }
  }

  lines.push(`${IND}renderer: networkd`);
  lines.push(`${IND}version: 2`);
  return lines.join('\n') + '\n';
}

function routeBlock(
  ips: InterfaceIpPlan[],
  metric: { value: number },
  isBridgePrimary: boolean,
  interleaveAdditional: boolean,
): string[] {
  // bridge-primary opens the block on its own, even with no gateway.
  const hasRoutes = isBridgePrimary || ips.some((ip) => ip.router || ip.additionalRoutes.length > 0);
  if (!hasRoutes) return [];

  const lines: string[] = [`${IND}    routes:`];
  const emitDefault = (ip: InterfaceIpPlan): void => {
    if (!ip.router) return;
    lines.push(`${IND}      - to: 0.0.0.0/0`);
    lines.push(`${IND}        via: ${ip.router}`);
    // oob-upstream removes the metric line; the counter still advances.
    if (!isOob(ip)) {
      const value =
        ip.routingPriority ?? (ip.role === 'primary' ? metric.value : metric.value + SECONDARY_METRIC_OFFSET);
      lines.push(`${IND}        metric: ${value}`);
    }
    metric.value += 1;
  };
  const emitAdditional = (ip: InterfaceIpPlan): void => {
    for (const route of ip.additionalRoutes) {
      lines.push(`${IND}      - to: ${route.to}`);
      lines.push(`${IND}        via: ${route.via}`);
      lines.push(`${IND}        metric: ${route.metric}`);
    }
  };

  if (interleaveAdditional) {
    for (const ip of ips) {
      emitDefault(ip);
      emitAdditional(ip);
    }
  } else {
    for (const ip of ips) emitDefault(ip);
    for (const ip of ips) emitAdditional(ip);
  }

  if (isBridgePrimary) {
    lines.push(`${IND}      - to: ${BRIDGE_PRIMARY_ROUTE.to}`);
    lines.push(`${IND}        via: ${BRIDGE_PRIMARY_ROUTE.via}`);
  }

  lines.push(`${IND}    nameservers:`);
  lines.push(`${IND}      addresses:`);
  for (const dns of NAMESERVERS) lines.push(`${IND}        - ${dns}`);
  return lines;
}
