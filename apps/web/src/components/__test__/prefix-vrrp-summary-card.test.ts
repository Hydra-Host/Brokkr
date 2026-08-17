import { describe, expect, it } from 'vitest';

import { resolveBindingDisplayNames } from '../prefix-vrrp-summary-card';

describe('resolveBindingDisplayNames', () => {
  it('resolves bridge names from the lookup list', () => {
    const bindings = [{ bridgeId: 'b1', iface: 'eth0' }];
    const bridges = [{ id: 'b1', name: 'bridge-alpha' }];

    expect(resolveBindingDisplayNames(bindings, bridges)).toEqual([
      { bridgeId: 'b1', displayName: 'bridge-alpha', iface: 'eth0' },
    ]);
  });

  it('falls back to bridgeId when bridge is not found', () => {
    const bindings = [{ bridgeId: 'missing', iface: 'eth1' }];

    expect(resolveBindingDisplayNames(bindings, [])).toEqual([
      { bridgeId: 'missing', displayName: 'missing', iface: 'eth1' },
    ]);
  });

  it('returns an empty array for empty bindings', () => {
    expect(resolveBindingDisplayNames([], [{ id: 'b1', name: 'x' }])).toEqual([]);
  });

  it('resolves multiple bindings with mixed hits and misses', () => {
    const result = resolveBindingDisplayNames(
      [
        { bridgeId: 'b1', iface: 'eth0' },
        { bridgeId: 'b2', iface: 'eth1' },
        { bridgeId: 'b3', iface: 'ens224' },
      ],
      [
        { id: 'b1', name: 'bridge-alpha' },
        { id: 'b3', name: 'bridge-gamma' },
      ],
    );
    expect(result).toEqual([
      { bridgeId: 'b1', displayName: 'bridge-alpha', iface: 'eth0' },
      { bridgeId: 'b2', displayName: 'b2', iface: 'eth1' },
      { bridgeId: 'b3', displayName: 'bridge-gamma', iface: 'ens224' },
    ]);
  });

  it('preserves binding order regardless of bridge list order', () => {
    const result = resolveBindingDisplayNames(
      [
        { bridgeId: 'b2', iface: 'eth1' },
        { bridgeId: 'b1', iface: 'eth0' },
      ],
      [
        { id: 'b1', name: 'first' },
        { id: 'b2', name: 'second' },
      ],
    );
    expect(result[0]?.bridgeId).toBe('b2');
    expect(result[1]?.bridgeId).toBe('b1');
  });
});
