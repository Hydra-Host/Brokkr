import { describe, expect, it } from 'vitest';

import { deriveSeedAddress } from '../seed/vrrp-vip.helpers';

describe('deriveSeedAddress', () => {
  it('derives a host address on the slot-0 data-plane prefix', () => {
    expect(deriveSeedAddress('192.168.200.0/24', 240)).toBe('192.168.200.240');
    expect(deriveSeedAddress('192.168.200.0/24', 241)).toBe('192.168.200.241');
  });

  it('derives host addresses on a slotted zone primary prefix', () => {
    expect(deriveSeedAddress('192.168.203.0/24', 240)).toBe('192.168.203.240');
    expect(deriveSeedAddress('192.168.203.0/24', 241)).toBe('192.168.203.241');
  });

  it('rejects non-/24 prefixes instead of silently deriving the wrong subnet', () => {
    expect(() => deriveSeedAddress('10.0.0.0/16', 240)).toThrow('/24');
    expect(() => deriveSeedAddress('192.168.200.0/22', 240)).toThrow('/24');
  });
});
