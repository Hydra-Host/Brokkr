import { describe, expect, it } from 'vitest';
import { InterfaceSchema, type Interface } from '../interface';

const UUID = '11111111-1111-4111-8111-111111111111';

const minimal: Interface = {
  name: 'eth0',
  mac_address: '00:11:22:33:44:55',
  mark_connected: true,
  enabled: true,
  mgmt_only: false,
  ip_addresses: [],
};

describe('InterfaceSchema', () => {
  it('accepts a minimal valid object (no type key)', () => {
    expect(InterfaceSchema.safeParse(minimal).success).toBe(true);
  });

  it('accepts a fully-populated object with type and ip_addresses with prefix', () => {
    const full = {
      ...minimal,
      type: 'ETHERNET_10G',
      ip_addresses: [
        {
          id: UUID,
          address: '10.0.0.5/24',
          prefix: {
            id: UUID,
            prefix: '10.0.0.0/24',
            role: 'primary',
          },
        },
      ],
    };
    expect(InterfaceSchema.safeParse(full).success).toBe(true);
  });

  it.each(['name', 'mac_address', 'mark_connected', 'enabled', 'mgmt_only', 'ip_addresses'] as const)(
    'rejects an object missing %s',
    (field) => {
      const { [field]: _, ...rest } = minimal;
      expect(InterfaceSchema.safeParse(rest).success).toBe(false);
    },
  );

  it('accepts type: null', () => {
    expect(InterfaceSchema.safeParse({ ...minimal, type: null }).success).toBe(true);
  });

  it('accepts an ip_address with prefix: null', () => {
    const obj = {
      ...minimal,
      ip_addresses: [{ id: UUID, address: '10.0.0.1/24', prefix: null }],
    };
    expect(InterfaceSchema.safeParse(obj).success).toBe(true);
  });

  it('accepts an ip_address with prefix omitted entirely', () => {
    const obj = {
      ...minimal,
      ip_addresses: [{ id: UUID, address: '10.0.0.1/24' }],
    };
    expect(InterfaceSchema.safeParse(obj).success).toBe(true);
  });

  it('rejects an ip_address that omits id (regression: IPs are always DB rows)', () => {
    const obj = {
      ...minimal,
      ip_addresses: [{ address: '10.0.0.1/24' }],
    };
    expect(InterfaceSchema.safeParse(obj).success).toBe(false);
  });
});
