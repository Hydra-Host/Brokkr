// shared IPv4 helpers; behavior-identical to local-sim derived.py (_ip_at_offset/node_ip), pinned by ipv4.vectors.json.

// octets reject leading zeros to match Python ipaddress (>=3.9.5) — '010.0.0.1' is not a valid host.
const IPV4_RE = /^(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})$/;

export const isIpv4 = (s: string): boolean => {
  const m = IPV4_RE.exec(s);
  return !!m && m.slice(1).every((o) => Number(o) <= 255);
};

export const ipToInt = (ip: string): number => ip.split('.').reduce((a, o) => (a << 8) + Number(o), 0) >>> 0;

export const intToIp = (n: number): string =>
  [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff].join('.');

export const parseCidr = (cidr: string): { base: number; prefix: number } | null => {
  const slash = cidr.indexOf('/');
  if (slash < 0 || cidr.indexOf('/', slash + 1) >= 0) return null;
  const base = cidr.slice(0, slash);
  const prefixStr = cidr.slice(slash + 1);
  // reject Number()-coercible non-integers ('1e1', ' 24', '+24', '0x18', '24.0') before parsing.
  if (!/^\d{1,2}$/.test(prefixStr) || !isIpv4(base)) return null;
  const prefix = Number(prefixStr);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null;
  return { base: ipToInt(base), prefix };
};

const maskFor = (prefix: number): number => (prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0);

export const networkBase = (cidr: string): number | null => {
  const parsed = parseCidr(cidr);
  if (!parsed) return null;
  return (parsed.base & maskFor(parsed.prefix)) >>> 0;
};

export const ipAtOffset = (cidr: string, offset: number): string => {
  const base = networkBase(cidr);
  if (base === null) return '';
  const addr = base + offset;
  // Python raises on an out-of-space address; don't wrap modulo 2^32 into a silently wrong network.
  // NaN-safe: a bare `addr < 0 || addr > max` lets NaN through (both compares are false).
  if (!(addr >= 0 && addr <= 0xffffffff)) return '';
  return intToIp(addr);
};

export const ipInCidr = (ip: string, cidr: string): boolean => {
  const parsed = parseCidr(cidr);
  if (!isIpv4(ip) || !parsed) return false;
  const mask = maskFor(parsed.prefix);
  return (ipToInt(ip) & mask) >>> 0 === (parsed.base & mask) >>> 0;
};

export const NODE_IP_BASE = 10;
