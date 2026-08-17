// Written by the DHCP manager's reconcile loop; read by the DNS server's listInterfaces.
// No atoms -> empty array -> DNS binds nothing (hub-authoritative fail-closed).

interface AtomServedIp {
  interface: string;
  ip: string;
  cidr: string;
}

let snapshot: AtomServedIp[] = [];
let servedCidrs: string[] = [];

export function setAtomServedIps(ips: AtomServedIp[], relayedCidrs: string[] = []): void {
  snapshot = ips;
  servedCidrs = [...new Set([...ips.map((entry) => entry.cidr), ...relayedCidrs])];
}

/** Consumed by the bridge DNS server (atom-served-ips slice, !234). */
export function getAtomServedIps(): AtomServedIp[] {
  return snapshot;
}

export function getAtomServedCidrs(): string[] {
  return servedCidrs;
}

export function resetAtomServedIpsForTests(): void {
  snapshot = [];
  servedCidrs = [];
}
