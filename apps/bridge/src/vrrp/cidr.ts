import { isIPv4 } from 'node:net';

// Rejects non-canonical/IPv6 values so a bound VIP never string-mismatches the kernel-canonicalized binding key; keep in sync with the hub's copy in apps/api/src/brokkr-bridge/vrrp/vrrp-atom.schema.ts.
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
