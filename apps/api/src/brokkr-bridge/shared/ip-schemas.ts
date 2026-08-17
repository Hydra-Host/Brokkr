import { isIPv4 } from 'node:net';

import { z } from 'zod';

/** Validates an IPv4 host/mask CIDR string (e.g. "10.0.1.0/24"). Host must be a valid IPv4 address; mask must be 0..32. */
export function isValidHostMaskCidr(value: string): boolean {
  const slash = value.indexOf('/');
  if (slash === -1) return false;
  const host = value.slice(0, slash);
  const maskStr = value.slice(slash + 1);
  if (!isIPv4(host)) return false;
  if (!/^\d{1,2}$/.test(maskStr)) return false;
  const mask = Number(maskStr);
  return mask >= 0 && mask <= 32;
}

/** Zod schema for an IPv4 CIDR string (host/mask). */
export const cidrSchema = z.string().refine(isValidHostMaskCidr, 'must be IPv4 CIDR, e.g. "10.0.1.0/24"');
