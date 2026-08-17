import { describe, expect, it } from 'vitest';

import { extractStaticAddresses } from '../netplan-extract-addresses';

function iface(addresses: string): string {
  return `network:\n  ethernets:\n    eth0:\n      addresses: ${addresses}\n`;
}

describe('extractStaticAddresses — python-falsy parity for addresses', () => {
  it('extracts a normal CIDR address list', () => {
    const out = extractStaticAddresses(iface('[10.0.0.5/24]'));
    expect(out.map((a) => a.ip)).toEqual(['10.0.0.5']);
  });

  it('treats a NaN scalar (YAML .nan) as empty instead of throwing', () => {
    expect(() => extractStaticAddresses(iface('.nan'))).not.toThrow();
    expect(extractStaticAddresses(iface('.nan'))).toEqual([]);
  });

  it.each([
    ['empty list', '[]'],
    ['empty map', '{}'],
    ['null', 'null'],
    ['zero', '0'],
    ['empty string', "''"],
  ])('treats a python-falsy %s addresses value as empty', (_label, scalar) => {
    expect(extractStaticAddresses(iface(scalar))).toEqual([]);
  });
});
