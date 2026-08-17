export function ipv4ToInt(ip: string): number | null {
  const octets = ip.split('.');
  if (octets.length !== 4) return null;
  let value = 0;
  for (const octet of octets) {
    if (!/^\d+$/.test(octet)) return null;
    const n = Number(octet);
    if (n > 255 || String(n) !== octet) return null;
    value = (value << 8) | n;
  }
  return value >>> 0;
}

export function ipv4InCidr(ip: string, cidr: string): boolean {
  const slash = cidr.indexOf('/');
  if (slash === -1) return false;
  const maskStr = cidr.slice(slash + 1);
  if (!/^\d+$/.test(maskStr)) return false;
  const bits = Number(maskStr);
  if (bits > 32) return false;
  const net = ipv4ToInt(cidr.slice(0, slash));
  const addr = ipv4ToInt(ip);
  if (net === null || addr === null) return false;
  if (bits === 0) return true;
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return (addr & mask) === (net & mask);
}
