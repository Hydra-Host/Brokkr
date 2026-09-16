// octets reject leading zeros to match Python ipaddress (>=3.9.5) — '010.0.0.1' is not a valid host.
const IPV4_RE = /^(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})$/;

export function isIpv4(s: string): boolean {
  const match = IPV4_RE.exec(s);
  return match !== null && match.slice(1).every((octet) => Number(octet) <= 255);
}

export function ipv4ToInt(ip: string): number | null {
  if (!isIpv4(ip)) return null;
  return ip.split('.').reduce((acc, octet) => (acc << 8) + Number(octet), 0) >>> 0;
}

export function intToIpv4(n: number): string {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff].join('.');
}

// `base` keeps its host bits: a NIC address carries them and callers that want the network mask it.
export function parseCidr(cidr: string): { base: number; prefix: number } | null {
  const slash = cidr.indexOf('/');
  if (slash < 0 || cidr.indexOf('/', slash + 1) >= 0) return null;
  const prefixStr = cidr.slice(slash + 1);
  // reject Number()-coercible non-integers ('1e1', ' 24', '+24', '0x18', '24.0') before parsing.
  if (!/^\d{1,2}$/.test(prefixStr)) return null;
  const prefix = Number(prefixStr);
  if (prefix > 32) return null;
  const base = ipv4ToInt(cidr.slice(0, slash));
  if (base === null) return null;
  return { base, prefix };
}

function maskFor(prefix: number): number {
  return prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
}

export function networkBase(cidr: string): number | null {
  const parsed = parseCidr(cidr);
  if (parsed === null) return null;
  return (parsed.base & maskFor(parsed.prefix)) >>> 0;
}

export function ipAtOffset(cidr: string, offset: number): string {
  const base = networkBase(cidr);
  if (base === null) return '';
  const addr = base + offset;
  // Python raises on an out-of-space address; don't wrap modulo 2^32 into a silently wrong network.
  // NaN-safe: a bare `addr < 0 || addr > max` lets NaN through (both compares are false).
  if (!(addr >= 0 && addr <= 0xffffffff)) return '';
  return intToIpv4(addr);
}

export function ipInCidr(ip: string, cidr: string): boolean {
  const parsed = parseCidr(cidr);
  const addr = ipv4ToInt(ip);
  if (parsed === null || addr === null) return false;
  const mask = maskFor(parsed.prefix);
  return (addr & mask) >>> 0 === (parsed.base & mask) >>> 0;
}

export function isNetworkAddress(cidr: string): boolean {
  const parsed = parseCidr(cidr);
  return parsed !== null && parsed.base === networkBase(cidr);
}

export function isValidIpv4Cidr(cidr: string): boolean {
  return parseCidr(cidr) !== null;
}

export function isRoutableUnicastIpv4(ip: string): boolean {
  const value = ipv4ToInt(ip);
  if (value === null || value === 0) return false;
  if (value >>> 24 === 127) return false;
  if (value >>> 16 === 0xa9fe) return false;
  if (value >>> 28 === 0xe) return false;
  return value !== 0xffffffff;
}
