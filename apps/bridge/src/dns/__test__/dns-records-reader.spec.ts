import { describe, expect, it } from 'vitest';

import { DnsRecordsLookup } from '../dns-records-reader.js';
import type { DnsRecordsAtomValue } from '../dns-records-reader.schema.js';
import { QTYPE_A, QTYPE_AAAA, QTYPE_PTR } from '../protocol.js';

function makeAtom(overrides: Partial<DnsRecordsAtomValue> = {}): DnsRecordsAtomValue {
  return {
    domains: [],
    ...overrides,
  };
}

describe('DnsRecordsLookup', () => {
  it('returns A record entries for a matching forward domain lookup', () => {
    const atom = makeAtom({
      domains: [
        {
          name: 'lan',
          type: 'FORWARD',
          records: [
            { name: 'server-1', type: 'A', value: '10.0.1.10', ttl: null },
            { name: 'server-1', type: 'A', value: '10.0.1.11', ttl: null },
          ],
        },
      ],
    });

    const lookup = new DnsRecordsLookup(atom);
    const result = lookup.lookup('server-1.lan', QTYPE_A);

    expect(result).toEqual([
      { value: '10.0.1.10', ttl: null },
      { value: '10.0.1.11', ttl: null },
    ]);
  });

  it('returns AAAA record entries for IPv6 lookups', () => {
    const atom = makeAtom({
      domains: [
        {
          name: 'lan',
          type: 'FORWARD',
          records: [{ name: 'server-v6', type: 'AAAA', value: '2001:db8::1', ttl: null }],
        },
      ],
    });

    const lookup = new DnsRecordsLookup(atom);
    const result = lookup.lookup('server-v6.lan', QTYPE_AAAA);

    expect(result).toEqual([{ value: '2001:db8::1', ttl: null }]);
  });

  it('returns PTR record entries for in-addr.arpa lookups', () => {
    const atom = makeAtom({
      domains: [
        {
          name: '1.0.10.in-addr.arpa',
          type: 'REVERSE',
          records: [{ name: '10', type: 'PTR', value: 'server-1.lan', ttl: null }],
        },
      ],
    });

    const lookup = new DnsRecordsLookup(atom);
    const result = lookup.lookup('10.1.0.10.in-addr.arpa', QTYPE_PTR);

    expect(result).toEqual([{ value: 'server-1.lan', ttl: null }]);
  });

  it('returns null for a name that does not exist (NXDOMAIN)', () => {
    const atom = makeAtom({
      domains: [
        {
          name: 'lan',
          type: 'FORWARD',
          records: [{ name: 'server-1', type: 'A', value: '10.0.1.10', ttl: null }],
        },
      ],
    });

    const lookup = new DnsRecordsLookup(atom);

    expect(lookup.lookup('nonexistent.lan', QTYPE_A)).toBeNull();
  });

  it('returns null for a name that exists but with a different qtype', () => {
    const atom = makeAtom({
      domains: [
        {
          name: 'lan',
          type: 'FORWARD',
          records: [{ name: 'server-1', type: 'A', value: '10.0.1.10', ttl: null }],
        },
      ],
    });

    const lookup = new DnsRecordsLookup(atom);

    expect(lookup.lookup('server-1.lan', QTYPE_AAAA)).toBeNull();
  });

  it('returns null for an unsupported qtype', () => {
    const atom = makeAtom({
      domains: [
        {
          name: 'lan',
          type: 'FORWARD',
          records: [{ name: 'server-1', type: 'A', value: '10.0.1.10', ttl: null }],
        },
      ],
    });

    const lookup = new DnsRecordsLookup(atom);
    const QTYPE_MX = 15;

    expect(lookup.lookup('server-1.lan', QTYPE_MX)).toBeNull();
  });

  it('uses per-record TTL when provided instead of default', () => {
    const atom = makeAtom({
      domains: [
        {
          name: 'lan',
          type: 'FORWARD',
          records: [{ name: 'server-1', type: 'A', value: '10.0.1.10', ttl: 60 }],
        },
      ],
    });

    const lookup = new DnsRecordsLookup(atom);
    const result = lookup.lookup('server-1.lan', QTYPE_A);

    expect(result).toEqual([{ value: '10.0.1.10', ttl: 60 }]);
  });

  it('preserves a null per-record ttl for answer-time default substitution', () => {
    const atom = makeAtom({
      domains: [
        {
          name: 'lan',
          type: 'FORWARD',
          records: [{ name: 'server-1', type: 'A', value: '10.0.1.10', ttl: null }],
        },
      ],
    });

    const lookup = new DnsRecordsLookup(atom);
    const result = lookup.lookup('server-1.lan', QTYPE_A);

    expect(result).toEqual([{ value: '10.0.1.10', ttl: null }]);
  });

  it('handles @ record name as the domain apex', () => {
    const atom = makeAtom({
      domains: [
        {
          name: 'example.lan',
          type: 'FORWARD',
          records: [{ name: '@', type: 'A', value: '10.0.0.1', ttl: null }],
        },
      ],
    });

    const lookup = new DnsRecordsLookup(atom);

    expect(lookup.lookup('example.lan', QTYPE_A)).toEqual([{ value: '10.0.0.1', ttl: null }]);
  });

  it('handles empty record name as the domain apex', () => {
    const atom = makeAtom({
      domains: [
        {
          name: 'example.lan',
          type: 'FORWARD',
          records: [{ name: '', type: 'A', value: '10.0.0.1', ttl: null }],
        },
      ],
    });

    const lookup = new DnsRecordsLookup(atom);

    expect(lookup.lookup('example.lan', QTYPE_A)).toEqual([{ value: '10.0.0.1', ttl: null }]);
  });

  it('performs case-insensitive lookups', () => {
    const atom = makeAtom({
      domains: [
        {
          name: 'LAN',
          type: 'FORWARD',
          records: [{ name: 'Server-1', type: 'A', value: '10.0.1.10', ttl: null }],
        },
      ],
    });

    const lookup = new DnsRecordsLookup(atom);

    expect(lookup.lookup('SERVER-1.LAN', QTYPE_A)).toEqual([{ value: '10.0.1.10', ttl: null }]);
    expect(lookup.lookup('server-1.lan', QTYPE_A)).toEqual([{ value: '10.0.1.10', ttl: null }]);
  });

  it('returns records across multiple domains', () => {
    const atom = makeAtom({
      domains: [
        {
          name: 'lan',
          type: 'FORWARD',
          records: [{ name: 'web', type: 'A', value: '10.0.1.1', ttl: null }],
        },
        {
          name: 'internal',
          type: 'FORWARD',
          records: [{ name: 'db', type: 'A', value: '10.0.2.1', ttl: null }],
        },
      ],
    });

    const lookup = new DnsRecordsLookup(atom);

    expect(lookup.lookup('web.lan', QTYPE_A)).toEqual([{ value: '10.0.1.1', ttl: null }]);
    expect(lookup.lookup('db.internal', QTYPE_A)).toEqual([{ value: '10.0.2.1', ttl: null }]);
  });
});
