import { describe, expect, it } from 'vitest';

import { BridgePartitioner, ownsDevice } from '../partitioning';

describe('ownsDevice', () => {
  it('empty peers means no owner', () => {
    expect(ownsDevice('dev-1', 'bridge-a', [])).toBe(false);
  });

  it('my id missing from peers means no owner', () => {
    expect(ownsDevice('dev-1', 'bridge-a', ['bridge-b', 'bridge-c'])).toBe(false);
  });

  it('single bridge owns everything', () => {
    for (let i = 0; i < 50; i++) {
      expect(ownsDevice(`dev-${i}`, 'bridge-only', ['bridge-only'])).toBe(true);
    }
  });

  it('exactly one owner per device across four peers', () => {
    const peers = ['bridge-a', 'bridge-b', 'bridge-c', 'bridge-d'];
    for (let i = 0; i < 200; i++) {
      const owners = peers.filter((p) => ownsDevice(`dev-${i}`, p, peers));
      expect(owners.length).toBe(1);
    }
  });

  it('decision is independent of peer input order', () => {
    const unsorted = ['bridge-c', 'bridge-a', 'bridge-d', 'bridge-b'];
    const sorted = [...unsorted].sort();
    for (let i = 0; i < 100; i++) {
      expect(ownsDevice(`dev-${i}`, 'bridge-b', unsorted)).toBe(ownsDevice(`dev-${i}`, 'bridge-b', sorted));
    }
  });

  it('roughly balanced across four peers over 1000 devices', () => {
    const peers = ['bridge-a', 'bridge-b', 'bridge-c', 'bridge-d'];
    const owned: Record<string, number> = Object.fromEntries(peers.map((p) => [p, 0]));
    for (let i = 0; i < 1000; i++) {
      for (const p of peers) {
        if (ownsDevice(`dev-${i}`, p, peers)) owned[p]++;
      }
    }
    for (const p of peers) {
      expect(owned[p]).toBeGreaterThan(150);
      expect(owned[p]).toBeLessThan(350);
    }
  });
});

describe('BridgePartitioner cached reads', () => {
  it('owns() with empty state returns false', () => {
    const partitioner = new BridgePartitioner(() => null);
    expect(partitioner.owns('dev-1')).toBe(false);
    expect(partitioner.peers()).toEqual([]);
  });
});
