export function isValidIpv4(ip: string): boolean {
  const parts = ip.split('.');
  if (parts.length !== 4) return false;
  return parts.every((part) => {
    if (!/^\d{1,3}$/.test(part)) return false;
    const num = parseInt(part, 10);
    return num >= 0 && num <= 255;
  });
}

export function stripHostMask(address: string): string {
  const slash = address.indexOf('/');
  return slash === -1 ? address : address.slice(0, slash);
}

function ipv4ToNumber(ip: string): number | null {
  if (!isValidIpv4(ip)) return null;
  return ip.split('.').reduce((acc, part) => acc * 256 + parseInt(part, 10), 0);
}

export function cidrMaskLength(cidr: string): number | null {
  const parts = cidr.split('/');
  if (parts.length !== 2) return null;
  const [network, mask] = parts;
  if (network === undefined || mask === undefined || !/^\d{1,2}$/.test(mask) || !isValidIpv4(network)) return null;
  const maskLength = parseInt(mask, 10);
  return maskLength <= 32 ? maskLength : null;
}

export function cidrContainsIpv4(cidr: string, address: string): boolean {
  const maskLength = cidrMaskLength(cidr);
  if (maskLength === null) return false;
  const networkNumber = ipv4ToNumber(stripHostMask(cidr));
  const addressNumber = ipv4ToNumber(stripHostMask(address));
  if (networkNumber === null || addressNumber === null) return false;
  // Division instead of bitwise ops: JS bitwise coerces to signed 32-bit, which flips addresses >= 128.0.0.0.
  const hostBlock = 2 ** (32 - maskLength);
  return Math.floor(networkNumber / hostBlock) === Math.floor(addressNumber / hostBlock);
}

export function findContainingPrefix<T extends { prefix: string; vrfId: string | null }>(
  prefixes: T[],
  address: string,
  vrfId: string | null,
): T | null {
  let best: T | null = null;
  let bestMaskLength = -1;
  for (const candidate of prefixes) {
    if (candidate.vrfId !== vrfId) continue;
    if (!cidrContainsIpv4(candidate.prefix, address)) continue;
    const maskLength = cidrMaskLength(candidate.prefix);
    if (maskLength !== null && maskLength > bestMaskLength) {
      best = candidate;
      bestMaskLength = maskLength;
    }
  }
  return best;
}
