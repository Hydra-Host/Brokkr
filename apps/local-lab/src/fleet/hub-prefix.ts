import { insertParamsIntoPath } from '@ts-rest/core';
import { z } from 'zod';

import { contract, IpamPrefixSchema } from '@repo/api-client';
import { intToIpv4, ipInCidr, networkBase, parseCidr } from '@repo/utils';

export const PREFIXES_PATH = contract.listPrefixes.path;

export const HubPrefixSchema = IpamPrefixSchema.pick({ id: true, prefix: true, role: true, zoneId: true });
export type HubPrefix = z.infer<typeof HubPrefixSchema>;
export const HubPrefixListSchema = z.array(HubPrefixSchema);

export const prefixPath = (prefixId: string): string =>
  insertParamsIntoPath({ path: contract.updatePrefix.path, params: { id: prefixId } });

export const dhcpConfigPath = (prefixId: string): string =>
  insertParamsIntoPath({ path: contract.getPrefixDhcpConfig.path, params: { id: prefixId } });

export const bootReadinessPath = (prefixId: string, query: { mac: string; bmcAddress: string | null }): string => {
  const params = new URLSearchParams({ mac: query.mac });
  if (query.bmcAddress) params.set('bmcAddress', query.bmcAddress);
  return `${prefixPath(prefixId)}/boot-readiness?${params.toString()}`;
};

/** Longest-mask hub prefix containing ip: the rule the smoke test and the spoke's iface bind both use. */
export function containingPrefix(prefixes: HubPrefix[], ip: string): HubPrefix | null {
  const hits = prefixes.filter((p) => ipInCidr(ip, p.prefix));
  hits.sort((a, b) => (parseCidr(b.prefix)?.prefix ?? 0) - (parseCidr(a.prefix)?.prefix ?? 0));
  return hits[0] ?? null;
}

/** The NIC's cidr with its host bits cleared, e.g. 172.16.12.60/22 → 172.16.12.0/22. */
export function networkCidr(cidr: string): string | null {
  const parsed = parseCidr(cidr);
  const base = networkBase(cidr);
  return parsed && base !== null ? `${intToIpv4(base)}/${parsed.prefix}` : null;
}
