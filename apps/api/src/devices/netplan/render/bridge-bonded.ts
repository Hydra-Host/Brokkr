import { InterfaceType } from '@repo/database';
import type { DeviceContext } from '../../device-context/device-context.types';
import { formatScalar } from '../netplan-builders';
import { extractMask, isIpv4, pickPrefixForIp, stripMask, type InterfaceIpPlan } from '../netplan-planner';

/**
 * Port of NetBox `bridge-or-host-netplan-vlan-bond.j2` (template 25, 109 devices).
 *
 * Needs its own planner: bonds are keyed by interface TYPE, so a device can carry
 * several. Emit order and the member-join rule both differ from every sibling
 * generator; each divergence is noted at the site it applies.
 */
export function renderBridgeBonded(ctx: DeviceContext): string {
  return emit(plan(ctx));
}

const NAMESERVERS = ['1.1.1.1', '1.0.0.1'];
const BASE_METRIC = 100;
const SECONDARY_METRIC_OFFSET = 500;
const L3_ROUTE_METRIC = 200;
const EXCLUDED_NAME_LOWER = new Set(['wt0', 'ipmi']);

interface VlanGroup {
  vid: number;
  vlanInterfaceName: string;
  /** `link:` target — the parent interface, or the bond name for bond-attached groups. */
  link: string;
  ips: InterfaceIpPlan[];
}

interface Bond {
  name: string;
  members: Set<string>;
  ips: InterfaceIpPlan[];
  vlanGroups: Map<string, VlanGroup>;
  bondParameters: Record<string, unknown> | null;
}

interface BondedPlan {
  /** Names under `ethernets:`, alphabetical. */
  ethernetNames: string[];
  /** MAC per interface name, for the bond `macaddress` lookup. */
  macByName: Map<string, string | null>;
  configuredIps: Map<string, InterfaceIpPlan[]>;
  bonds: Bond[];
  bondMemberNames: Set<string>;
  deviceVlanGroups: Map<string, VlanGroup>;
}

function plan(ctx: DeviceContext): BondedPlan {
  const cabled = new Set(ctx.cabledInterfaceIds);
  const eligibleForIps = (i: { id: string; name: string; enabled: boolean }): boolean =>
    !EXCLUDED_NAME_LOWER.has(i.name.toLowerCase()) && (i.enabled || cabled.has(i.id));

  const configuredIps = new Map<string, InterfaceIpPlan[]>();
  const deviceVlanGroups = new Map<string, VlanGroup>();
  const bondByType = new Map<InterfaceType, Bond>();
  const bondMemberNames = new Set<string>();
  const macByName = new Map<string, string | null>();
  const allIpPlans: InterfaceIpPlan[] = [];
  let bondCounter = 0;

  for (const iface of ctx.device.interfaces) {
    macByName.set(iface.name, iface.macAddress ?? null);
    if (!eligibleForIps(iface)) continue;

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
      allIpPlans.push(ipPlan);

      const bondParameters = prefix.bondParameters;
      if (bondParameters && typeof bondParameters === 'object' && !Array.isArray(bondParameters)) {
        // One bond per interface type; names follow first-encounter order.
        let bond = bondByType.get(iface.type);
        if (!bond) {
          bond = {
            name: `bond${bondCounter}`,
            members: new Set(),
            ips: [],
            vlanGroups: new Map(),
            bondParameters,
          };
          bondByType.set(iface.type, bond);
          bondCounter += 1;
        }
        // Taken from the first prefix seen for the type, never overwritten.
        bond.bondParameters ??= bondParameters;

        if (prefix.vlan) {
          const key = `${bond.name}.${prefix.vlan.vid}`;
          let group = bond.vlanGroups.get(key);
          if (!group) {
            group = { vid: prefix.vlan.vid, vlanInterfaceName: key, link: bond.name, ips: [] };
            bond.vlanGroups.set(key, group);
          }
          group.ips.push(ipPlan);
        } else {
          bond.ips.push(ipPlan);
        }

        bond.members.add(iface.name);
        bondMemberNames.add(iface.name);
        continue;
      }

      if (prefix.vlan) {
        // A sub-interface with a parent is already named <parent>.<vid>.
        const vlanInterfaceName = iface.parent ? iface.name : `${iface.name}.${prefix.vlan.vid}`;
        const link = iface.parent?.name ?? iface.name;
        let group = deviceVlanGroups.get(vlanInterfaceName);
        if (!group) {
          group = { vid: prefix.vlan.vid, vlanInterfaceName, link, ips: [] };
          deviceVlanGroups.set(vlanInterfaceName, group);
        }
        group.ips.push(ipPlan);
        continue;
      }

      const list = configuredIps.get(iface.name) ?? [];
      list.push(ipPlan);
      configuredIps.set(iface.name, list);
    }
  }

  // Second pass: an IP-LESS non-virtual interface joins the bond for its type.
  // Only IP-less, and this pass requires `enabled` without the cable fallback.
  for (const iface of ctx.device.interfaces) {
    if (EXCLUDED_NAME_LOWER.has(iface.name.toLowerCase()) || !iface.enabled) continue;
    if (iface.ipAddresses.length > 0 || iface.type === InterfaceType.VIRTUAL) continue;
    const bond = bondByType.get(iface.type);
    if (!bond) continue;
    bond.members.add(iface.name);
    bondMemberNames.add(iface.name);
  }

  attachL3Routes(ctx, allIpPlans);

  const ethernetNames = ctx.device.interfaces
    .filter((i) => eligibleForIps(i) && i.type !== InterfaceType.VIRTUAL)
    .map((i) => i.name)
    .sort();

  return {
    ethernetNames,
    macByName,
    configuredIps,
    bonds: [...bondByType.values()],
    bondMemberNames,
    deviceVlanGroups,
  };
}

/** Sibling l3-route IPs in the same prefix become extra static routes. */
function attachL3Routes(ctx: DeviceContext, ipPlans: InterfaceIpPlan[]): void {
  const byPrefix = new Map<string, typeof ctx.ipam.l3RouteIps>();
  for (const routeIp of ctx.ipam.l3RouteIps) {
    const arr = byPrefix.get(routeIp.containingPrefixId) ?? [];
    arr.push(routeIp);
    byPrefix.set(routeIp.containingPrefixId, arr);
  }
  for (const ipPlan of ipPlans) {
    for (const sibling of byPrefix.get(ipPlan.prefix.id) ?? []) {
      ipPlan.additionalRoutes.push({
        to: sibling.routingPrefix,
        via: sibling.address,
        metric: L3_ROUTE_METRIC,
      });
    }
  }
}

function emit(p: BondedPlan): string {
  // version + renderer come first here, before any interface block.
  const lines: string[] = ['network:', '  version: 2', '  renderer: networkd', '  ethernets:'];
  const metric = { value: BASE_METRIC };
  const allVlanGroups = [...p.deviceVlanGroups.values(), ...p.bonds.flatMap((b) => [...b.vlanGroups.values()])];

  for (const name of p.ethernetNames) {
    lines.push(`    ${name}:`);

    if (p.bondMemberNames.has(name)) {
      lines.push('      dhcp4: false');
      lines.push('      optional: true');
      continue;
    }

    const ips = p.configuredIps.get(name) ?? [];
    if (ips.length === 0) {
      const isVlanParent = allVlanGroups.some((g) => g.link === name);
      lines.push(`      dhcp4: ${isVlanParent ? 'false' : 'true'}`);
      lines.push('      optional: true');
      continue;
    }

    lines.push('      dhcp4: false');
    // mtu BEFORE addresses in this template.
    const mtu = ips[0]?.mtu ?? null;
    if (mtu != null) lines.push(`      mtu: ${mtu}`);
    lines.push('      addresses:');
    for (const ip of ips) lines.push(`        - ${ip.staticIp}/${ip.netmask}`);
    lines.push(...routes(ips, metric, { grouped: true, nameservers: 'gated' }));
  }

  if (p.bonds.length > 0) {
    lines.push('  bonds:');
    for (const bond of p.bonds) {
      lines.push(`    ${bond.name}:`);
      const sortedMembers = [...bond.members].sort();
      // Second member ALPHABETICALLY, and emitted before `interfaces:`.
      const macSource = sortedMembers[1];
      const mac = macSource ? p.macByName.get(macSource) : null;
      if (mac) lines.push(`      macaddress: ${mac.toLowerCase()}`);
      lines.push('      interfaces:');
      for (const member of sortedMembers) lines.push(`        - ${member}`);
      if (bond.ips.length > 0) {
        lines.push('      addresses:');
        for (const ip of bond.ips) lines.push(`        - ${ip.staticIp}/${ip.netmask}`);
      }
      lines.push(...routes(bond.ips, metric, { grouped: true, nameservers: 'never' }));
      // Always, unlike the ethernet block above.
      lines.push('      nameservers:');
      lines.push('        addresses:');
      for (const dns of NAMESERVERS) lines.push(`          - ${dns}`);
      if (bond.bondParameters) {
        lines.push('      parameters:');
        for (const [key, value] of Object.entries(bond.bondParameters)) {
          lines.push(`        ${key}: ${formatScalar(value)}`);
        }
      }
      lines.push('      dhcp4: false');
    }
  }

  if (allVlanGroups.length > 0) {
    lines.push('  vlans:');
    for (const group of allVlanGroups) {
      lines.push(`    ${group.vlanInterfaceName}:`);
      lines.push(`      id: ${group.vid}`);
      lines.push(`      link: ${group.link}`);
      lines.push('      dhcp4: false');
      const vlanMtu = group.ips[0]?.mtu ?? null;
      if (vlanMtu != null) lines.push(`      mtu: ${vlanMtu}`);
      lines.push('      addresses:');
      for (const ip of group.ips) lines.push(`        - ${ip.staticIp}/${ip.netmask}`);
      // VLAN routes interleave each IP's default route with its own extras.
      lines.push(...routes(group.ips, metric, { grouped: false, nameservers: 'gated' }));
    }
  }

  return lines.join('\n') + '\n';
}

/**
 * `grouped` emits all default routes then all additional routes (the ethernet and
 * bond blocks); otherwise each IP's default route is followed by its own extras
 * (the vlan block). `nameservers: 'never'` is for the bond, which emits them
 * itself outside the gate.
 */
function routes(
  ips: InterfaceIpPlan[],
  metric: { value: number },
  opts: { grouped: boolean; nameservers: 'gated' | 'never' },
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
  const emitExtras = (ip: InterfaceIpPlan): void => {
    for (const route of ip.additionalRoutes) {
      lines.push(`        - to: ${route.to}`);
      lines.push(`          via: ${route.via}`);
      lines.push(`          metric: ${route.metric}`);
    }
  };

  if (opts.grouped) {
    for (const ip of ips) emitDefault(ip);
    for (const ip of ips) emitExtras(ip);
  } else {
    for (const ip of ips) {
      emitDefault(ip);
      emitExtras(ip);
    }
  }

  if (opts.nameservers === 'gated') {
    lines.push('      nameservers:');
    lines.push('        addresses:');
    for (const dns of NAMESERVERS) lines.push(`          - ${dns}`);
  }
  return lines;
}
