import { describe, expect, it } from 'vitest';

import { expandIpv6 } from '../ipv6-utils.js';

describe('expandIpv6', () => {
  it('expands :: at the end', () => {
    expect(expandIpv6('2001:db8::')).toBe('2001:db8:0:0:0:0:0:0');
  });

  it('expands :: at the start', () => {
    expect(expandIpv6('::1')).toBe('0:0:0:0:0:0:0:1');
  });

  it('expands :: in the middle', () => {
    expect(expandIpv6('2001:db8::1')).toBe('2001:db8:0:0:0:0:0:1');
  });

  it('returns a full address unchanged', () => {
    expect(expandIpv6('2001:0db8:0000:0000:0000:0000:0000:0001')).toBe('2001:0db8:0000:0000:0000:0000:0000:0001');
  });

  it('rejects multiple :: occurrences', () => {
    expect(expandIpv6('2001::db8::1')).toBeNull();
  });

  it('rejects :: that would produce zero fill (already 8 groups)', () => {
    expect(expandIpv6('1:2:3:4::5:6:7:8')).toBeNull();
  });
});
