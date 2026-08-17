import { isIPv4 } from 'node:net';

export function ipv4ToInt(addr: string): number | null {
  const parts = addr.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    const octet = Number.parseInt(part, 10);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    value = (value * 256 + octet) >>> 0;
  }
  return value;
}

export function isRoutableUnicastIpv4(ip: string): boolean {
  if (!isIPv4(ip)) return false;
  const ipInt = ipv4ToInt(ip);
  if (ipInt === null || ipInt === 0) return false;
  if (ipInt >>> 24 === 127) return false;
  if (ipInt >>> 16 === 0xa9fe) return false;
  if (ipInt >>> 28 === 0xe) return false;
  if (ipInt === 0xffffffff) return false;
  return true;
}
