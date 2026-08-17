import { describe, expect, it } from 'vitest';

import { isIpv4Family } from '../net';

describe('isIpv4Family', () => {
  it('accepts the Node 24 / @types/node string form', () => {
    expect(isIpv4Family('IPv4')).toBe(true);
  });
  it('accepts the legacy numeric form (pre-Node-18 os.networkInterfaces)', () => {
    expect(isIpv4Family(4)).toBe(true);
  });
  it('rejects IPv6 in both forms', () => {
    expect(isIpv4Family('IPv6')).toBe(false);
    expect(isIpv4Family(6)).toBe(false);
  });
});
