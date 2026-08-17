/** A bridge binds a VIP only when it is the zone leader AND the atom names an interface for it, which
 *  is the bridge reconciler's own predicate. Intent only — it never claims the VIP is actually bound. */
export function deriveDesiredHolder(leaderHolder: string | null, ifaceByBridge: Record<string, string>): string | null {
  if (leaderHolder === null) return null;
  // own-property only: a bridge named for something on Object.prototype would otherwise look assigned.
  return Object.prototype.hasOwnProperty.call(ifaceByBridge, leaderHolder) ? leaderHolder : null;
}

export interface ShimBinding {
  instanceId: string;
  cidr: string;
}

/** Null in, null out: when nothing observable exists we must not answer "nobody holds it", which is a
 *  measurement. Only a real observation source can produce an empty holder list. */
export function deriveObservedHolders(bindings: ShimBinding[] | null, vip: string): string[] | null {
  if (bindings === null) return null;
  return bindings
    .filter((binding) => binding.cidr === vip)
    .map((binding) => binding.instanceId)
    .sort();
}

/** The shim state dir holds every bridge on the box, not just this zone's, and two zones can carry
 *  the same CIDR — so a holder outside the zone must be dropped before it is reported as one. */
export function scopeHoldersToZone(holders: string[] | null, zoneBridgeIds: Set<string> | null): string[] | null {
  if (holders === null) return null;
  // no bridge list means the zone's membership is unknown, so who holds the address is too
  if (zoneBridgeIds === null) return null;
  return holders.filter((holder) => zoneBridgeIds.has(holder));
}
