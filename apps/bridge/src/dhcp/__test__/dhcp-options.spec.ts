import { describe, expect, it } from 'vitest';

import {
  DHCPDISCOVER,
  DhcpParseError,
  OPT_END,
  OPT_HOSTNAME,
  OPT_MESSAGE_TYPE,
  OPT_PAD,
  OPT_PARAM_REQ_LIST,
  OPT_ROUTER,
  decodeIp,
  encodeIp,
  encodeIps,
  encodeOptions,
  encodeUint32,
  parseOptions,
} from '../dhcp-options.js';

const bytes = (...b: number[]): Buffer => Buffer.from(b);

describe('parseOptions', () => {
  it('parses a simple TLV sequence terminated by END', () => {
    const buf = bytes(OPT_MESSAGE_TYPE, 1, DHCPDISCOVER, OPT_ROUTER, 4, 192, 168, 1, 1, OPT_END);
    const opts = parseOptions(buf, 0);
    expect(opts.get(OPT_MESSAGE_TYPE)).toEqual(bytes(DHCPDISCOVER));
    expect(opts.get(OPT_ROUTER)).toEqual(bytes(192, 168, 1, 1));
  });

  it('skips PAD bytes', () => {
    const buf = bytes(OPT_PAD, OPT_PAD, OPT_MESSAGE_TYPE, 1, DHCPDISCOVER, OPT_PAD, OPT_END);
    const opts = parseOptions(buf, 0);
    expect(opts.get(OPT_MESSAGE_TYPE)).toEqual(bytes(DHCPDISCOVER));
  });

  it('stops at END and ignores trailing bytes', () => {
    const buf = bytes(OPT_MESSAGE_TYPE, 1, DHCPDISCOVER, OPT_END, OPT_ROUTER, 4, 9, 9, 9, 9);
    const opts = parseOptions(buf, 0);
    expect(opts.has(OPT_ROUTER)).toBe(false);
  });

  it('concatenates repeated instances of the same option code (RFC 3396)', () => {
    const buf = bytes(OPT_PARAM_REQ_LIST, 2, 1, 3, OPT_PARAM_REQ_LIST, 2, 6, 51, OPT_END);
    const opts = parseOptions(buf, 0);
    expect(opts.get(OPT_PARAM_REQ_LIST)).toEqual(bytes(1, 3, 6, 51));
  });

  it('preserves fragment order across 3+ instances of a code (single-pass concat)', () => {
    const buf = bytes(OPT_PARAM_REQ_LIST, 1, 1, OPT_PARAM_REQ_LIST, 1, 2, OPT_PARAM_REQ_LIST, 1, 3, OPT_END);
    expect(parseOptions(buf, 0).get(OPT_PARAM_REQ_LIST)).toEqual(bytes(1, 2, 3));
  });

  it('tolerates a missing END (runs to buffer end)', () => {
    const buf = bytes(OPT_MESSAGE_TYPE, 1, DHCPDISCOVER);
    const opts = parseOptions(buf, 0);
    expect(opts.get(OPT_MESSAGE_TYPE)).toEqual(bytes(DHCPDISCOVER));
  });

  it('throws on a length running past the packet', () => {
    const buf = bytes(OPT_ROUTER, 8, 192, 168, 1, 1);
    expect(() => parseOptions(buf, 0)).toThrow(DhcpParseError);
    expect(() => parseOptions(buf, 0)).toThrow(/runs past packet end/);
  });

  it('throws on a truncated option header', () => {
    const buf = bytes(OPT_ROUTER);
    expect(() => parseOptions(buf, 0)).toThrow(/truncated option header/);
  });

  describe('bounded end window', () => {
    it('stops at END before the window edge', () => {
      const buf = bytes(OPT_MESSAGE_TYPE, 1, DHCPDISCOVER, OPT_END, OPT_ROUTER, 4, 9, 9, 9, 9);
      const opts = parseOptions(buf, 0, buf.length);
      expect(opts.has(OPT_ROUTER)).toBe(false);
    });

    it('stops at the window edge even without an END', () => {
      const buf = bytes(OPT_MESSAGE_TYPE, 1, DHCPDISCOVER, OPT_ROUTER, 4, 9, 9, 9, 9);
      const opts = parseOptions(buf, 0, 3);
      expect(opts.get(OPT_MESSAGE_TYPE)).toEqual(bytes(DHCPDISCOVER));
      expect(opts.has(OPT_ROUTER)).toBe(false);
    });

    it('throws when a TLV crosses the window end', () => {
      const buf = bytes(OPT_ROUTER, 4, 9, 9, 9, 9, OPT_END);
      expect(() => parseOptions(buf, 0, 4)).toThrow(/runs past packet end/);
    });

    it('default end equals the old single-arg behavior', () => {
      const buf = bytes(OPT_MESSAGE_TYPE, 1, DHCPDISCOVER, OPT_ROUTER, 4, 1, 2, 3, 4, OPT_END);
      expect(parseOptions(buf, 0)).toEqual(parseOptions(buf, 0, buf.length));
    });
  });

  it('concatenates repeated hostname instances per RFC 3396', () => {
    const buf = bytes(OPT_HOSTNAME, 1, 0x61, OPT_HOSTNAME, 1, 0x62, OPT_END);
    const opts = parseOptions(buf, 0);
    expect(opts.get(OPT_HOSTNAME)).toEqual(bytes(0x61, 0x62));
  });
});

describe('encodeOptions', () => {
  it('round-trips through parseOptions', () => {
    const encoded = encodeOptions([
      { code: OPT_MESSAGE_TYPE, value: bytes(DHCPDISCOVER) },
      { code: OPT_ROUTER, value: encodeIp('10.0.0.1') },
    ]);
    expect(encoded[encoded.length - 1]).toBe(OPT_END);
    const opts = parseOptions(encoded, 0);
    expect(opts.get(OPT_MESSAGE_TYPE)).toEqual(bytes(DHCPDISCOVER));
    expect(decodeIp(opts.get(OPT_ROUTER) ?? Buffer.alloc(0))).toBe('10.0.0.1');
  });

  it('rejects PAD/END as data codes', () => {
    expect(() => encodeOptions([{ code: OPT_END, value: Buffer.alloc(0) }])).toThrow(/reserved/);
    expect(() => encodeOptions([{ code: OPT_PAD, value: Buffer.alloc(0) }])).toThrow(/reserved/);
  });

  it('rejects a value longer than 255 bytes', () => {
    expect(() => encodeOptions([{ code: OPT_ROUTER, value: Buffer.alloc(256) }])).toThrow(/exceeds 255/);
  });
});

describe('IP and integer codecs', () => {
  it('encodeIp packs a dotted quad', () => {
    expect(encodeIp('192.168.1.5')).toEqual(bytes(192, 168, 1, 5));
  });

  it('decodeIp unpacks 4 bytes', () => {
    expect(decodeIp(bytes(172, 16, 12, 14))).toBe('172.16.12.14');
  });

  it('encodeIp rejects malformed addresses', () => {
    expect(() => encodeIp('192.168.1')).toThrow(DhcpParseError);
    expect(() => encodeIp('192.168.1.256')).toThrow(DhcpParseError);
    expect(() => encodeIp('192.168.1.x')).toThrow(DhcpParseError);
  });

  it('encodeIp rejects an octet with surrounding whitespace', () => {
    expect(() => encodeIp('10.0.0. 5')).toThrow(DhcpParseError);
  });

  it('encodeIps concatenates a list', () => {
    expect(encodeIps(['8.8.8.8', '1.1.1.1'])).toEqual(bytes(8, 8, 8, 8, 1, 1, 1, 1));
  });

  it('encodeIps rejects an empty list', () => {
    expect(() => encodeIps([])).toThrow(/at least one/);
  });

  it('encodeUint32 is big-endian', () => {
    expect(encodeUint32(3600)).toEqual(bytes(0x00, 0x00, 0x0e, 0x10));
  });

  it('encodeUint32 rejects out-of-range values', () => {
    expect(() => encodeUint32(-1)).toThrow(DhcpParseError);
    expect(() => encodeUint32(0x1_0000_0000)).toThrow(DhcpParseError);
  });
});
