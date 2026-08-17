/** Expands `::` zero groups in an abbreviated IPv6 address; returns null if structurally invalid. */
export function expandIpv6(ip: string): string | null {
  const doubleColonCount = (ip.match(/::/g) || []).length;
  if (doubleColonCount > 1) return null;

  let addr = ip;
  // IPv4-mapped tail (::ffff:192.168.0.1): convert the dotted quad to two hex groups first,
  // or the group count is wrong and hex parsing silently truncates at the first dot.
  const lastColon = addr.lastIndexOf(':');
  const tail = addr.slice(lastColon + 1);
  if (tail.includes('.')) {
    const octets = tail.split('.');
    if (octets.length !== 4) return null;
    const nums = octets.map((o) => (/^\d{1,3}$/.test(o) ? Number(o) : -1));
    if (nums.some((n) => n < 0 || n > 255)) return null;
    const hi = ((nums[0] << 8) | nums[1]).toString(16);
    const lo = ((nums[2] << 8) | nums[3]).toString(16);
    addr = `${addr.slice(0, lastColon + 1)}${hi}:${lo}`;
  }
  if (addr.includes('::')) {
    const [left, right] = addr.split('::');
    const leftGroups = left === '' ? [] : left.split(':');
    const rightGroups = right === '' ? [] : right.split(':');
    const missing = 8 - leftGroups.length - rightGroups.length;
    if (missing <= 0) return null;
    const fill = Array.from({ length: missing }, () => '0');
    addr = [...leftGroups, ...fill, ...rightGroups].join(':');
  }
  return addr;
}
