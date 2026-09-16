export const CANONICAL_MAC_REGEX = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/;

// Only 48-bit identifiers canonicalize; anything else (an Infiniband GUID, a partial MAC) is null.
export function canonicalMac(mac: string): string | null {
  const hex = mac.replace(/[^0-9a-f]/gi, '').toLowerCase();
  if (hex.length !== 12) return null;
  const octets: string[] = [];
  for (let i = 0; i < hex.length; i += 2) octets.push(hex.slice(i, i + 2));
  return octets.join(':');
}

export function isCanonicalMac(mac: string): boolean {
  return CANONICAL_MAC_REGEX.test(mac);
}
