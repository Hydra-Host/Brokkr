import type { LeaseRecord } from './lease-record.js';

export interface LeaseStore {
  loadAll(): Promise<LeaseRecord[]>;
  put(lease: LeaseRecord): Promise<void>;
  delete(lease: LeaseRecord): Promise<void>;
  pruneExpired(nowSeconds: number): Promise<number>;
  /** Claim and clear pending operator revocations, returning the IPs to drop. */
  takeRevocations(): Promise<string[]>;
}
