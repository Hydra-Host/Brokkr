import { describe, expect, it } from 'vitest';
import { DhcpModeSchema, IpamRoleSchema } from '../ipam';
import { ZoneDhcpPrefixSummarySchema, ZoneVrrpPrefixSummarySchema } from '../zones';

describe('ZoneDhcpPrefixSummarySchema', () => {
  const validSummary = {
    prefixId: '550e8400-e29b-41d4-a716-446655440000',
    cidr: '10.0.0.0/24',
    role: 'PRIMARY',
    dhcpMode: 'AUTHORITATIVE',
    dhcpEligible: true,
  };

  it('accepts a valid summary with all fields populated', () => {
    const result = ZoneDhcpPrefixSummarySchema.parse(validSummary);
    expect(result.prefixId).toBe(validSummary.prefixId);
    expect(result.cidr).toBe('10.0.0.0/24');
    expect(result.role).toBe('PRIMARY');
    expect(result.dhcpMode).toBe('AUTHORITATIVE');
    expect(result.dhcpEligible).toBe(true);
  });

  it('accepts null role and null dhcpMode', () => {
    const result = ZoneDhcpPrefixSummarySchema.parse({
      ...validSummary,
      role: null,
      dhcpMode: null,
    });
    expect(result.role).toBeNull();
    expect(result.dhcpMode).toBeNull();
  });

  it('accepts every IpamRole the canonical schema defines', () => {
    for (const role of IpamRoleSchema.options) {
      expect(ZoneDhcpPrefixSummarySchema.parse({ ...validSummary, role }).role).toBe(role);
    }
  });

  it('accepts every DhcpMode the canonical schema defines', () => {
    for (const dhcpMode of DhcpModeSchema.options) {
      expect(ZoneDhcpPrefixSummarySchema.parse({ ...validSummary, dhcpMode }).dhcpMode).toBe(dhcpMode);
    }
  });

  it('rejects an invalid IpamRole', () => {
    expect(() => ZoneDhcpPrefixSummarySchema.parse({ ...validSummary, role: 'INVALID' })).toThrow();
  });

  it('rejects an invalid DhcpMode', () => {
    expect(() => ZoneDhcpPrefixSummarySchema.parse({ ...validSummary, dhcpMode: 'DISABLED' })).toThrow();
  });

  it('rejects missing required fields', () => {
    expect(() => ZoneDhcpPrefixSummarySchema.parse({})).toThrow();
    expect(() => ZoneDhcpPrefixSummarySchema.parse({ prefixId: 'x' })).toThrow();
  });

  it('rejects non-boolean dhcpEligible', () => {
    expect(() => ZoneDhcpPrefixSummarySchema.parse({ ...validSummary, dhcpEligible: 'yes' })).toThrow();
  });

  it('rejects a non-UUID prefixId', () => {
    expect(() => ZoneDhcpPrefixSummarySchema.parse({ ...validSummary, prefixId: 'not-a-uuid' })).toThrow();
    expect(() => ZoneDhcpPrefixSummarySchema.parse({ ...validSummary, prefixId: '123' })).toThrow();
  });
});

describe('ZoneVrrpPrefixSummarySchema', () => {
  const validSummary = {
    prefixId: '550e8400-e29b-41d4-a716-446655440000',
    cidr: '10.0.0.0/24',
    role: 'PRIMARY',
    vip: '10.0.0.1/24',
    ifaceByBridge: { 'bridge-1': 'eth0' },
  };

  it('accepts a valid summary with all fields populated', () => {
    const result = ZoneVrrpPrefixSummarySchema.parse(validSummary);
    expect(result.prefixId).toBe(validSummary.prefixId);
    expect(result.cidr).toBe('10.0.0.0/24');
    expect(result.role).toBe('PRIMARY');
    expect(result.vip).toBe('10.0.0.1/24');
    expect(result.ifaceByBridge).toEqual({ 'bridge-1': 'eth0' });
  });

  it('accepts null role and null vip', () => {
    const result = ZoneVrrpPrefixSummarySchema.parse({
      ...validSummary,
      role: null,
      vip: null,
    });
    expect(result.role).toBeNull();
    expect(result.vip).toBeNull();
  });

  it('accepts an empty ifaceByBridge map', () => {
    const result = ZoneVrrpPrefixSummarySchema.parse({ ...validSummary, ifaceByBridge: {} });
    expect(result.ifaceByBridge).toEqual({});
  });

  it('accepts every IpamRole the canonical schema defines', () => {
    for (const role of IpamRoleSchema.options) {
      expect(ZoneVrrpPrefixSummarySchema.parse({ ...validSummary, role }).role).toBe(role);
    }
  });

  it('rejects an invalid IpamRole', () => {
    expect(() => ZoneVrrpPrefixSummarySchema.parse({ ...validSummary, role: 'INVALID' })).toThrow();
  });

  it('rejects missing required fields', () => {
    expect(() => ZoneVrrpPrefixSummarySchema.parse({})).toThrow();
    expect(() => ZoneVrrpPrefixSummarySchema.parse({ prefixId: 'x' })).toThrow();
  });

  it('rejects a non-UUID prefixId', () => {
    expect(() => ZoneVrrpPrefixSummarySchema.parse({ ...validSummary, prefixId: 'not-a-uuid' })).toThrow();
    expect(() => ZoneVrrpPrefixSummarySchema.parse({ ...validSummary, prefixId: '123' })).toThrow();
  });

  it('rejects non-string values in ifaceByBridge', () => {
    expect(() => ZoneVrrpPrefixSummarySchema.parse({ ...validSummary, ifaceByBridge: { br0: 123 } })).toThrow();
  });
});
