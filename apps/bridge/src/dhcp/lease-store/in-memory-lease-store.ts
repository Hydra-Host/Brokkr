import type { LeaseRecord } from './lease-record.js';
import type { LeaseStore } from './lease-store.js';

export class InMemoryLeaseStore implements LeaseStore {
  private readonly leases = new Map<string, LeaseRecord>();

  async loadAll(): Promise<LeaseRecord[]> {
    return [...this.leases.values()];
  }

  async put(lease: LeaseRecord): Promise<void> {
    this.leases.set(lease.ip, lease);
  }

  async delete(lease: LeaseRecord): Promise<void> {
    this.leases.delete(lease.ip);
  }

  // Revocation is a hub->bridge signal carried in Redis; the in-memory store has no hub.
  async takeRevocations(): Promise<string[]> {
    return [];
  }

  async pruneExpired(nowSeconds: number): Promise<number> {
    let dropped = 0;
    for (const [ip, lease] of this.leases) {
      if (lease.expiresAt <= nowSeconds) {
        this.leases.delete(ip);
        dropped += 1;
      }
    }
    return dropped;
  }
}
