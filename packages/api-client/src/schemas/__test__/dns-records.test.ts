import { describe, expect, it } from 'vitest';
import {
  CreateDnsDomainSchema,
  CreateDnsRecordSchema,
  DnsDomainSchema,
  DnsRecordListQuerySchema,
  DnsRecordSchema,
  UpdateDnsDomainSchema,
  UpdateDnsRecordSchema,
} from '../dns-records';

describe('CreateDnsDomainSchema type field', () => {
  it('defaults to FORWARD when omitted', () => {
    const result = CreateDnsDomainSchema.safeParse({ name: 'lan' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.type).toBe('FORWARD');
  });

  it('accepts REVERSE', () => {
    const result = CreateDnsDomainSchema.safeParse({ name: '10.in-addr.arpa', type: 'REVERSE' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.type).toBe('REVERSE');
  });

  it('rejects an invalid type value', () => {
    expect(CreateDnsDomainSchema.safeParse({ name: 'lan', type: 'INVALID' }).success).toBe(false);
  });
});

describe('CreateDnsDomainSchema name validation', () => {
  it('accepts a simple domain name', () => {
    expect(CreateDnsDomainSchema.safeParse({ name: 'lan' }).success).toBe(true);
  });

  it('accepts a dotted domain name', () => {
    expect(CreateDnsDomainSchema.safeParse({ name: 'example.lan' }).success).toBe(true);
  });

  it('accepts a reverse-lookup domain', () => {
    expect(CreateDnsDomainSchema.safeParse({ name: '10.in-addr.arpa' }).success).toBe(true);
  });

  it('accepts a trailing-dot FQDN', () => {
    expect(CreateDnsDomainSchema.safeParse({ name: 'example.lan.' }).success).toBe(true);
  });

  it('accepts a domain with hyphens', () => {
    expect(CreateDnsDomainSchema.safeParse({ name: 'my-zone.example.lan' }).success).toBe(true);
  });

  it('rejects a domain with spaces', () => {
    expect(CreateDnsDomainSchema.safeParse({ name: 'foo bar' }).success).toBe(false);
  });

  it('rejects a domain with underscores', () => {
    expect(CreateDnsDomainSchema.safeParse({ name: 'foo_bar.lan' }).success).toBe(false);
  });

  it('rejects a domain starting with a hyphen', () => {
    expect(CreateDnsDomainSchema.safeParse({ name: '-invalid.lan' }).success).toBe(false);
  });

  it('rejects an empty name', () => {
    expect(CreateDnsDomainSchema.safeParse({ name: '' }).success).toBe(false);
  });

  it('rejects a name exceeding 253 characters', () => {
    const long = Array(128).fill('a').join('.');
    expect(long.length).toBeGreaterThan(253);
    expect(CreateDnsDomainSchema.safeParse({ name: long }).success).toBe(false);
  });

  it('rejects a 254-char name with no trailing dot (253-char bare-name boundary)', () => {
    const name = `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(62)}.${'d'.repeat(63)}`;
    expect(name.length).toBe(254);
    expect(CreateDnsDomainSchema.safeParse({ name }).success).toBe(false);
  });

  it('accepts a 254-char name whose bare length is 253 thanks to the trailing dot', () => {
    const name = `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(62)}.${'d'.repeat(62)}.`;
    expect(name.length).toBe(254);
    expect(CreateDnsDomainSchema.safeParse({ name }).success).toBe(true);
  });
});

describe('UpdateDnsDomainSchema name validation', () => {
  it('accepts a valid domain name', () => {
    expect(UpdateDnsDomainSchema.safeParse({ name: 'lan' }).success).toBe(true);
  });

  it('rejects a domain with spaces', () => {
    expect(UpdateDnsDomainSchema.safeParse({ name: 'foo bar' }).success).toBe(false);
  });
});

const BASE = { name: 'host1', ttlOverride: null };

describe('CreateDnsRecordSchema TTL boundary constraints', () => {
  it('rejects zero ttlOverride', () => {
    expect(CreateDnsRecordSchema.safeParse({ ...BASE, type: 'A', value: '10.0.0.1', ttlOverride: 0 }).success).toBe(
      false,
    );
  });

  it('rejects negative ttlOverride', () => {
    expect(CreateDnsRecordSchema.safeParse({ ...BASE, type: 'A', value: '10.0.0.1', ttlOverride: -1 }).success).toBe(
      false,
    );
  });

  it('accepts positive ttlOverride', () => {
    expect(CreateDnsRecordSchema.safeParse({ ...BASE, type: 'A', value: '10.0.0.1', ttlOverride: 300 }).success).toBe(
      true,
    );
  });

  it('accepts ttlOverride at the 32-bit max', () => {
    expect(
      CreateDnsRecordSchema.safeParse({ ...BASE, type: 'A', value: '10.0.0.1', ttlOverride: 0x7fffffff }).success,
    ).toBe(true);
  });

  it('rejects ttlOverride above the 32-bit signed max', () => {
    expect(
      CreateDnsRecordSchema.safeParse({ ...BASE, type: 'A', value: '10.0.0.1', ttlOverride: 0x7fffffff + 1 }).success,
    ).toBe(false);
  });
});

describe('CreateDnsRecordSchema name validation', () => {
  const aBase = { type: 'A' as const, value: '10.0.0.1' };

  it.each(['host1', 'web-server', 'ns1', 'a', 'A1b2'])('accepts valid A/AAAA record name %s', (name) => {
    expect(CreateDnsRecordSchema.safeParse({ ...aBase, name }).success).toBe(true);
  });

  it('accepts a 63-character DNS label at the RFC 1035 maximum', () => {
    const label = 'a'.repeat(63);
    expect(CreateDnsRecordSchema.safeParse({ ...aBase, name: label }).success).toBe(true);
  });

  it('rejects a 64-character DNS label exceeding the RFC 1035 maximum', () => {
    const label = 'a'.repeat(64);
    expect(CreateDnsRecordSchema.safeParse({ ...aBase, name: label }).success).toBe(false);
  });

  it.each(['-leading', 'trailing-', 'bad name', 'inv@lid', 'no.dots', ''])(
    'rejects invalid A/AAAA record name %s',
    (name) => {
      expect(CreateDnsRecordSchema.safeParse({ ...aBase, name }).success).toBe(false);
    },
  );

  it.each(['1.0.0.10', '42', 'a', 'a.b.c.d.e.f'])('accepts valid PTR name %s', (name) => {
    expect(CreateDnsRecordSchema.safeParse({ type: 'PTR', value: 'host.lan', name }).success).toBe(true);
  });

  it.each(['not!valid', '-1', 'has space'])('rejects invalid PTR name %s', (name) => {
    expect(CreateDnsRecordSchema.safeParse({ type: 'PTR', value: 'host.lan', name }).success).toBe(false);
  });
});

describe('CreateDnsRecordSchema value validation', () => {
  it('accepts a valid IPv4 for A records', () => {
    expect(CreateDnsRecordSchema.safeParse({ ...BASE, type: 'A', value: '10.0.0.1' }).success).toBe(true);
  });

  it('rejects a non-IP string for A records', () => {
    const result = CreateDnsRecordSchema.safeParse({ ...BASE, type: 'A', value: 'not-an-ip' });
    expect(result.success).toBe(false);
  });

  it('rejects an IPv6 address for A records', () => {
    const result = CreateDnsRecordSchema.safeParse({ ...BASE, type: 'A', value: '::1' });
    expect(result.success).toBe(false);
  });

  it('accepts a valid IPv6 for AAAA records', () => {
    expect(CreateDnsRecordSchema.safeParse({ ...BASE, type: 'AAAA', value: '2001:db8::1' }).success).toBe(true);
  });

  it('rejects an IPv4 for AAAA records', () => {
    const result = CreateDnsRecordSchema.safeParse({ ...BASE, type: 'AAAA', value: '10.0.0.1' });
    expect(result.success).toBe(false);
  });

  it('accepts a valid domain name for PTR records', () => {
    expect(
      CreateDnsRecordSchema.safeParse({ ...BASE, name: '1.0.0.10', type: 'PTR', value: 'host1.example.lan' }).success,
    ).toBe(true);
  });

  it('accepts a trailing-dot FQDN for PTR records', () => {
    expect(
      CreateDnsRecordSchema.safeParse({ ...BASE, name: '1.0.0.10', type: 'PTR', value: 'host1.lan.' }).success,
    ).toBe(true);
  });

  it('rejects a domain name with invalid characters for PTR records', () => {
    const result = CreateDnsRecordSchema.safeParse({ ...BASE, name: '1.0.0.10', type: 'PTR', value: 'host 1.lan' });
    expect(result.success).toBe(false);
  });
});

describe('DnsRecordListQuerySchema', () => {
  it('accepts an empty query', () => {
    expect(DnsRecordListQuerySchema.safeParse({}).success).toBe(true);
  });

  it('accepts source=MANUAL', () => {
    const result = DnsRecordListQuerySchema.safeParse({ source: 'MANUAL' });
    expect(result.success).toBe(true);
    expect(result.data?.source).toBe('MANUAL');
  });

  it('accepts source=AUTO', () => {
    const result = DnsRecordListQuerySchema.safeParse({ source: 'AUTO' });
    expect(result.success).toBe(true);
    expect(result.data?.source).toBe('AUTO');
  });
});

describe('UpdateDnsRecordSchema', () => {
  it('accepts a valid name update', () => {
    expect(UpdateDnsRecordSchema.safeParse({ name: 'host2' }).success).toBe(true);
  });

  it('accepts a valid value update', () => {
    expect(UpdateDnsRecordSchema.safeParse({ value: '10.0.0.2' }).success).toBe(true);
  });

  it('accepts a valid ttlOverride update', () => {
    expect(UpdateDnsRecordSchema.safeParse({ ttlOverride: 300 }).success).toBe(true);
  });

  it('accepts null ttlOverride', () => {
    expect(UpdateDnsRecordSchema.safeParse({ ttlOverride: null }).success).toBe(true);
  });

  it('rejects ttlOverride above the 32-bit signed max', () => {
    expect(UpdateDnsRecordSchema.safeParse({ ttlOverride: 0x7fffffff + 1 }).success).toBe(false);
  });

  it('accepts an empty update', () => {
    expect(UpdateDnsRecordSchema.safeParse({}).success).toBe(true);
  });

  it('rejects a name with spaces', () => {
    expect(UpdateDnsRecordSchema.safeParse({ name: 'bad name' }).success).toBe(false);
  });

  it('rejects a name starting with a hyphen', () => {
    expect(UpdateDnsRecordSchema.safeParse({ name: '-invalid' }).success).toBe(false);
  });

  it('accepts a valid PTR fragment as name', () => {
    expect(UpdateDnsRecordSchema.safeParse({ name: '1.0.0.10' }).success).toBe(true);
  });

  it('rejects a value that is not an IP or domain', () => {
    expect(UpdateDnsRecordSchema.safeParse({ value: 'not valid!' }).success).toBe(false);
  });

  it('accepts an IPv6 value', () => {
    expect(UpdateDnsRecordSchema.safeParse({ value: '2001:db8::1' }).success).toBe(true);
  });

  it('accepts a domain name value', () => {
    expect(UpdateDnsRecordSchema.safeParse({ value: 'host1.lan' }).success).toBe(true);
  });

  it('rejects zero ttlOverride', () => {
    expect(UpdateDnsRecordSchema.safeParse({ ttlOverride: 0 }).success).toBe(false);
  });

  it('rejects negative ttlOverride', () => {
    expect(UpdateDnsRecordSchema.safeParse({ ttlOverride: -1 }).success).toBe(false);
  });
});

describe('DnsDomainSchema (response)', () => {
  const valid = {
    id: 'dom-1',
    name: 'lan',
    type: 'FORWARD',
    zoneId: 'zone-1',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };

  it('parses a valid domain response', () => {
    const result = DnsDomainSchema.safeParse(valid);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.createdAt).toBeInstanceOf(Date);
  });

  it('coerces ISO string timestamps to Date', () => {
    const result = DnsDomainSchema.safeParse(valid);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.updatedAt).toBeInstanceOf(Date);
  });

  it('rejects missing fields', () => {
    expect(DnsDomainSchema.safeParse({ id: 'x' }).success).toBe(false);
  });
});

describe('DnsRecordSchema (response)', () => {
  const valid = {
    id: 'rec-1',
    name: 'host1',
    type: 'A',
    value: '10.0.0.1',
    source: 'MANUAL',
    ttlOverride: null,
    domainId: 'dom-1',
    deviceId: null,
    deviceRole: null,
    ipAddressId: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };

  it('parses a valid record response', () => {
    const result = DnsRecordSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  it('accepts numeric ttlOverride', () => {
    const result = DnsRecordSchema.safeParse({ ...valid, ttlOverride: 60 });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.ttlOverride).toBe(60);
  });

  it('rejects invalid record type', () => {
    expect(DnsRecordSchema.safeParse({ ...valid, type: 'MX' }).success).toBe(false);
  });

  it('rejects invalid source', () => {
    expect(DnsRecordSchema.safeParse({ ...valid, source: 'UNKNOWN' }).success).toBe(false);
  });
});
