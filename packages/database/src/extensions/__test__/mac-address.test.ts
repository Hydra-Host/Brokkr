import { describe, expect, it } from 'vitest';
import { formatMacAddress, normalizeMacField } from '../mac-address';

describe('formatMacAddress', () => {
  it('canonicalizes 48-bit MACs to lowercase colon form regardless of input separators/case', () => {
    expect(formatMacAddress('AA:BB:CC:DD:EE:01')).toBe('aa:bb:cc:dd:ee:01');
    expect(formatMacAddress('aabbccddee01')).toBe('aa:bb:cc:dd:ee:01');
    expect(formatMacAddress('AA-BB-CC-DD-EE-01')).toBe('aa:bb:cc:dd:ee:01');
    expect(formatMacAddress('aabb.ccdd.ee01')).toBe('aa:bb:cc:dd:ee:01');
  });

  it('leaves non-48-bit identifiers untouched (e.g. Infiniband GUIDs)', () => {
    const guid = '00:02:c9:03:00:1a:2b:3c';
    expect(formatMacAddress(guid)).toBe(guid);
    expect(formatMacAddress('not-a-mac')).toBe('not-a-mac');
  });
});

describe('normalizeMacField', () => {
  it('normalizes the plain string create form', () => {
    const data = { macAddress: 'AA:BB:CC:DD:EE:01', name: 'IPMI' };
    normalizeMacField(data);
    expect(data.macAddress).toBe('aa:bb:cc:dd:ee:01');
  });

  it('normalizes the { set } update form', () => {
    const data = { macAddress: { set: 'AABBCCDDEE01' } };
    normalizeMacField(data);
    expect(data.macAddress.set).toBe('aa:bb:cc:dd:ee:01');
  });

  it('is a no-op for null/absent macAddress (virtual interfaces have none)', () => {
    const nullMac = { macAddress: null };
    normalizeMacField(nullMac);
    expect(nullMac.macAddress).toBeNull();
    expect(() => normalizeMacField(undefined)).not.toThrow();
    expect(() => normalizeMacField({ name: 'wg0' })).not.toThrow();
  });
});
