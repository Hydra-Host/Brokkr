import { ipInCidr, isValidIpv4Cidr } from '@repo/utils';

import { discoverIpv4Interfaces } from '../bridge-network/bridge-ip-resolution.service';

import type { DnsPrefixOverrideAtomValue } from './dns-atom-value.schema';
import type { InterfaceIp } from './interfaces';

type LocalInterfaceSource = () => ReadonlyArray<{ name: string; ip: string }>;

/** IPv4 CIDRs of prefixes explicitly force-on (serveDns=true), sorted by prefix id for determinism. */
export function dnsServeCidrs(overrides: ReadonlyMap<string, DnsPrefixOverrideAtomValue>): string[] {
  const cidrs: string[] = [];
  const seen = new Set<string>();
  for (const key of [...overrides.keys()].sort()) {
    const override = overrides.get(key)!;
    if (override.serveDns !== true) continue;
    if (override.cidr === undefined || !isValidIpv4Cidr(override.cidr)) continue;
    if (seen.has(override.cidr)) continue;
    seen.add(override.cidr);
    cidrs.push(override.cidr);
  }
  return cidrs;
}

/** Local NIC IPs contained in a dns-serve prefix CIDR — the extra listen set beyond DHCP-served IPs. */
export function dnsServeInterfaceIps(
  overrides: ReadonlyMap<string, DnsPrefixOverrideAtomValue>,
  discover: LocalInterfaceSource = discoverIpv4Interfaces,
): InterfaceIp[] {
  const cidrs = dnsServeCidrs(overrides);
  if (cidrs.length === 0) return [];

  const result: InterfaceIp[] = [];
  const seen = new Set<string>();
  for (const iface of discover()) {
    if (seen.has(iface.ip)) continue;
    const cidr = cidrs.find((candidate) => ipInCidr(iface.ip, candidate));
    if (cidr === undefined) continue;
    seen.add(iface.ip);
    result.push({ interface: iface.name, ip: iface.ip, cidr });
  }
  return result;
}

export function unionInterfaceIps(primary: readonly InterfaceIp[], extra: readonly InterfaceIp[]): InterfaceIp[] {
  if (extra.length === 0) return [...primary];
  const seen = new Set(primary.map((entry) => entry.ip));
  const result = [...primary];
  for (const entry of extra) {
    if (seen.has(entry.ip)) continue;
    seen.add(entry.ip);
    result.push(entry);
  }
  return result;
}
