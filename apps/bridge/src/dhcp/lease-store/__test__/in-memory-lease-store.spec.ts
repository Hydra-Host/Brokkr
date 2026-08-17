import { describe, expect, it } from 'vitest';

import { InMemoryLeaseStore } from '../in-memory-lease-store.js';
import type { LeaseRecord } from '../lease-record.js';

function record(ip: string, mac: string, expiresAt: number, hostname: string | null = null): LeaseRecord {
  return { ip, mac, hostname, expiresAt };
}

describe('InMemoryLeaseStore', () => {
  it('round-trips put → loadAll', async () => {
    const store = new InMemoryLeaseStore();
    await store.put(record('10.0.0.10', 'aa:bb:cc:dd:ee:ff', 100));
    await store.put(record('10.0.0.11', '11:22:33:44:55:66', 200));
    const all = await store.loadAll();
    expect(all).toHaveLength(2);
    expect(all.map((r) => r.ip).sort()).toEqual(['10.0.0.10', '10.0.0.11']);
  });

  it('put on the same ip upserts (idempotent on ip)', async () => {
    const store = new InMemoryLeaseStore();
    await store.put(record('10.0.0.10', 'aa:bb:cc:dd:ee:ff', 100));
    await store.put(record('10.0.0.10', 'aa:bb:cc:dd:ee:ff', 999));
    const all = await store.loadAll();
    expect(all).toHaveLength(1);
    expect(all[0]!.expiresAt).toBe(999);
  });

  it('delete removes by ip and is a no-op when absent', async () => {
    const store = new InMemoryLeaseStore();
    await store.put(record('10.0.0.10', 'aa:bb:cc:dd:ee:ff', 100));
    await store.delete(record('10.0.0.99', 'unknown', 0));
    expect(await store.loadAll()).toHaveLength(1);
    await store.delete(record('10.0.0.10', 'aa:bb:cc:dd:ee:ff', 100));
    expect(await store.loadAll()).toHaveLength(0);
  });

  it('pruneExpired drops <= now and returns the count', async () => {
    const store = new InMemoryLeaseStore();
    await store.put(record('10.0.0.10', 'aa:bb:cc:dd:ee:ff', 100));
    await store.put(record('10.0.0.11', '11:22:33:44:55:66', 300));
    const dropped = await store.pruneExpired(200);
    expect(dropped).toBe(1);
    const all = await store.loadAll();
    expect(all.map((r) => r.ip)).toEqual(['10.0.0.11']);
  });
});
