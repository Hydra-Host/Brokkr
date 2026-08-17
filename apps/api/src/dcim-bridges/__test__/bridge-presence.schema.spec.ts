import { describe, expect, it } from 'vitest';
import { BridgePresenceInterfaceSchema } from '../bridge-presence.schema';

describe('BridgePresenceInterfaceSchema', () => {
  it('accepts a payload without gateway', () => {
    const result = BridgePresenceInterfaceSchema.parse({
      iface: 'eth0',
      mac: 'aa:bb:cc:dd:ee:ff',
      subnet: '10.0.0.0/24',
      ip: '10.0.0.5',
    });

    expect(result).toEqual({
      iface: 'eth0',
      mac: 'aa:bb:cc:dd:ee:ff',
      subnet: '10.0.0.0/24',
      ip: '10.0.0.5',
    });
    expect(result.gateway).toBeUndefined();
  });

  it('accepts a payload with gateway', () => {
    const result = BridgePresenceInterfaceSchema.parse({
      iface: 'eth0',
      mac: 'aa:bb:cc:dd:ee:ff',
      subnet: '10.0.0.0/24',
      ip: '10.0.0.5',
      gateway: '10.0.0.1',
    });

    expect(result.gateway).toBe('10.0.0.1');
  });

  it('rejects a payload missing required fields', () => {
    expect(() =>
      BridgePresenceInterfaceSchema.parse({ iface: 'eth0' }),
    ).toThrow();
  });

  it('strips unknown fields', () => {
    const result = BridgePresenceInterfaceSchema.parse({
      iface: 'eth0',
      mac: 'aa:bb:cc:dd:ee:ff',
      subnet: '10.0.0.0/24',
      ip: '10.0.0.5',
      extra: 'should-be-stripped',
    });

    expect(result).not.toHaveProperty('extra');
  });
});
