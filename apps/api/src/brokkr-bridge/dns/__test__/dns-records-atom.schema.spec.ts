import { describe, expect, it } from 'vitest';
import { DnsRecordsAtomSchema } from '../dns-records-atom.schema';

describe('DnsRecordsAtomSchema', () => {
  it('accepts a valid atom with forward and reverse domains', () => {
    const valid = {
      domains: [
        {
          name: 'example.lan',
          type: 'FORWARD',
          records: [
            { name: 'host-a', type: 'A', value: '10.0.0.1', ttl: null },
            { name: 'host-b', type: 'AAAA', value: '::1', ttl: 300 },
          ],
        },
        {
          name: '0.0.10.in-addr.arpa',
          type: 'REVERSE',
          records: [{ name: '1', type: 'PTR', value: 'host-a.example.lan', ttl: null }],
        },
      ],
    };

    expect(() => DnsRecordsAtomSchema.parse(valid)).not.toThrow();
  });

  it('accepts an atom with empty domains array', () => {
    expect(() => DnsRecordsAtomSchema.parse({ domains: [] })).not.toThrow();
  });

  it('accepts a domain with empty records array', () => {
    const valid = {
      domains: [{ name: 'example.lan', type: 'FORWARD', records: [] }],
    };

    expect(() => DnsRecordsAtomSchema.parse(valid)).not.toThrow();
  });

  it('rejects unknown record types', () => {
    const invalid = {
      domains: [
        {
          name: 'example.lan',
          type: 'FORWARD',
          records: [{ name: 'mx', type: 'MX', value: 'mail.example.lan', ttl: null }],
        },
      ],
    };

    expect(() => DnsRecordsAtomSchema.parse(invalid)).toThrow();
  });

  it('rejects unknown domain types', () => {
    const invalid = {
      domains: [{ name: 'example.lan', type: 'UNKNOWN', records: [] }],
    };

    expect(() => DnsRecordsAtomSchema.parse(invalid)).toThrow();
  });

  it('rejects extra fields at the top level (strict)', () => {
    const invalid = { domains: [], extra: true };

    expect(() => DnsRecordsAtomSchema.parse(invalid)).toThrow();
  });

  it('rejects extra fields on a domain object (strict)', () => {
    const invalid = {
      domains: [{ name: 'example.lan', type: 'FORWARD', records: [], extra: true }],
    };

    expect(() => DnsRecordsAtomSchema.parse(invalid)).toThrow();
  });

  it('rejects extra fields on a record object (strict)', () => {
    const invalid = {
      domains: [
        {
          name: 'example.lan',
          type: 'FORWARD',
          records: [{ name: 'host-a', type: 'A', value: '10.0.0.1', ttl: null, extra: true }],
        },
      ],
    };

    expect(() => DnsRecordsAtomSchema.parse(invalid)).toThrow();
  });

  it('rejects negative ttl values', () => {
    const invalid = {
      domains: [
        {
          name: 'example.lan',
          type: 'FORWARD',
          records: [{ name: 'host-a', type: 'A', value: '10.0.0.1', ttl: -1 }],
        },
      ],
    };

    expect(() => DnsRecordsAtomSchema.parse(invalid)).toThrow();
  });

  it('rejects non-integer ttl values', () => {
    const invalid = {
      domains: [
        {
          name: 'example.lan',
          type: 'FORWARD',
          records: [{ name: 'host-a', type: 'A', value: '10.0.0.1', ttl: 3.5 }],
        },
      ],
    };

    expect(() => DnsRecordsAtomSchema.parse(invalid)).toThrow();
  });
});
