import { describe, expect, it } from 'vitest';
import { DnsRecordsAtomValueSchema } from '../../../../../bridge/src/dns/dns-records-reader.schema';
import { DnsRecordsAtomSchema } from '../dns-records-atom.schema';

const SHARED_FIXTURES = [
  {
    name: 'forward domain with mixed TTL overrides',
    input: {
      domains: [
        {
          name: 'example.lan',
          type: 'FORWARD' as const,
          records: [
            { name: 'host-a', type: 'A' as const, value: '10.0.0.1', ttl: null },
            { name: 'host-b', type: 'AAAA' as const, value: '2001:db8::1', ttl: 300 },
          ],
        },
      ],
    },
  },
  {
    name: 'reverse domain with PTR records',
    input: {
      domains: [
        {
          name: '0.0.10.in-addr.arpa',
          type: 'REVERSE' as const,
          records: [
            { name: '1', type: 'PTR' as const, value: 'host-a.example.lan', ttl: null },
          ],
        },
      ],
    },
  },
  {
    name: 'multiple domains (forward + reverse)',
    input: {
      domains: [
        {
          name: 'lan',
          type: 'FORWARD' as const,
          records: [
            { name: 'server-1', type: 'A' as const, value: '10.0.1.10', ttl: 60 },
          ],
        },
        {
          name: '1.0.10.in-addr.arpa',
          type: 'REVERSE' as const,
          records: [
            { name: '10', type: 'PTR' as const, value: 'server-1.lan', ttl: null },
          ],
        },
      ],
    },
  },
  {
    name: 'empty domains array',
    input: {
      domains: [],
    },
  },
  {
    name: 'domain with empty records',
    input: {
      domains: [
        {
          name: 'empty.lan',
          type: 'FORWARD' as const,
          records: [],
        },
      ],
    },
  },
  {
    name: 'ttl zero (explicit override to minimum)',
    input: {
      domains: [
        {
          name: 'lan',
          type: 'FORWARD' as const,
          records: [
            { name: 'ephemeral', type: 'A' as const, value: '10.0.0.99', ttl: 0 },
          ],
        },
      ],
    },
  },
];

describe('DNS records atom schema agreement (hub + bridge)', () => {
  for (const fixture of SHARED_FIXTURES) {
    it(`both schemas parse "${fixture.name}" identically`, () => {
      const hubResult = DnsRecordsAtomSchema.safeParse(fixture.input);
      const bridgeResult = DnsRecordsAtomValueSchema.safeParse(fixture.input);

      expect(hubResult.success).toBe(true);
      expect(bridgeResult.success).toBe(true);

      if (hubResult.success && bridgeResult.success) {
        expect(hubResult.data).toEqual(bridgeResult.data);
      }
    });
  }

  it('hub and bridge schemas have the same field names at all nesting levels', () => {
    const hubKeys = Object.keys(DnsRecordsAtomSchema.shape).sort();
    const bridgeKeys = Object.keys(DnsRecordsAtomValueSchema.shape).sort();
    expect(hubKeys).toEqual(bridgeKeys);

    const hubDomainShape = DnsRecordsAtomSchema.shape.domains.element.shape;
    const bridgeDomainShape = DnsRecordsAtomValueSchema.shape.domains.element.shape;
    expect(Object.keys(hubDomainShape).sort()).toEqual(Object.keys(bridgeDomainShape).sort());

    const hubRecordShape = hubDomainShape.records.element.shape;
    const bridgeRecordShape = bridgeDomainShape.records.element.shape;
    expect(Object.keys(hubRecordShape).sort()).toEqual(Object.keys(bridgeRecordShape).sort());
  });

  it('hub schema rejects extra properties (strict mode)', () => {
    const input = { ...SHARED_FIXTURES[0].input, bogus: true };
    const hubResult = DnsRecordsAtomSchema.safeParse(input);
    expect(hubResult.success).toBe(false);
  });

  it('bridge schema allows extra properties (top-level lax for rolling upgrades)', () => {
    const input = { ...SHARED_FIXTURES[0].input, bogus: true };
    const bridgeResult = DnsRecordsAtomValueSchema.safeParse(input);
    expect(bridgeResult.success).toBe(true);
  });

  it('bridge schema allows extra properties on domain objects (nested lax)', () => {
    const input = {
      domains: [
        { ...SHARED_FIXTURES[0].input.domains[0], futureField: 'v2' },
      ],
    };
    const bridgeResult = DnsRecordsAtomValueSchema.safeParse(input);
    expect(bridgeResult.success).toBe(true);
  });

  it('bridge schema allows extra properties on record objects (nested lax)', () => {
    const input = {
      domains: [
        {
          ...SHARED_FIXTURES[0].input.domains[0],
          records: SHARED_FIXTURES[0].input.domains[0].records.map((r) => ({
            ...r,
            futureField: 42,
          })),
        },
      ],
    };
    const bridgeResult = DnsRecordsAtomValueSchema.safeParse(input);
    expect(bridgeResult.success).toBe(true);
  });
});
