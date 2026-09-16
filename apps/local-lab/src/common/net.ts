import { networkInterfaces } from 'node:os';

// Node <18 typed a NIC entry's `family` numeric (4/6); Node 24 + @types/node return 'IPv4'/'IPv6' —
// accept both so the uplink/host-IP NIC lookup survives a family-type flip.
export const isIpv4Family = (family: string | number): boolean => family === 'IPv4' || family === 4;

export interface IfaceCidr {
  ip: string;
  cidr: string | null;
}

/** cidr is null when Node cannot derive a mask for the entry. */
export function resolveIfaceCidr(name: string): IfaceCidr | null {
  if (!name) return null;
  const v4 = (networkInterfaces()[name] ?? []).find((a) => isIpv4Family(a.family) && !a.internal);
  return v4 ? { ip: v4.address, cidr: v4.cidr } : null;
}

export const resolveIfaceIp = (name: string): string => resolveIfaceCidr(name)?.ip ?? '';
