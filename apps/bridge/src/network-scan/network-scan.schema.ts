import { isIP } from 'node:net';

import { z } from 'zod';

function ipv4ToInt(s: string): number | null {
  if (isIP(s) !== 4) return null;
  const parts = s.split('.');
  if (parts.length !== 4) return null;
  let val = 0;
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return null;
    val = val * 256 + Number(p);
  }
  return val;
}

function isValidIpv4Netmask(s: string): boolean {
  const val = ipv4ToInt(s);
  if (val === null) return false;
  let foundZero = false;
  for (let i = 31; i >= 0; i--) {
    const bit = Math.floor(val / 2 ** i) & 1;
    if (bit === 0) foundZero = true;
    else if (foundZero) return false;
  }
  return true;
}

function isValidIpv4Hostmask(s: string): boolean {
  const val = ipv4ToInt(s);
  if (val === null) return false;
  let foundZero = false;
  for (let i = 0; i < 32; i++) {
    const bit = Math.floor(val / 2 ** i) & 1;
    if (bit === 0) foundZero = true;
    else if (foundZero) return false;
  }
  return true;
}

export function isCidr(value: string): boolean {
  const slashIdx = value.indexOf('/');
  if (slashIdx === -1) {
    return isIP(value) !== 0;
  }
  const host = value.slice(0, slashIdx);
  const prefix = value.slice(slashIdx + 1);
  const family = isIP(host);
  if (family === 0) return false;
  if (/^\d+$/.test(prefix)) {
    const bits = Number(prefix);
    const max = family === 4 ? 32 : 128;
    return bits >= 0 && bits <= max;
  }
  if (family === 4) {
    return isValidIpv4Netmask(prefix) || isValidIpv4Hostmask(prefix);
  }
  return false;
}

export const networkScanSagaPayloadSchema = z
  .object({
    subnet: z.string().refine(isCidr, { message: 'Invalid CIDR notation' }),
  })
  .strict();

export type NetworkScanSagaPayload = z.infer<typeof networkScanSagaPayloadSchema>;
