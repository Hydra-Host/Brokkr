import { Logger } from '@nestjs/common';
import { BondParametersSchema } from '@repo/api-client';
import type { DeviceContext, DeviceWithRelations } from '../device-context/device-context.types';
import {
  hasAnyEligibleIp,
  isEligibleInterface,
  type AdditionalRoute,
  type BondDecision,
  type InterfaceIpPlan,
  type InterfacePlan,
} from './netplan-planner';
import type { NetplanPhase } from './netplan.service';

type DeviceInterface = DeviceWithRelations['interfaces'][number];

const ETHERNET_DNS = ['1.1.1.1', '8.8.8.8'];
const VLAN_DNS_FALLBACK = ['1.1.1.1', '1.0.0.1'];
const BASE_METRIC = 100;
const VLAN_SECONDARY_METRIC_OFFSET = 500;
const logger = new Logger('NetplanBuilders');

export function hasEligibleConfiguredIp(interfaces: DeviceInterface[]): boolean {
  return hasAnyEligibleIp(interfaces);
}

export function buildFallbackDhcpYaml(): string {
  return [
    'network:',
    '  ethernets:',
    '    all-interfaces:',
    '      match:',
    '        name: "*"',
    '      dhcp4: true',
    '      optional: true',
    '  version: 2',
    '',
  ].join('\n');
}

export function renderBondBlock(bond: BondDecision, interfacePlans: InterfacePlan[]): string[] {
  if (!bond.shouldBond || !bond.anchor || !bond.prefix) return [];

  const bondHasVlans = interfacePlans.some((p) => [...p.vlanIps.values()].some((v) => v.parentInterface === 'bond0'));

  const lines: string[] = [];
  lines.push('  bonds:');
  lines.push('    bond0:');
  lines.push('      interfaces:');
  for (const m of bond.members) {
    lines.push(`        - ${m.name}`);
  }
  lines.push('      parameters:');
  // JSONB read raw from Prisma (not via toPrefix), so validate independently against the write-path
  // schema — malformed degrades to no params, matching the API's null (no API/netplan split-brain).
  const parsed = BondParametersSchema.safeParse(bond.prefix.bondParameters);
  for (const [key, value] of Object.entries(parsed.success ? parsed.data : {})) {
    lines.push(`        ${key}: ${formatScalar(value)}`);
  }

  if (bondHasVlans) return lines;

  const memberNames = new Set(bond.members.map((m) => m.name));
  const bondIps: InterfaceIpPlan[] = [];
  for (const plan of interfacePlans) {
    if (!memberNames.has(plan.iface.name)) continue;
    for (const ip of plan.configuredIps) {
      bondIps.push(ip);
    }
  }

  lines.push('      dhcp4: false');
  if (bondIps.length > 0) {
    lines.push('      addresses:');
    for (const ip of bondIps) {
      lines.push(`        - ${ip.staticIp}/${ip.netmask}`);
    }
  }
  lines.push('      nameservers:');
  lines.push('        addresses:');
  for (const dns of ETHERNET_DNS) lines.push(`          - ${dns}`);
  if (bond.anchor.macAddress) {
    lines.push(`      macaddress: ${bond.anchor.macAddress.toLowerCase()}`);
  }
  const seenRoutes = new Set<string>();
  const additionalRoutes = bondIps
    .flatMap((ip) => ip.additionalRoutes)
    .filter((r) => {
      const key = `${r.to}|${r.via}|${r.metric}`;
      if (seenRoutes.has(key)) return false;
      seenRoutes.add(key);
      return true;
    });
  if (bond.gateway || additionalRoutes.length > 0) {
    lines.push('      routes:');
    if (bond.gateway) {
      lines.push('        - to: 0.0.0.0/0');
      lines.push(`          via: ${bond.gateway}`);
      lines.push(`          metric: ${bond.gatewayRoutingPriority ?? BASE_METRIC}`);
    }
    for (const route of additionalRoutes) {
      lines.push(...emitAdditionalRoute(route));
    }
  }
  return lines;
}

// Legacy rows can share a MAC; netplan keys `ethernets` by name, so a duplicate renames the NIC twice.
// First in the given order wins, except `anchored` — the bonds and vlans blocks reference those by name.
export function dedupeByMac<T extends { name: string }>(
  deviceId: string,
  ordered: readonly T[],
  macOf: (item: T) => string | null,
  anchored: ReadonlySet<string>,
): T[] {
  const holderByMac = new Map<string, string>();
  const dropped: string[] = [];
  const kept: T[] = [];
  for (const item of ordered) {
    const raw = macOf(item);
    const mac = raw ? raw.toLowerCase() : null;
    const holder = mac ? holderByMac.get(mac) : undefined;
    if (holder !== undefined && !anchored.has(item.name)) {
      dropped.push(`${item.name} (${mac} already on ${holder})`);
      continue;
    }
    if (mac && holder === undefined) holderByMac.set(mac, item.name);
    kept.push(item);
  }
  if (dropped.length > 0) {
    logger.warn(`Device ${deviceId}: dropped duplicate-MAC interfaces from netplan ethernets: ${dropped.join(', ')}`);
  }
  return kept;
}

// Code-unit order, as a plain `.sort()` on the names gives; localeCompare would reorder mixed-case names.
export function compareByName(a: { name: string }, b: { name: string }): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

// Ordering for dedupeByMac: the upstream eligibility guards count a duplicate's addresses, so dropping
// the address-bearing interface would leave the device with `ethernets` and no addresses.
export function preferConfigured<T extends { name: string }>(hasIp: (item: T) => boolean): (a: T, b: T) => number {
  return (a, b) => {
    const aHasIp = hasIp(a);
    if (aHasIp !== hasIp(b)) return aHasIp ? -1 : 1;
    return compareByName(a, b);
  };
}

export function buildEthernetsBlock(ctx: DeviceContext, interfacePlans: InterfacePlan[], bond: BondDecision): string[] {
  const lines: string[] = ['  ethernets:'];
  const memberNames = new Set(bond.members.map((m) => m.name));
  const planByName = new Map(interfacePlans.map((p) => [p.iface.name, p]));
  const hasIp = (i: DeviceInterface) => (planByName.get(i.name)?.configuredIps.length ?? 0) > 0;
  const anchored = new Set<string>(bond.shouldBond ? memberNames : []);
  for (const plan of interfacePlans) {
    if (plan.vlanIps.size > 0) anchored.add(plan.iface.name);
  }
  // The preference only picks which duplicate survives; emission (and so metric order) stays name-sorted.
  const sortedNames = dedupeByMac(
    ctx.device.id,
    ctx.device.interfaces.filter(isEligibleInterface).sort(preferConfigured(hasIp)),
    (i) => i.macAddress,
    anchored,
  )
    .sort(compareByName)
    .map((i) => i.name);

  const metricCounter = { value: BASE_METRIC };

  for (const name of sortedNames) {
    const plan = planByName.get(name);
    if (!plan) continue;
    const iface = plan.iface;
    if (!iface.macAddress) continue;

    if (bond.shouldBond && memberNames.has(name)) {
      lines.push(`    ${name}:`);
      lines.push('      match:');
      lines.push(`        macaddress: ${iface.macAddress.toLowerCase()}`);
      continue;
    }

    lines.push(`    ${name}:`);
    lines.push('      match:');
    lines.push(`        macaddress: ${iface.macAddress.toLowerCase()}`);

    if (plan.configuredIps.length > 0) {
      lines.push('      dhcp4: false');
      // MTU sits between dhcp4 and addresses.
      if (iface.mtu != null) {
        lines.push(`      mtu: ${iface.mtu}`);
      }
      lines.push('      addresses:');
      for (const ip of plan.configuredIps) {
        lines.push(`        - ${ip.staticIp}/${ip.netmask}`);
      }
      const routeLines = buildEthernetRoutes(plan.configuredIps, metricCounter);
      if (routeLines.length > 0) {
        lines.push('      routes:');
        lines.push(...routeLines);
      }
      lines.push('      nameservers:');
      lines.push('        addresses:');
      for (const dns of ETHERNET_DNS) lines.push(`          - ${dns}`);
      lines.push('      optional: false');
    } else {
      const isVlanParent = interfacePlans.some((p) => [...p.vlanIps.values()].some((v) => v.parentInterface === name));
      const optional = !(isVlanParent || (iface.enabled && iface.markConnected));
      lines.push('      dhcp4: false');
      lines.push(`      optional: ${optional ? 'true' : 'false'}`);
    }
  }
  return lines;
}

function buildEthernetRoutes(ips: InterfaceIpPlan[], metricCounter: { value: number }): string[] {
  const lines: string[] = [];
  for (const ip of ips) {
    if (!ip.router) continue;
    const metric = ip.routingPriority ?? metricCounter.value;
    lines.push('        - to: 0.0.0.0/0');
    lines.push(`          via: ${ip.router}`);
    lines.push(`          metric: ${metric}`);
    metricCounter.value += 1;
  }
  for (const ip of ips) {
    for (const route of ip.additionalRoutes) {
      lines.push(...emitAdditionalRoute(route));
    }
  }
  return lines;
}

function emitAdditionalRoute(route: AdditionalRoute): string[] {
  return [`        - to: ${route.to}`, `          via: ${route.via}`, `          metric: ${route.metric}`];
}

export function buildVlansBlock(ctx: DeviceContext, interfacePlans: InterfacePlan[], phase: NetplanPhase): string[] {
  const groups: { parentName: string; group: ReturnType<typeof groupsFor>[number] }[] = [];
  for (const plan of interfacePlans) {
    for (const g of groupsFor(plan)) {
      groups.push({ parentName: plan.iface.name, group: g });
    }
  }
  if (groups.length === 0) return [];

  const lines: string[] = ['  vlans:'];
  const metricCounter = { value: BASE_METRIC };

  for (const { group } of groups) {
    lines.push(`    ${group.vlanInterfaceName}:`);
    lines.push(`      id: ${group.vlanId}`);
    lines.push(`      link: ${group.parentInterface}`);
    lines.push('      dhcp4: false');
    lines.push('      addresses:');
    for (const ip of group.ips) {
      lines.push(`        - ${ip.staticIp}/${ip.netmask}`);
    }
    const vlanMtu = group.ips[0]?.mtu ?? null;
    if (vlanMtu != null) lines.push(`      mtu: ${vlanMtu}`);

    const routeLines = buildVlanRoutes(group.ips, metricCounter);
    if (routeLines.length > 0) {
      lines.push('      routes:');
      lines.push(...routeLines);
      lines.push('      nameservers:');
      lines.push('        addresses:');
      const dns = resolveVlanDns(ctx, group, phase);
      for (const server of dns) lines.push(`          - ${server}`);
    }
  }
  return lines;
}

function groupsFor(plan: InterfacePlan) {
  return [...plan.vlanIps.values()];
}

function buildVlanRoutes(ips: InterfaceIpPlan[], metricCounter: { value: number }): string[] {
  const lines: string[] = [];
  for (const ip of ips) {
    if (!ip.router) continue;
    let metric: number;
    if (ip.routingPriority != null) {
      metric = ip.routingPriority;
    } else if (ip.role === 'primary') {
      metric = metricCounter.value;
    } else {
      metric = metricCounter.value + VLAN_SECONDARY_METRIC_OFFSET;
    }
    lines.push('        - to: 0.0.0.0/0');
    lines.push(`          via: ${ip.router}`);
    lines.push(`          metric: ${metric}`);
    metricCounter.value += 1;
  }
  for (const ip of ips) {
    for (const route of ip.additionalRoutes) {
      lines.push(...emitAdditionalRoute(route));
    }
  }
  return lines;
}

function resolveVlanDns(ctx: DeviceContext, group: { ips: InterfaceIpPlan[] }, phase: NetplanPhase): string[] {
  if (phase !== 'live') return VLAN_DNS_FALLBACK;
  const prefixIds = new Set(group.ips.map((ip) => ip.prefix.id));
  const matches = ctx.ipam.bridgeDeviceIps.filter((b) => prefixIds.has(b.containingPrefixId));
  if (matches.length === 0) return VLAN_DNS_FALLBACK;
  return [...new Set(matches.map((b) => b.address))];
}

// Exported for the VPC and bonded-bridge renderers, which emit their own
// parameter blocks but must format scalars identically to this one.
export function formatScalar(value: unknown): string {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `[${value.map(formatScalar).join(', ')}]`;
  if (value == null) return 'null';
  const str = String(value);
  if (str.length === 0) return '""';
  if (/^[a-zA-Z0-9._-]+$/.test(str)) return str;
  return JSON.stringify(str);
}
