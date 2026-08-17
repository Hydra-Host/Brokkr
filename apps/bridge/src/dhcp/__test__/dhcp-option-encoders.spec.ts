import { describe, expect, it } from 'vitest';

import { encodeClasslessRoutes, encodeDomainSearch } from '../dhcp-option-encoders.js';
import { DhcpParseError } from '../dhcp-options.js';
import { parseDhcpOptionValue } from '../dhcp.config.js';

const hex = (buf: Buffer): string => buf.toString('hex');

describe('parseDhcpOptionValue type-inference cascade', () => {
  it('1 — OT_ADDR_LIST single IPv4 → 4 bytes', () => {
    expect(hex(parseDhcpOptionValue(6, ['8.8.8.8']))).toBe('08080808');
  });

  it('2 — OT_ADDR_LIST list → 4n bytes in order', () => {
    expect(hex(parseDhcpOptionValue(6, ['8.8.8.8', '8.8.4.4']))).toBe('0808080808080404');
  });

  it('3 — OT_ADDR_LIST rejects a non-IPv4 token', () => {
    expect(() => parseDhcpOptionValue(6, ['not-an-ip'])).toThrow(/IPv4/);
  });

  it('4 — decimal magnitude picks the width (1→1B, 300→2B, 70000→4B) on a width-free code', () => {
    expect(hex(parseDhcpOptionValue(99, ['1']))).toBe('01');
    expect(hex(parseDhcpOptionValue(99, ['300']))).toBe('012c');
    expect(hex(parseDhcpOptionValue(99, ['70000']))).toBe('00011170');
  });

  it('5 — known OT_DEC width: opt-26 1500→05dc (2B), opt-23 64→40 (1B), opt-35→4B', () => {
    expect(hex(parseDhcpOptionValue(26, ['1500']))).toBe('05dc');
    expect(hex(parseDhcpOptionValue(23, ['64']))).toBe('40');
    expect(hex(parseDhcpOptionValue(35, ['5']))).toBe('00000005');
  });

  it('6 — b/s/i width suffix overrides: 1i→4B, 5s→2B, 7b→1B', () => {
    expect(hex(parseDhcpOptionValue(99, ['1i']))).toBe('00000001');
    expect(hex(parseDhcpOptionValue(99, ['5s']))).toBe('0005');
    expect(hex(parseDhcpOptionValue(99, ['7b']))).toBe('07');
  });

  it('7 — decimal encodes big-endian: 258s → 01 02', () => {
    expect(hex(parseDhcpOptionValue(99, ['258s']))).toBe('0102');
  });

  it('8 — decimal overflowing the known width throws (opt-23 width-1, value 300)', () => {
    expect(() => parseDhcpOptionValue(23, ['300'])).toThrow(/does not fit/);
  });

  it('9 — hex (colon-delimited) → raw bytes', () => {
    expect(hex(parseDhcpOptionValue(99, ['0a:0b:0c']))).toBe('0a0b0c');
  });

  it('10 — hex takes precedence over decimal: 10:20 is two hex bytes, not numbers', () => {
    expect(hex(parseDhcpOptionValue(99, ['10:20']))).toBe('1020');
  });

  it('10b — a colon-less hex-looking token (0a) is NOT hex; it falls to the string arm', () => {
    expect(parseDhcpOptionValue(99, ['0a']).toString('ascii')).toBe('0a');
  });

  it('11 — string fallback → ASCII with no trailing NUL', () => {
    const value = parseDhcpOptionValue(99, ['myhost']);
    expect(value.toString('ascii')).toBe('myhost');
    expect(value[value.length - 1]).not.toBe(0x00);
  });

  it('12 — OT_NAME forces the string arm even for an all-numeric value', () => {
    expect(parseDhcpOptionValue(12, ['12345']).toString('ascii')).toBe('12345');
  });

  it('magnitude width for 1500 on a width-free code is 2 bytes (not the opt-26 forced width)', () => {
    expect(hex(parseDhcpOptionValue(99, ['1500']))).toBe('05dc');
  });
});

describe('encodeDomainSearch (opt-119)', () => {
  it('14 — single name eng.lan → 03 65 6e 67 03 6c 61 6e 00', () => {
    expect(hex(encodeDomainSearch(['eng.lan']))).toBe('03656e67036c616e00');
  });

  it('14b — the cascade routes opt-119 through the RFC1035_NAME arm (byte-exact)', () => {
    expect(hex(parseDhcpOptionValue(119, ['eng.lan']))).toBe('03656e67036c616e00');
  });

  it('15 — two unrelated names are emitted uncompressed', () => {
    expect(hex(encodeDomainSearch(['eng.lan', 'corp.net']))).toBe('03656e67036c616e0004636f7270036e657400');
  });

  it('16 — shared tail emitted uncompressed (no pointer): eng.lan,corp.lan', () => {
    expect(hex(encodeDomainSearch(['eng.lan', 'corp.lan']))).toBe('03656e67036c616e0004636f7270036c616e00');
  });

  it('17 — bare "." encodes the root as a single 0x00', () => {
    expect(hex(encodeDomainSearch(['.']))).toBe('00');
  });

  it('18 — a domain-search list exceeding 255 bytes throws', () => {
    const many = Array.from({ length: 30 }, (_, i) => `host${i}.example-domain.lan`);
    expect(() => encodeDomainSearch(many)).toThrow(DhcpParseError);
  });

  it('18b — an empty label is rejected, not silently encoded', () => {
    expect(() => encodeDomainSearch(['a', 'b', 'a..b'])).toThrow(DhcpParseError);
  });
});

describe('encodeClasslessRoutes (opt-121)', () => {
  it('19 — default route 0.0.0.0/0,10.0.0.1 → 00 0a 00 00 01 (zero dest octets)', () => {
    expect(hex(encodeClasslessRoutes(['0.0.0.0/0', '10.0.0.1']))).toBe('000a000001');
  });

  it('20 — /24 192.168.5.0/24,192.168.5.1 → 18 c0 a8 05 c0 a8 05 01', () => {
    expect(hex(encodeClasslessRoutes(['192.168.5.0/24', '192.168.5.1']))).toBe('18c0a805c0a80501');
  });

  it('21 — /8 10.0.0.0/8,192.168.1.1 → 08 0a c0 a8 01 01', () => {
    expect(hex(encodeClasslessRoutes(['10.0.0.0/8', '192.168.1.1']))).toBe('080ac0a80101');
  });

  it('22 — /14 (non-octet-aligned) 10.17.0.0/14,1.2.3.4 → 0e 0a 11 01 02 03 04', () => {
    expect(hex(encodeClasslessRoutes(['10.17.0.0/14', '1.2.3.4']))).toBe('0e0a1101020304');
  });

  it('23 — multiple routes concatenate in order', () => {
    expect(hex(encodeClasslessRoutes(['0.0.0.0/0', '10.0.0.1', '10.0.0.0/8', '192.168.1.1']))).toBe(
      '000a000001' + '080ac0a80101',
    );
  });

  it('24 — an odd token count throws (dest without gateway)', () => {
    expect(() => encodeClasslessRoutes(['10.0.0.0/8'])).toThrow(/token pairs/);
  });

  it('25 — prefix > 32 throws', () => {
    expect(() => encodeClasslessRoutes(['10.0.0.0/33', '10.0.0.1'])).toThrow(/out of range/);
  });

  it('routes via the cascade when a slash is present (opt-121 generic arm)', () => {
    expect(hex(parseDhcpOptionValue(121, ['0.0.0.0/0', '10.0.0.1']))).toBe('000a000001');
  });

  it('a slash in a structural OT_ADDR_LIST option (opt-3) is rejected, not route-encoded', () => {
    expect(() => parseDhcpOptionValue(3, ['10.0.0.0/24', '10.0.0.1'])).toThrow(/IPv4 addresses/);
  });

  it('a signed decimal is not a decimal and falls through to the string arm', () => {
    expect(parseDhcpOptionValue(99, ['-5']).toString('ascii')).toBe('-5');
  });

  it('a string value containing a NUL byte is rejected', () => {
    expect(() => parseDhcpOptionValue(99, ['hello\x00world'])).toThrow(/NUL byte/);
  });
});
