import type { DiscoveryFlavor } from '../download/discovery.config.js';

export type DiscoverySyncOutcome = 'ok' | 'skipped' | 'failed';

export interface DiscoverySyncRecord {
  at: number;
  outcome: DiscoverySyncOutcome;
  error: string | null;
  baseUrl: string;
  version: string;
  flavors: readonly DiscoveryFlavor[];
}

let last: DiscoverySyncRecord | null = null;

export function setDiscoverySyncRecord(record: DiscoverySyncRecord): void {
  last = { ...record, flavors: [...record.flavors] };
}

export function getDiscoverySyncRecord(): DiscoverySyncRecord | null {
  return last;
}

export function resetDiscoverySyncRecordForTests(): void {
  last = null;
}
