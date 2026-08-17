import { InterfaceType } from '@repo/database';
import type { DeviceContext } from '../../device-context/device-context.types';
import {
  extractMask,
  isIpv4,
  pickPrefixForIp,
  stripMask,
  synthesizeL3Routes,
  type InterfaceIpPlan,
  type InterfacePlan,
} from '../netplan-planner';

/**
 * Only the fields these helpers actually read.
 *
 * Not `DeviceContext['device']['interfaces'][number]`: that resolves to an
 * intersection of two array types, and `.filter()` picks one member's signature,
 * so the callback parameter silently loses the raw-SQL enrichment and stops
 * matching. Narrowing to the used fields sidesteps it and documents the
 * dependency.
 */
type EligibilityFields = { id: string; name: string; enabled: boolean };
type VlanNamingFields = { name: string; parent: { name: string } | null };

/**
 * Port of NetBox `brokkr-bridge-netplan.j2` (template 8, 164 devices).
 *
 * Its own planner and emitter rather than flags on `flat-default`: the two differ
 * in six ways that are easy to cross-contaminate, each noted at the site it
 * applies. `hypervisor_tags_vlan` is deliberately not ported.
 */
export function renderBridgeDefault(ctx: DeviceContext): string {
  const plans = planBridgeInterfaces(ctx);
  synthesizeL3Routes(ctx, plans);
  return emit(ctx, plans);
}

const NAMESERVERS = ['1.1.1.1', '1.0.0.1'];
const BASE_METRIC = 100;
const SECONDARY_METRIC_OFFSET = 500;

const EXCLUDED_NAME_LOWER = new Set(['wt0', 'ipmi']);

/**
 * `name != "wt0" and name.lower() != "ipmi" and (enabled or cable)`.
 *
 * Note this does NOT exclude virtual interfaces — a virtual interface carrying
 * IPs still contributes VLAN configs. Virtual interfaces are excluded only from
 * the `ethernets:` list (see `ethernetNames`).
 */
function isEligible(iface: EligibilityFields, cabled: Set<string>): boolean {
  if (EXCLUDED_NAME_LOWER.has(iface.name.toLowerCase())) return false;
  return iface.enabled || cabled.has(iface.id);
}

function planBridgeInterfaces(ctx: DeviceContext): InterfacePlan[] {
  const cabled = new Set(ctx.cabledInterfaceIds);
  const plans: InterfacePlan[] = [];

  for (const iface of ctx.device.interfaces) {
    if (!isEligible(iface, cabled)) continue;
    const plan: InterfacePlan = { iface, configuredIps: [], vlanIps: new Map() };

    for (const ip of iface.ipAddresses) {
      if (!isIpv4(ip.address)) continue;
      const prefix = pickPrefixForIp(ctx, ip, ip.vrfId ?? null);
      if (!prefix) continue;

      const vrfId = ip.vrfId ?? prefix.vrfId ?? null;
      const gateway = vrfId ? (prefix.gateways.find((g) => g.vrfId === vrfId) ?? null) : null;
      const ipPlan: InterfaceIpPlan = {
        staticIp: stripMask(ip.address),
        netmask: extractMask(prefix.prefix),
        router: gateway?.gatewayIp ? stripMask(gateway.gatewayIp.address) : null,
        routingPriority: gateway?.routingPriority ?? null,
        role: prefix.prefixRole?.slug ?? 'secondary',
        prefix,
        mtu: iface.mtu ?? null,
        additionalRoutes: [],
      };

      // A prefix with a VLAN always tags here — no role gate, unlike flat.
      if (prefix.vlan) {
        addToVlanGroup(plan, iface, prefix.vlan.vid, prefix.vlan.name, ipPlan);
      } else {
        plan.configuredIps.push(ipPlan);
      }
    }
    plans.push(plan);
  }
  return plans;
}

/**
 * VLAN naming mirrors the Jinja: an interface already named `<parent>.<vid>` is
 * used as-is rather than getting a second suffix, and the link points at the
 * interface's `parent` relation when it has one.
 */
function addToVlanGroup(
  plan: InterfacePlan,
  iface: VlanNamingFields,
  vid: number,
  vlanName: string,
  ipPlan: InterfaceIpPlan,
): void {
  const suffix = `.${vid}`;
  const vlanInterfaceName = iface.name.endsWith(suffix) ? iface.name : `${iface.name}${suffix}`;
  const parentInterface = iface.parent?.name ?? iface.name;

  let entry = plan.vlanIps.get(vid);
  if (!entry) {
    entry = { vlanId: vid, vlanName, parentInterface, vlanInterfaceName, ips: [] };
    plan.vlanIps.set(vid, entry);
  }
  entry.ips.push(ipPlan);
}

/** Interfaces that appear under `ethernets:` — eligible AND non-virtual, sorted. */
function ethernetNames(ctx: DeviceContext): string[] {
  const cabled = new Set(ctx.cabledInterfaceIds);
  return ctx.device.interfaces
    .filter((i) => isEligible(i, cabled) && i.type !== InterfaceType.VIRTUAL)
    .map((i) => i.name)
    .sort();
}

function emit(ctx: DeviceContext, plans: InterfacePlan[]): string {
  const lines: string[] = ['network:', '  ethernets:'];
  const planByName = new Map(plans.map((p) => [p.iface.name, p]));
  const vlanGroups = plans.flatMap((p) => [...p.vlanIps.values()]);
  // Shared across both blocks — the Jinja threads one `ns.metric` through.
  const metric = { value: BASE_METRIC };

  for (const name of ethernetNames(ctx)) {
    const configuredIps = planByName.get(name)?.configuredIps ?? [];

    if (configuredIps.length === 0) {
      // A VLAN parent must not DHCP; everything else does.
      const isVlanParent = vlanGroups.some((g) => g.parentInterface === name);
      lines.push(`    ${name}:`);
      lines.push(`      dhcp4: ${isVlanParent ? 'false' : 'true'}`);
      continue;
    }

    lines.push(`    ${name}:`);
    lines.push('      dhcp4: false');
    lines.push('      addresses:');
    for (const ip of configuredIps) lines.push(`        - ${ip.staticIp}/${ip.netmask}`);
    const mtu = configuredIps[0]?.mtu ?? null;
    if (mtu != null) lines.push(`      mtu: ${mtu}`);
    lines.push(...routeBlock(configuredIps, metric));
  }

  if (vlanGroups.length > 0) {
    lines.push('  vlans:');
    for (const group of vlanGroups) {
      lines.push(`    ${group.vlanInterfaceName}:`);
      lines.push(`      id: ${group.vlanId}`);
      lines.push(`      link: ${group.parentInterface}`);
      lines.push('      dhcp4: false');
      lines.push('      addresses:');
      for (const ip of group.ips) lines.push(`        - ${ip.staticIp}/${ip.netmask}`);
      const vlanMtu = group.ips[0]?.mtu ?? null;
      if (vlanMtu != null) lines.push(`      mtu: ${vlanMtu}`);
      // VLAN routes interleave each IP's default route with its own additional
      // routes; the ethernet block emits all default routes first instead.
      lines.push(...routeBlock(group.ips, metric, { interleaveAdditional: true }));
    }
  }

  lines.push('  renderer: networkd');
  lines.push('  version: 2');
  return lines.join('\n') + '\n';
}

/**
 * `routes:` plus `nameservers:`. Both are inside the Jinja's `has_routes` gate,
 * so an interface with neither a gateway nor an additional route gets no
 * nameservers either.
 */
function routeBlock(
  ips: InterfaceIpPlan[],
  metric: { value: number },
  opts: { interleaveAdditional?: boolean } = {},
): string[] {
  const hasRoutes = ips.some((ip) => ip.router || ip.additionalRoutes.length > 0);
  if (!hasRoutes) return [];

  const lines: string[] = ['      routes:'];
  const emitDefault = (ip: InterfaceIpPlan): void => {
    if (!ip.router) return;
    const value = ip.routingPriority ?? (ip.role === 'primary' ? metric.value : metric.value + SECONDARY_METRIC_OFFSET);
    lines.push('        - to: 0.0.0.0/0');
    lines.push(`          via: ${ip.router}`);
    lines.push(`          metric: ${value}`);
    metric.value += 1;
  };
  const emitAdditional = (ip: InterfaceIpPlan): void => {
    for (const route of ip.additionalRoutes) {
      lines.push(`        - to: ${route.to}`);
      lines.push(`          via: ${route.via}`);
      lines.push(`          metric: ${route.metric}`);
    }
  };

  if (opts.interleaveAdditional) {
    for (const ip of ips) {
      emitDefault(ip);
      emitAdditional(ip);
    }
  } else {
    for (const ip of ips) emitDefault(ip);
    for (const ip of ips) emitAdditional(ip);
  }

  lines.push('      nameservers:');
  lines.push('        addresses:');
  for (const dns of NAMESERVERS) lines.push(`          - ${dns}`);
  return lines;
}
