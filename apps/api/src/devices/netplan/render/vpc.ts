import { InterfaceType, ServerLifecycleStatus } from '@repo/database';
import type { DeviceContext, PrefixWithRelations } from '../../device-context/device-context.types';
import { compareByName, dedupeByMac, formatScalar, preferConfigured } from '../netplan-builders';
import { extractMask, isIpv4, stripMask, type AdditionalRoute } from '../netplan-planner';
import type { NetplanPhase } from '../netplan.service';
import { mapRoleToNetplanSlug } from './role-slug';
import { deriveVpcLifecycle, type VpcLifecycle } from './vpc-lifecycle';
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
} from './vpc-planner';

// Emit assembly only — resolution/metric rules live in `vpc-planner`, lifecycle
// flags in `vpc-lifecycle`. `vpc-roce` reuses this path with its extra branches enabled.
export function renderVpc(ctx: DeviceContext, phase: NetplanPhase, opts: VpcRenderOptions): string {
  const lifecycle = deriveVpcLifecycle(ctx, phase);
  if (opts.roce && lifecycle.isFailed) {
    return failedDeviceYaml(ctx, ' '.repeat(opts.offset));
  }
  const p = plan(ctx, lifecycle, opts);
  return emit(ctx, p, phase, lifecycle, opts);
}

// vpc-roce only: a FAILED device gets DHCP on its in-band management interface
// and nothing else (roce 31-62); checked before any planning happens.
function failedDeviceYaml(ctx: DeviceContext, OFF: string): string {
  const inband = ctx.device.interfaces.find((i) => i.macAddress && vpcInterfaceTags(ctx, i.id).isInBand);
  if (inband?.macAddress) {
    return (
      [
        'network:',
        `${OFF}  ethernets:`,
        `${OFF}    ${inband.name}:`,
        `${OFF}      match:`,
        `${OFF}        macaddress: ${inband.macAddress.toLowerCase()}`,
        `${OFF}      dhcp4: true`,
        `${OFF}      optional: false`,
        `${OFF}  version: 2`,
      ].join('\n') + '\n'
    );
  }
  return wildcardDhcpYaml(OFF);
}

function wildcardDhcpYaml(OFF: string): string {
  return (
    [
      'network:',
      `${OFF}  ethernets:`,
      `${OFF}    all-interfaces:`,
      `${OFF}      match:`,
      `${OFF}        name: "*"`,
      `${OFF}      dhcp4: true`,
      `${OFF}      optional: true`,
      `${OFF}  version: 2`,
    ].join('\n') + '\n'
  );
}

// One shared renderer: trinity/classic render six spaces deep, vpc-roce four
// and adds three branches of its own.
export interface VpcRenderOptions {
  /** Spaces of extra indentation the template carries into its output. */
  offset: number;
  /** Enable the vpc-roce-only branches: failed-device DHCP, east-west /31s, set-name. */
  roce: boolean;
}
const ETHERNET_DNS = ['1.1.1.1', '8.8.8.8'];
const VLAN_DNS_FALLBACK = ['1.1.1.1', '1.0.0.1'];
const BASE_METRIC = 100;
const EXCLUDED = new Set(['wt0', 'ipmi']);
const NEVER_TAG_ROLES = new Set(['marketplace-hosts', 'decommissioned-hosts', 'discovered-hosts']);

interface VpcIp {
  staticIp: string;
  netmask: string;
  router: string | null;
  routingPriority: number | null;
  role: string;
  prefix: PrefixWithRelations;
  mtu: number | null;
  isNorthSouth: boolean;
  isInBand: boolean;
  /** The interface's own gateway, carried only when in-band (trinity 253). */
  inbandGateway: string | null;
  additionalRoutes: AdditionalRoute[];
}

interface VpcVlanGroup {
  vid: number;
  vlanInterfaceName: string;
  parentInterface: string;
  isNorthSouth: boolean;
  isInBand: boolean;
  ips: VpcIp[];
}

interface DhcpInterface {
  name: string;
  mac: string | null;
  mtu: number | null;
}

interface VpcBond {
  members: string[];
  firstMac: string | null;
  parameters: Record<string, unknown> | null;
  gateway: string | null;
  gatewayRoutingPriority: number | null;
  /** True for the north-south bond, which uses the 50/300 metric rule. */
  isNorthSouth: boolean;
}

interface VpcPlan {
  /** vpc-roce only: interface names tagged `east-west`, and whether each is includable. */
  eastWest: Map<string, { include: boolean; cidrs: string[]; mtu: number | null }>;
  configured: Map<string, VpcIp[]>;
  vlanGroups: Map<string, VpcVlanGroup>;
  dhcpInterfaces: DhcpInterface[];
  bond: VpcBond | null;
  /** Names for the ethernets loop, with their MAC and flags. */
  ethernets: Array<{ name: string; mac: string | null; mtu: number | null; enabled: boolean; markConnected: boolean }>;
}

function eligible(iface: { name: string; type: InterfaceType }): boolean {
  return !EXCLUDED.has(iface.name.toLowerCase()) && iface.type !== InterfaceType.VIRTUAL;
}

function plan(ctx: DeviceContext, lifecycle: VpcLifecycle, opts: VpcRenderOptions): VpcPlan {
  const roleSlug = mapRoleToNetplanSlug(ctx.device.role);

  // North-south bond: enabled, non-virtual, north-south-tagged interfaces. Only
  // bonds at >= 2 and never during a discovery render (trinity 58-72).
  const nsCandidates = ctx.device.interfaces.filter(
    (i) => eligible(i) && i.enabled && vpcInterfaceTags(ctx, i.id).isNorthSouth,
  );
  const nsBonds = nsCandidates.length >= 2 && !lifecycle.isDiscovery;

  const configured = new Map<string, VpcIp[]>();
  const vlanGroups = new Map<string, VpcVlanGroup>();
  const dhcpInterfaces: DhcpInterface[] = [];
  const ethernets: VpcPlan['ethernets'] = [];
  const eastWest = new Map<string, { include: boolean; cidrs: string[]; mtu: number | null }>();
  const cabled = new Set(ctx.cabledInterfaceIds);
  // RoCE east-west is an EXCLUSION (only discovery and inventory drop out), so
  // deprovisioning/offline/active keep their /31 stanzas; FAILED short-circuits earlier.
  const ewIsRoce = opts.roce && ctx.device.zone?.eastWestNetworkType === 'ROCE';
  const shouldIncludeEw =
    ewIsRoce && !lifecycle.isDiscovery && ctx.device.server?.lifecycleStatus !== ServerLifecycleStatus.INVENTORY;
  let regularBond: VpcBond | null = null;

  for (const iface of ctx.device.interfaces) {
    if (!eligible(iface)) continue;
    ethernets.push({
      name: iface.name,
      mac: iface.macAddress ?? null,
      mtu: iface.mtu ?? null,
      enabled: iface.enabled,
      markConnected: iface.markConnected,
    });
    if (!iface.enabled) continue;

    const tags = vpcInterfaceTags(ctx, iface.id);

    // East-west takes over the interface entirely when RoCE is on: it is either
    // emitted with its /31s or skipped, never routed like a normal interface.
    if (ewIsRoce && tags.isEastWest) {
      eastWest.set(iface.name, {
        include: shouldIncludeEw && cabled.has(iface.id),
        // Full CIDR strings, unlike every other block which splits ip/mask.
        cidrs: iface.ipAddresses.filter((ip) => isIpv4(ip.address)).map((ip) => ip.address),
        mtu: iface.mtu ?? null,
      });
      continue;
    }

    const ipv4 = iface.ipAddresses.filter((ip) => isIpv4(ip.address));
    if (ipv4.length === 0) {
      dhcpInterfaces.push({ name: iface.name, mac: iface.macAddress ?? null, mtu: iface.mtu ?? null });
      continue;
    }

    for (const ip of ipv4) {
      const prefix = pickVpcPrefix(ctx, { address: ip.address, vrfId: ip.vrfId ?? null });
      if (!prefix) continue;
      const gateway = vpcGatewayFor(prefix);
      const router = gateway?.gatewayIp ? stripMask(gateway.gatewayIp.address) : null;

      // A discovery render skips north-south config entirely (trinity 224).
      if (lifecycle.isDiscovery && tags.isNorthSouth) continue;

      const vpcIp: VpcIp = {
        staticIp: stripMask(ip.address),
        netmask: extractMask(prefix.prefix),
        router,
        routingPriority: gateway?.routingPriority ?? null,
        role: prefix.prefixRole?.slug ?? 'secondary',
        prefix,
        mtu: iface.mtu ?? null,
        isNorthSouth: tags.isNorthSouth,
        isInBand: tags.isInBand,
        inbandGateway: tags.isInBand ? router : null,
        additionalRoutes: [],
      };

      // The regular bond is discovered from a bondParameters-bearing prefix.
      if (prefix.bondParameters && !regularBond) {
        const members = ctx.device.interfaces
          .filter((m) => eligible(m) && m.enabled && m.type === iface.type)
          .map((m) => m.name);
        regularBond = {
          members,
          firstMac: iface.macAddress ?? null,
          parameters: asRecord(prefix.bondParameters),
          gateway: router,
          gatewayRoutingPriority: gateway?.routingPriority ?? null,
          isNorthSouth: false,
        };
      }

      if (shouldTagVlan(prefix, roleSlug)) {
        // Parent follows the BOND when one applies (trinity 267).
        const parentInterface = regularBond !== null || (nsBonds && tags.isNorthSouth) ? 'bond0' : iface.name;
        const key = `${parentInterface}.${prefix.vlan?.vid}`;
        let group = vlanGroups.get(key);
        if (!group && prefix.vlan) {
          group = {
            vid: prefix.vlan.vid,
            vlanInterfaceName: key,
            parentInterface,
            isNorthSouth: tags.isNorthSouth,
            isInBand: tags.isInBand,
            ips: [],
          };
          vlanGroups.set(key, group);
        }
        group?.ips.push(vpcIp);
      } else {
        const list = configured.get(iface.name) ?? [];
        list.push(vpcIp);
        configured.set(iface.name, list);
      }
    }
  }

  attachL3Routes(ctx, [...configured.values(), ...[...vlanGroups.values()].map((g) => g.ips)].flat());

  // The north-south bond WINS: the Jinja is if/elif, so at most one bonds block.
  let bond: VpcBond | null = null;
  if (nsBonds) {
    const withIps = nsCandidates.find((i) => i.ipAddresses.some((ip) => isIpv4(ip.address))) ?? nsCandidates[0];
    const anchorIps = configured.get(withIps.name) ?? [];
    bond = {
      members: nsCandidates.map((i) => i.name),
      firstMac: withIps.macAddress ?? null,
      parameters: asRecord(anchorIps[0]?.prefix.bondParameters ?? null),
      gateway: anchorIps[0]?.router ?? null,
      gatewayRoutingPriority: anchorIps[0]?.routingPriority ?? null,
      isNorthSouth: true,
    };
  } else if (regularBond) {
    bond = regularBond;
  }

  return { eastWest, configured, vlanGroups, dhcpInterfaces, bond, ethernets };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Same role gate as flat-default (trinity 258-263). */
function shouldTagVlan(prefix: PrefixWithRelations, roleSlug: string | null): boolean {
  if (!prefix.vlan) return false;
  if (prefix.enableVlanTag) return true;
  if (roleSlug === 'brokkr-bridge') return true;
  return roleSlug !== null && !NEVER_TAG_ROLES.has(roleSlug);
}

function attachL3Routes(ctx: DeviceContext, ips: VpcIp[]): void {
  const byPrefix = new Map<string, typeof ctx.ipam.l3RouteIps>();
  for (const r of ctx.ipam.l3RouteIps) {
    const arr = byPrefix.get(r.containingPrefixId) ?? [];
    arr.push(r);
    byPrefix.set(r.containingPrefixId, arr);
  }
  for (const ip of ips) {
    for (const sib of byPrefix.get(ip.prefix.id) ?? []) {
      ip.additionalRoutes.push({ to: sib.routingPrefix, via: sib.address, metric: 200 });
    }
  }
}

// ── Emit ────────────────────────────────────────────────────────────────────

function emit(
  ctx: DeviceContext,
  p: VpcPlan,
  phase: NetplanPhase,
  lifecycle: VpcLifecycle,
  opts: VpcRenderOptions,
): string {
  const OFF = ' '.repeat(opts.offset);
  const hasAnyConfigured =
    p.configured.size > 0 || p.vlanGroups.size > 0 || [...p.eastWest.values()].some((e) => e.include);
  if (!hasAnyConfigured) {
    // Wildcard DHCP fallback (trinity 20-28), at this template's offset.
    return wildcardDhcpYaml(OFF);
  }

  const lines: string[] = ['network:'];
  const metric = { value: BASE_METRIC };
  const bondHasVlans = [...p.vlanGroups.values()].some((g) => g.parentInterface === 'bond0');
  const memberNames = new Set(p.bond?.members ?? []);

  if (p.bond) lines.push(...bondBlock(p.bond, p, bondHasVlans, lifecycle, metric, OFF));

  lines.push(`${OFF}  ethernets:`);
  const anchored = new Set<string>([
    ...(p.bond?.members ?? []),
    ...[...p.vlanGroups.values()].map((g) => g.parentInterface),
  ]);
  const ethernets = dedupeByMac(
    ctx.device.id,
    [...p.ethernets].sort(preferConfigured((e) => p.configured.has(e.name))),
    (e) => e.mac,
    anchored,
  ).sort(compareByName);
  for (const e of ethernets) {
    if (!e.mac) continue; // the Jinja skips MAC-less interfaces entirely
    const mac = e.mac.toLowerCase();

    if (p.bond && memberNames.has(e.name)) {
      lines.push(`${OFF}    ${e.name}:`);
      lines.push(`${OFF}      match:`);
      lines.push(`${OFF}        macaddress: ${mac}`);
      continue;
    }

    const ew = p.eastWest.get(e.name);
    // Not includable -> omitted entirely, not defaulted to DHCP.
    if (ew && !ew.include) continue;
    if (ew) {
      lines.push(`${OFF}    ${e.name}:`);
      lines.push(`${OFF}      match:`);
      lines.push(`${OFF}        macaddress: ${mac}`);
      // Unconditional here, unlike the configured branch below.
      lines.push(`${OFF}      set-name: ${e.name}`);
      lines.push(`${OFF}      dhcp4: false`);
      if (ew.cidrs.length > 0) {
        if (ew.mtu != null) lines.push(`${OFF}      mtu: ${ew.mtu}`);
        lines.push(`${OFF}      addresses:`);
        for (const cidr of ew.cidrs) lines.push(`${OFF}        - ${cidr}`);
      }
      continue;
    }

    const ips = p.configured.get(e.name) ?? [];
    if (ips.length > 0) {
      lines.push(`${OFF}    ${e.name}:`);
      lines.push(`${OFF}      match:`);
      lines.push(`${OFF}        macaddress: ${mac}`);
      // roce emits set-name on everything EXCEPT north-south (roce 757).
      if (opts.roce && !ips.some((ip) => ip.isNorthSouth)) lines.push(`${OFF}      set-name: ${e.name}`);
      lines.push(`${OFF}      dhcp4: false`);
      if (e.mtu != null) lines.push(`${OFF}      mtu: ${e.mtu}`);
      lines.push(`${OFF}      addresses:`);
      for (const ip of ips) lines.push(`${OFF}        - ${ip.staticIp}/${ip.netmask}`);
      lines.push(...ethernetRoutes(ips, lifecycle, metric, OFF));
      lines.push(`${OFF}      nameservers:`);
      lines.push(`${OFF}        addresses:`);
      for (const dns of ETHERNET_DNS) lines.push(`${OFF}          - ${dns}`);
      lines.push(`${OFF}      optional: false`);
      continue;
    }

    const dhcp = p.dhcpInterfaces.find((d) => d.name === e.name);
    if (dhcp) {
      lines.push(`${OFF}    ${e.name}:`);
      lines.push(`${OFF}      match:`);
      lines.push(`${OFF}        macaddress: ${mac}`);
      lines.push(`${OFF}      dhcp4: true`);
      if (e.mtu != null) lines.push(`${OFF}      mtu: ${e.mtu}`);
      lines.push(`${OFF}      optional: false`);
      continue;
    }

    const isVlanParent = [...p.vlanGroups.values()].some((g) => g.parentInterface === e.name);
    lines.push(`${OFF}    ${e.name}:`);
    lines.push(`${OFF}      match:`);
    lines.push(`${OFF}        macaddress: ${mac}`);
    lines.push(`${OFF}      dhcp4: false`);
    lines.push(`${OFF}      optional: ${isVlanParent || (e.enabled && e.markConnected) ? 'false' : 'true'}`);
  }

  if (p.vlanGroups.size > 0) {
    lines.push(`${OFF}  vlans:`);
    for (const g of p.vlanGroups.values()) {
      lines.push(`${OFF}    ${g.vlanInterfaceName}:`);
      lines.push(`${OFF}      id: ${g.vid}`);
      lines.push(`${OFF}      link: ${g.parentInterface}`);
      lines.push(`${OFF}      dhcp4: false`);
      lines.push(`${OFF}      addresses:`);
      for (const ip of g.ips) lines.push(`${OFF}        - ${ip.staticIp}/${ip.netmask}`);
      const mtu = g.ips[0]?.mtu ?? null;
      if (mtu != null) lines.push(`${OFF}      mtu: ${mtu}`);
      const routeLines = vlanRoutes(g, lifecycle, metric, OFF);
      if (routeLines.length > 0) lines.push(...routeLines);
      lines.push(`${OFF}      nameservers:`);
      lines.push(`${OFF}        addresses:`);
      for (const dns of vlanDns(ctx, g, phase)) lines.push(`${OFF}          - ${dns}`);
    }
  }

  lines.push(`${OFF}  version: 2`);
  return lines.join('\n') + '\n';
}

function bondBlock(
  bond: VpcBond,
  p: VpcPlan,
  bondHasVlans: boolean,
  lifecycle: VpcLifecycle,
  metric: { value: number },
  OFF: string,
): string[] {
  const lines = [`${OFF}  bonds:`, `${OFF}    bond0:`, `${OFF}      interfaces:`];
  for (const m of bond.members) lines.push(`${OFF}        - ${m}`);
  lines.push(`${OFF}      parameters:`);
  for (const [k, v] of Object.entries(bond.parameters ?? {})) lines.push(`${OFF}        ${k}: ${formatScalar(v)}`);

  // A bond hosting VLANs stops here — unlike flat-default, which still emits
  // macaddress and mtu.
  if (bondHasVlans) {
    lines.push(`${OFF}      dhcp4: false`);
    return lines;
  }

  lines.push(`${OFF}      dhcp4: false`);
  const bondIps = bond.members.flatMap((m) => p.configured.get(m) ?? []);
  if (bondIps.length > 0) {
    lines.push(`${OFF}      addresses:`);
    for (const ip of bondIps) lines.push(`${OFF}        - ${ip.staticIp}/${ip.netmask}`);
  }
  lines.push(`${OFF}      nameservers:`);
  lines.push(`${OFF}        addresses:`);
  for (const dns of ETHERNET_DNS) lines.push(`${OFF}          - ${dns}`);
  // After nameservers, and NOT lowercased — both per the Jinja.
  if (bond.firstMac) lines.push(`${OFF}      macaddress: ${bond.firstMac}`);
  if (bond.gateway) {
    lines.push(`${OFF}      routes:`);
    lines.push(`${OFF}        - to: 0.0.0.0/0`);
    lines.push(`${OFF}          via: ${bond.gateway}`);
    const m = bond.isNorthSouth
      ? northSouthBondMetric(lifecycle.isDeprovisioning)
      : bondMetric(bond.gatewayRoutingPriority, metric.value);
    lines.push(`${OFF}          metric: ${m}`);
  }
  return lines;
}

function ethernetRoutes(ips: VpcIp[], lifecycle: VpcLifecycle, metric: { value: number }, OFF: string): string[] {
  const inband = ips.find((ip) => ip.isInBand && ip.inbandGateway);
  const hasRoutes =
    ips.some((ip) => ip.router || (ip.additionalRoutes.length > 0 && !ip.isNorthSouth)) || inband !== undefined;
  if (!hasRoutes) return [];

  const lines = [`${OFF}      routes:`];
  for (const ip of dedupeByGateway(ips)) {
    lines.push(`${OFF}        - to: 0.0.0.0/0`);
    lines.push(`${OFF}          via: ${ip.router}`);
    const m = ethernetMetric(
      {
        isNorthSouth: ip.isNorthSouth,
        isInBand: ip.isInBand,
        isDeprovisioning: lifecycle.isDeprovisioning,
        routingPriority: ip.routingPriority,
      },
      metric.value,
    );
    if (m !== null) lines.push(`${OFF}          metric: ${m}`);
    metric.value += 1;
  }
  const extras = dedupeAdditionalRoutes(
    ips
      .filter((ip) => !ip.isNorthSouth)
      .flatMap((ip) => ip.additionalRoutes.map((r) => ({ ...r, inBand: ip.isInBand }))),
  );
  for (const r of extras) {
    lines.push(`${OFF}        - to: ${r.to}`);
    lines.push(`${OFF}          via: ${r.via}`);
    lines.push(`${OFF}          metric: ${additionalRouteMetric(r.metric, r.inBand)}`);
  }
  if (inband?.inbandGateway) {
    lines.push(`${OFF}        - to: ${VPC_INBAND_FALLBACK_ROUTE.to}`);
    lines.push(`${OFF}          via: ${inband.inbandGateway}`);
    lines.push(`${OFF}          metric: ${VPC_INBAND_FALLBACK_ROUTE.metric}`);
  }
  return lines;
}

function vlanRoutes(g: VpcVlanGroup, lifecycle: VpcLifecycle, metric: { value: number }, OFF: string): string[] {
  const inband = g.ips.find((ip) => ip.isInBand && ip.inbandGateway);
  const hasRoutes =
    g.ips.some((ip) => ip.router || (ip.additionalRoutes.length > 0 && !g.isNorthSouth)) || inband !== undefined;
  if (!hasRoutes) return [];

  const lines = [`${OFF}      routes:`];
  for (const ip of dedupeByGateway(g.ips)) {
    lines.push(`${OFF}        - to: 0.0.0.0/0`);
    lines.push(`${OFF}          via: ${ip.router}`);
    lines.push(
      `${OFF}          metric: ${vlanMetric(
        {
          isNorthSouth: g.isNorthSouth,
          isDeprovisioning: lifecycle.isDeprovisioning,
          routingPriority: ip.routingPriority,
          role: ip.role,
        },
        metric.value,
      )}`,
    );
    metric.value += 1;
  }
  if (!g.isNorthSouth) {
    for (const r of dedupeAdditionalRoutes(g.ips.flatMap((ip) => ip.additionalRoutes))) {
      lines.push(`${OFF}        - to: ${r.to}`);
      lines.push(`${OFF}          via: ${r.via}`);
      lines.push(`${OFF}          metric: ${additionalRouteMetric(r.metric, g.isInBand)}`);
    }
  }
  if (inband?.inbandGateway) {
    lines.push(`${OFF}        - to: ${VPC_INBAND_FALLBACK_ROUTE.to}`);
    lines.push(`${OFF}          via: ${inband.inbandGateway}`);
    lines.push(`${OFF}          metric: ${VPC_INBAND_FALLBACK_ROUTE.metric}`);
  }
  return lines;
}

// Local bridge IPs sharing the prefix during a discovery render, else public DNS.
// The 1.0.0.1 fallback genuinely differs from the ethernet block's 8.8.8.8.
function vlanDns(ctx: DeviceContext, g: VpcVlanGroup, phase: NetplanPhase): string[] {
  if (phase !== 'live') return VLAN_DNS_FALLBACK;
  const prefixIds = new Set(g.ips.map((ip) => ip.prefix.id));
  const hits = ctx.ipam.bridgeDeviceIps.filter((b) => prefixIds.has(b.containingPrefixId));
  return hits.length > 0 ? [...new Set(hits.map((b) => b.address))] : VLAN_DNS_FALLBACK;
}
