import { describe, expect, it } from 'vitest';

import { deriveDesiredHolder, deriveObservedHolders, scopeHoldersToZone } from '../vrrp-desired';

describe('deriveDesiredHolder', () => {
  it('names the leader when the atom gives it an interface', () => {
    expect(deriveDesiredHolder('spoke', { spoke: 'eth0', 'spoke-2': 'eth1' })).toBe('spoke');
  });

  it('names nobody when the leader is absent from the interface map', () => {
    expect(deriveDesiredHolder('spoke-3', { spoke: 'eth0' })).toBeNull();
  });

  it('names nobody when no bridge holds the lease', () => {
    expect(deriveDesiredHolder(null, { spoke: 'eth0' })).toBeNull();
  });

  it('does not treat an inherited object key as an interface assignment', () => {
    expect(deriveDesiredHolder('toString', {})).toBeNull();
  });
});

describe('deriveObservedHolders', () => {
  it('reports the bridges observed holding the address', () => {
    const holders = deriveObservedHolders(
      [
        { instanceId: 'spoke-2', cidr: '10.0.1.1/24' },
        { instanceId: 'spoke', cidr: '10.0.1.1/24' },
        { instanceId: 'spoke', cidr: '10.0.2.1/24' },
      ],
      '10.0.1.1/24',
    );

    expect(holders).toEqual(['spoke', 'spoke-2']);
  });

  it('reports an observed empty set when the source saw nobody holding it', () => {
    expect(deriveObservedHolders([], '10.0.1.1/24')).toEqual([]);
  });

  it('stays undetermined when there is nothing to observe, never claiming nobody holds it', () => {
    expect(deriveObservedHolders(null, '10.0.1.1/24')).toBeNull();
  });
});

describe('scopeHoldersToZone', () => {
  it('drops a holder that belongs to another zone, since the shim dir is shared', () => {
    expect(scopeHoldersToZone(['spoke', 'other-zone-spoke'], new Set(['spoke']))).toEqual(['spoke']);
  });

  it('keeps a holder inside the zone that the atom never named, which is the divergence to see', () => {
    expect(scopeHoldersToZone(['spoke-2'], new Set(['spoke', 'spoke-2']))).toEqual(['spoke-2']);
  });

  it('stays undetermined when nothing was observed', () => {
    expect(scopeHoldersToZone(null, new Set(['spoke']))).toBeNull();
  });

  it('stays undetermined when the zone membership itself is unknown, rather than reporting unscoped holders', () => {
    expect(scopeHoldersToZone(['spoke'], null)).toBeNull();
  });
});
