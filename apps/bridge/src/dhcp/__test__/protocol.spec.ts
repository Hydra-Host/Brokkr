import { describe, expect, it } from 'vitest';

import {
  DHCPDISCOVER,
  DHCPNAK,
  DHCPOFFER,
  DhcpParseError,
  OPT_END,
  OPT_HOSTNAME,
  OPT_LEASE_TIME,
  OPT_MAX_MSG_SIZE,
  OPT_OVERLOAD,
  OPT_REQUESTED_IP,
  OPT_ROUTER,
  OPT_SERVER_ID,
  OPT_SUBNET_MASK,
  decodeIp,
  encodeIp,
  encodeUint32,
} from '../dhcp-options.js';
import {
  BOOTP_MIN_REPLY_LEN,
  BOOTREPLY,
  FILE_FIELD_LEN,
  FILE_OFFSET,
  FLAG_BROADCAST,
  OPTIONS_OFFSET,
  SNAME_FIELD_LEN,
  SNAME_OFFSET,
  buildReply,
  formatMac,
  macToBytes,
  parsePacket,
} from '../protocol.js';

const CHADDR_MAC = '00:0b:82:01:fc:42';

function reparseReply(reply: Buffer): ReturnType<typeof parsePacket> {
  const copy = Buffer.from(reply);
  copy[0] = 1;
  return parsePacket(copy);
}

function rawDiscover(opts?: { broadcast?: boolean; secs?: number; hops?: number }): Buffer {
  const flags = opts?.broadcast ? 0x8000 : 0x0000;
  const head = Buffer.alloc(28);
  head[0] = 0x01;
  head[1] = 0x01;
  head[2] = 0x06;
  head[3] = opts?.hops ?? 0x00;
  head.writeUInt32BE(0x3903f326, 4);
  head.writeUInt16BE(opts?.secs ?? 0x0000, 8);
  head.writeUInt16BE(flags, 10);

  const chaddr = Buffer.alloc(16);
  macToBytes(CHADDR_MAC).copy(chaddr, 0);

  const snameFile = Buffer.alloc(64 + 128);
  const cookie = Buffer.from([0x63, 0x82, 0x53, 0x63]);

  const options = Buffer.from([
    0x35, 0x01, 0x01, 0x3d, 0x07, 0x01, 0x00, 0x0b, 0x82, 0x01, 0xfc, 0x42, 0x32, 0x04, 0xc0, 0xa8, 0x01, 0x64, 0x37,
    0x04, 0x01, 0x03, 0x06, 0x2a, 0xff,
  ]);

  return Buffer.concat([head, chaddr, snameFile, cookie, options]);
}

describe('formatMac / macToBytes', () => {
  it('formats raw bytes to lowercased colon-hex', () => {
    expect(formatMac(Buffer.from([0x00, 0x0b, 0x82, 0x01, 0xfc, 0x42]))).toBe(CHADDR_MAC);
  });

  it('round-trips a MAC', () => {
    expect(formatMac(macToBytes(CHADDR_MAC))).toBe(CHADDR_MAC);
  });

  it('parses dash-separated and uppercase MACs', () => {
    expect(macToBytes('AA-BB-CC-DD-EE-FF')).toEqual(Buffer.from([0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff]));
  });

  it('rejects malformed MACs', () => {
    expect(() => macToBytes('00:0b:82:zz:fc:42')).toThrow(DhcpParseError);
  });
});

describe('parsePacket', () => {
  it('extracts the fixed header fields', () => {
    const msg = parsePacket(rawDiscover());
    expect(msg.op).toBe(0x01);
    expect(msg.htype).toBe(0x01);
    expect(msg.hlen).toBe(0x06);
    expect(msg.xid).toBe(0x3903f326);
    expect(msg.chaddr).toBe(CHADDR_MAC);
    expect(msg.ciaddr).toBe('0.0.0.0');
    expect(msg.giaddr).toBe('0.0.0.0');
  });

  it('extracts the DHCP message type from option 53', () => {
    expect(parsePacket(rawDiscover()).messageType).toBe(DHCPDISCOVER);
  });

  it('decodes the requested-IP and param-request-list options', () => {
    const msg = parsePacket(rawDiscover());
    expect(decodeIp(msg.options.get(OPT_REQUESTED_IP) ?? Buffer.alloc(0))).toBe('192.168.1.100');
    expect(msg.options.get(0x37)).toEqual(Buffer.from([1, 3, 6, 42]));
  });

  it('reads the broadcast flag', () => {
    expect(parsePacket(rawDiscover({ broadcast: false })).broadcast).toBe(false);
    expect(parsePacket(rawDiscover({ broadcast: true })).broadcast).toBe(true);
  });

  it('rejects a packet shorter than the BOOTP minimum', () => {
    expect(() => parsePacket(Buffer.alloc(100))).toThrow(/shorter than minimum/);
  });

  it('rejects a bad magic cookie', () => {
    const bad = rawDiscover();
    bad.writeUInt32BE(0xdeadbeef, 236);
    expect(() => parsePacket(bad)).toThrow(/magic cookie/);
  });

  it('rejects an hlen larger than the chaddr field', () => {
    const bad = rawDiscover();
    bad[2] = 0x20;
    expect(() => parsePacket(bad)).toThrow(/exceeds/);
  });

  it('rejects a packet whose op is not BOOTREQUEST', () => {
    const bad = rawDiscover();
    bad[0] = 0x02;
    expect(() => parsePacket(bad)).toThrow(/not BOOTREQUEST/);
  });

  it('rejects a degenerate htype 0 with a non-zero hlen', () => {
    const bad = rawDiscover();
    bad[1] = 0x00;
    bad[2] = 0x06;
    expect(() => parsePacket(bad)).toThrow(/htype 0/);
  });

  it('rejects a non-zero htype paired with a zero hlen', () => {
    const bad = rawDiscover();
    bad[2] = 0x00;
    expect(() => parsePacket(bad)).toThrow(DhcpParseError);
  });

  it('rejects an all-zero htype/hlen pair (empty chaddr) at the boundary (I8)', () => {
    const bad = rawDiscover();
    bad[1] = 0x00;
    bad[2] = 0x00;
    expect(() => parsePacket(bad)).toThrow(DhcpParseError);
  });

  it('echoes the request secs into the parsed message', () => {
    expect(parsePacket(rawDiscover({ secs: 42 })).secs).toBe(42);
  });
});

describe('buildReply', () => {
  const request = parsePacket(rawDiscover());

  const offer = (): Buffer =>
    buildReply(request, {
      messageType: DHCPOFFER,
      yiaddr: '192.168.1.100',
      serverId: '192.168.1.1',
      siaddr: '192.168.1.1',
      bootfile: 'undionly.kpxe',
      options: [
        { code: OPT_LEASE_TIME, value: encodeUint32(3600) },
        { code: OPT_SUBNET_MASK, value: encodeIp('255.255.255.0') },
        { code: OPT_ROUTER, value: encodeIp('192.168.1.1') },
      ],
    });

  it('produces a parseable BOOTREPLY that echoes the request', () => {
    const reply = offer();
    expect(reply[0]).toBe(BOOTREPLY);
    const msg = reparseReply(reply);
    expect(msg.xid).toBe(0x3903f326);
    expect(msg.chaddr).toBe(CHADDR_MAC);
    expect(msg.yiaddr).toBe('192.168.1.100');
    expect(msg.siaddr).toBe('192.168.1.1');
    expect(msg.messageType).toBe(DHCPOFFER);
  });

  it('zeroes secs and hops in the reply regardless of the request (RFC 2131 §4.3 Table 3)', () => {
    const reply = buildReply(parsePacket(rawDiscover({ secs: 7, hops: 4 })), {
      messageType: DHCPOFFER,
      yiaddr: '192.168.1.100',
      serverId: '192.168.1.1',
      options: [],
    });
    const parsed = reparseReply(reply);
    expect(parsed.secs).toBe(0);
    expect(parsed.hops).toBe(0);
  });

  it('prepends the server-identifier option', () => {
    const msg = reparseReply(offer());
    expect(decodeIp(msg.options.get(OPT_SERVER_ID) ?? Buffer.alloc(0))).toBe('192.168.1.1');
  });

  it('carries the appended options', () => {
    const msg = reparseReply(offer());
    expect(msg.options.get(OPT_LEASE_TIME)?.readUInt32BE(0)).toBe(3600);
    expect(decodeIp(msg.options.get(OPT_SUBNET_MASK) ?? Buffer.alloc(0))).toBe('255.255.255.0');
  });

  it('writes the bootfile into the BOOTP file field (offset 108)', () => {
    const reply = offer();
    expect(reply.subarray(108, 108 + 'undionly.kpxe'.length).toString('ascii')).toBe('undionly.kpxe');
  });

  it('pads short replies to the BOOTP minimum length', () => {
    expect(offer().length).toBeGreaterThanOrEqual(BOOTP_MIN_REPLY_LEN);
  });

  it('echoes giaddr from a relayed request so the reply routes back', () => {
    const relayed = rawDiscover();
    encodeIp('10.20.30.1').copy(relayed, 24);
    const msg = reparseReply(
      buildReply(parsePacket(relayed), {
        messageType: DHCPOFFER,
        yiaddr: '10.20.30.55',
        serverId: '10.20.30.1',
        options: [],
      }),
    );
    expect(msg.giaddr).toBe('10.20.30.1');
  });

  it('builds a NAK with a zero yiaddr', () => {
    const msg = reparseReply(
      buildReply(request, { messageType: DHCPNAK, yiaddr: '0.0.0.0', serverId: '192.168.1.1', options: [] }),
    );
    expect(msg.messageType).toBe(DHCPNAK);
    expect(msg.yiaddr).toBe('0.0.0.0');
  });

  it('forces the broadcast flag on and clears ciaddr when forceBroadcast is set', () => {
    const unicastRenew = parsePacket(rawDiscover());
    const withCiaddr = { ...unicastRenew, ciaddr: '10.0.0.55', flags: 0x0000, broadcast: false };
    const reply = buildReply(withCiaddr, {
      messageType: DHCPNAK,
      yiaddr: '0.0.0.0',
      serverId: '192.168.1.1',
      options: [],
      forceBroadcast: true,
    });
    expect(reply.readUInt16BE(10) & FLAG_BROADCAST).toBe(FLAG_BROADCAST);
    const msg = reparseReply(reply);
    expect(msg.broadcast).toBe(true);
    expect(msg.ciaddr).toBe('0.0.0.0');
  });

  it('echoes ciaddr from params into the reply (RFC 2131 s4.3.1 Table 3)', () => {
    const reply = buildReply(request, {
      messageType: DHCPOFFER,
      yiaddr: '192.168.1.100',
      serverId: '192.168.1.1',
      ciaddr: '10.0.0.55',
      options: [],
    });
    const msg = reparseReply(reply);
    expect(msg.ciaddr).toBe('10.0.0.55');
  });

  it('leaves ciaddr as 0.0.0.0 when params.ciaddr is omitted', () => {
    const reply = buildReply(request, {
      messageType: DHCPOFFER,
      yiaddr: '192.168.1.100',
      serverId: '192.168.1.1',
      options: [],
    });
    const msg = reparseReply(reply);
    expect(msg.ciaddr).toBe('0.0.0.0');
  });

  it('rejects a bootfile name that overflows the file field', () => {
    expect(() =>
      buildReply(request, {
        messageType: DHCPOFFER,
        yiaddr: '192.168.1.100',
        serverId: '192.168.1.1',
        bootfile: 'x'.repeat(128),
        options: [],
      }),
    ).toThrow(/bootfile name exceeds/);
  });

  it('10 — serverName writes into the BOOTP sname field at offset 44, NUL-padded byte-exact', () => {
    const name = 'boot.lan';
    const reply = buildReply(request, {
      messageType: DHCPOFFER,
      yiaddr: '192.168.1.100',
      serverId: '192.168.1.1',
      serverName: name,
      options: [],
    });
    const expected = Buffer.alloc(SNAME_FIELD_LEN);
    expected.write(name, 0, 'ascii');
    expect(reply.subarray(SNAME_OFFSET, SNAME_OFFSET + SNAME_FIELD_LEN)).toEqual(expected);
    expect(reparseReply(reply).siaddr).toBe('0.0.0.0');
  });

  it('11 — serverName accepts 63 bytes and rejects 64 (NUL-terminated sname field)', () => {
    const ok = buildReply(request, {
      messageType: DHCPOFFER,
      yiaddr: '192.168.1.100',
      serverId: '192.168.1.1',
      serverName: 'x'.repeat(SNAME_FIELD_LEN - 1),
      options: [],
    });
    expect(ok.subarray(SNAME_OFFSET, SNAME_OFFSET + SNAME_FIELD_LEN - 1).toString('ascii')).toBe(
      'x'.repeat(SNAME_FIELD_LEN - 1),
    );
    expect(() =>
      buildReply(request, {
        messageType: DHCPOFFER,
        yiaddr: '192.168.1.100',
        serverId: '192.168.1.1',
        serverName: 'x'.repeat(SNAME_FIELD_LEN),
        options: [],
      }),
    ).toThrow(/server name exceeds/);
  });

  it('12 — the bootfile→file write is unchanged when serverName is absent (regression)', () => {
    const reply = offer();
    expect(reply.subarray(FILE_OFFSET, FILE_OFFSET + 'undionly.kpxe'.length).toString('ascii')).toBe('undionly.kpxe');
    expect(reply.subarray(SNAME_OFFSET, SNAME_OFFSET + SNAME_FIELD_LEN)).toEqual(Buffer.alloc(SNAME_FIELD_LEN));
  });
});

describe('parsePacket option-overload (opt-52)', () => {
  function rawWithFields(opts: { main?: number[]; file?: number[]; sname?: number[] }): Buffer {
    const head = Buffer.alloc(28);
    head[0] = 0x01;
    head[1] = 0x01;
    head[2] = 0x06;
    head.writeUInt32BE(0x3903f326, 4);
    const chaddr = Buffer.alloc(16);
    macToBytes(CHADDR_MAC).copy(chaddr, 0);

    const sname = Buffer.alloc(SNAME_FIELD_LEN);
    if (opts.sname) {
      Buffer.from(opts.sname).copy(sname, 0);
    }
    const file = Buffer.alloc(FILE_FIELD_LEN);
    if (opts.file) {
      Buffer.from(opts.file).copy(file, 0);
    }
    const cookie = Buffer.from([0x63, 0x82, 0x53, 0x63]);
    const main = Buffer.from(opts.main ?? [0x35, 0x01, DHCPDISCOVER, OPT_END]);
    return Buffer.concat([head, chaddr, sname, file, cookie, main]);
  }

  const HOST = (b: number): number[] => [OPT_HOSTNAME, 1, b, OPT_END];

  it('1 — no opt-52: file/sname windows are ignored (regression)', () => {
    const msg = parsePacket(rawWithFields({ main: [0x35, 1, DHCPDISCOVER, OPT_END], file: HOST(0x61) }));
    expect(msg.options.has(OPT_HOSTNAME)).toBe(false);
  });

  it('2 — bit0 set: an option in the file window is parsed', () => {
    const msg = parsePacket(rawWithFields({ main: [OPT_OVERLOAD, 1, 0x1, OPT_END], file: HOST(0x61) }));
    expect(msg.options.get(OPT_HOSTNAME)).toEqual(Buffer.from([0x61]));
  });

  it('3 — bit1 set: an option in the sname window is parsed', () => {
    const msg = parsePacket(rawWithFields({ main: [OPT_OVERLOAD, 1, 0x2, OPT_END], sname: HOST(0x62) }));
    expect(msg.options.get(OPT_HOSTNAME)).toEqual(Buffer.from([0x62]));
  });

  it('4 — both bits set: file and sname both contribute', () => {
    const msg = parsePacket(
      rawWithFields({
        main: [OPT_OVERLOAD, 1, 0x3, OPT_END],
        file: [OPT_ROUTER, 4, 1, 1, 1, 1, OPT_END],
        sname: HOST(0x62),
      }),
    );
    expect(msg.options.get(OPT_ROUTER)).toEqual(Buffer.from([1, 1, 1, 1]));
    expect(msg.options.get(OPT_HOSTNAME)).toEqual(Buffer.from([0x62]));
  });

  it('5 — main wins over file for the same code', () => {
    const msg = parsePacket(
      rawWithFields({ main: [OPT_HOSTNAME, 1, 0x61, OPT_OVERLOAD, 1, 0x1, OPT_END], file: HOST(0x62) }),
    );
    expect(msg.options.get(OPT_HOSTNAME)).toEqual(Buffer.from([0x61]));
  });

  it('6 — file wins over sname for the same code', () => {
    const msg = parsePacket(
      rawWithFields({ main: [OPT_OVERLOAD, 1, 0x3, OPT_END], file: HOST(0x66), sname: HOST(0x73) }),
    );
    expect(msg.options.get(OPT_HOSTNAME)).toEqual(Buffer.from([0x66]));
  });

  it('7 — main > file > sname precedence across three regions', () => {
    const msg = parsePacket(
      rawWithFields({
        main: [OPT_HOSTNAME, 1, 0x6d, OPT_OVERLOAD, 1, 0x3, OPT_END],
        file: HOST(0x66),
        sname: HOST(0x73),
      }),
    );
    expect(msg.options.get(OPT_HOSTNAME)).toEqual(Buffer.from([0x6d]));
  });

  it('8 — opt-52 is honored only from main (a sname-window opt-52 is ignored)', () => {
    const msg = parsePacket(
      rawWithFields({ main: [0x35, 1, DHCPDISCOVER, OPT_END], sname: [OPT_OVERLOAD, 1, 0x1, ...HOST(0x61)] }),
    );
    expect(msg.options.has(OPT_HOSTNAME)).toBe(false);
    expect(msg.options.has(OPT_OVERLOAD)).toBe(false);
  });

  it('9 — a malformed file window is skipped without throwing; main stays intact', () => {
    const msg = parsePacket(
      rawWithFields({ main: [0x35, 1, DHCPDISCOVER, OPT_OVERLOAD, 1, 0x1, OPT_END], file: [OPT_HOSTNAME, 200, 0x61] }),
    );
    expect(msg.messageType).toBe(DHCPDISCOVER);
    expect(msg.options.has(OPT_HOSTNAME)).toBe(false);
  });

  it('10 — a malformed sname window is skipped without throwing', () => {
    const msg = parsePacket(
      rawWithFields({ main: [0x35, 1, DHCPDISCOVER, OPT_OVERLOAD, 1, 0x2, OPT_END], sname: [OPT_HOSTNAME, 200, 0x61] }),
    );
    expect(msg.messageType).toBe(DHCPDISCOVER);
    expect(msg.options.has(OPT_HOSTNAME)).toBe(false);
  });

  it('11 — zeroed (all-PAD) windows contribute nothing and do not throw', () => {
    const msg = parsePacket(rawWithFields({ main: [0x35, 1, DHCPDISCOVER, OPT_OVERLOAD, 1, 0x3, OPT_END] }));
    expect(msg.messageType).toBe(DHCPDISCOVER);
    expect(msg.options.size).toBe(2);
  });
});

describe('buildReply opt-57 ceiling and overload encode', () => {
  const baseRequest = parsePacket(rawDiscover());

  function requestWithMaxMsg(maxMsg: number): ReturnType<typeof parsePacket> {
    return { ...baseRequest, options: new Map([[OPT_MAX_MSG_SIZE, Buffer.from([maxMsg >> 8, maxMsg & 0xff])]]) };
  }

  function bigOptions(count: number, valueLen = 32): { code: number; value: Buffer }[] {
    const out: { code: number; value: Buffer }[] = [];
    for (let i = 0; i < count; i++) {
      out.push({ code: 128 + i, value: Buffer.alloc(valueLen, i + 1) });
    }
    return out;
  }

  it('13 — opt-57 absent OFFER is byte-identical to the pre-change golden buffer', () => {
    const reply = buildReply(baseRequest, {
      messageType: DHCPOFFER,
      yiaddr: '192.168.1.100',
      serverId: '192.168.1.1',
      siaddr: '192.168.1.1',
      bootfile: 'undionly.kpxe',
      options: [
        { code: OPT_LEASE_TIME, value: encodeUint32(3600) },
        { code: OPT_SUBNET_MASK, value: encodeIp('255.255.255.0') },
        { code: OPT_ROUTER, value: encodeIp('192.168.1.1') },
      ],
    });

    const golden = Buffer.alloc(548);
    golden[0] = BOOTREPLY;
    golden[1] = 0x01;
    golden[2] = 0x06;
    golden.writeUInt32BE(0x3903f326, 4);
    encodeIp('192.168.1.100').copy(golden, 16);
    encodeIp('192.168.1.1').copy(golden, 20);
    macToBytes(CHADDR_MAC).copy(golden, 28);
    golden.write('undionly.kpxe', FILE_OFFSET, 'ascii');
    golden.writeUInt32BE(0x63825363, 236);
    Buffer.from([
      53,
      1,
      DHCPOFFER,
      54,
      4,
      192,
      168,
      1,
      1,
      51,
      4,
      0x00,
      0x00,
      0x0e,
      0x10,
      1,
      4,
      255,
      255,
      255,
      0,
      3,
      4,
      192,
      168,
      1,
      1,
      OPT_END,
    ]).copy(golden, OPTIONS_OFFSET);

    expect(reply).toEqual(golden);
    expect(reply.length).toBe(548);
  });

  it('14 — opt-57 present on a normal reply produces the identical bytes', () => {
    const params = {
      messageType: DHCPOFFER,
      yiaddr: '192.168.1.100',
      serverId: '192.168.1.1',
      options: [{ code: OPT_ROUTER, value: encodeIp('192.168.1.1') }],
    };
    const withoutOpt57 = buildReply(baseRequest, params);
    const withOpt57 = buildReply(requestWithMaxMsg(1500), params);
    expect(withOpt57).toEqual(withoutOpt57);
  });

  it('15 — a high opt-57 lets an oversized set stay in the main region (no overload)', () => {
    const reply = buildReply(requestWithMaxMsg(1500), {
      messageType: DHCPOFFER,
      yiaddr: '192.168.1.100',
      serverId: '192.168.1.1',
      options: bigOptions(20),
    });
    const msg = reparseReply(reply);
    expect(msg.options.has(OPT_OVERLOAD)).toBe(false);
    expect(msg.options.get(128)).toEqual(Buffer.alloc(32, 1));
  });

  it('16 — opt-57 clamps low to the 548-byte struct floor and high to the packet max', () => {
    const low = buildReply(requestWithMaxMsg(40), {
      messageType: DHCPOFFER,
      yiaddr: '192.168.1.100',
      serverId: '192.168.1.1',
      options: [],
    });
    expect(low.length).toBe(BOOTP_MIN_REPLY_LEN);
    const high = buildReply(requestWithMaxMsg(0xffff), {
      messageType: DHCPOFFER,
      yiaddr: '192.168.1.100',
      serverId: '192.168.1.1',
      options: bigOptions(40),
    });
    expect(reparseReply(high).options.has(OPT_OVERLOAD)).toBe(false);
  });

  it('16b — opt-57 is the literal message ceiling, no UDP/IP overhead subtracted (RFC 2132 §9.10)', () => {
    const reply = buildReply(requestWithMaxMsg(600), {
      messageType: DHCPOFFER,
      yiaddr: '192.168.1.100',
      serverId: '192.168.1.1',
      options: bigOptions(10),
    });
    const msg = reparseReply(reply);
    expect(msg.options.has(OPT_OVERLOAD)).toBe(false);
    expect(msg.options.get(137)).toEqual(Buffer.alloc(32, 10));
  });

  it('17 — an oversized set spills one option into the file field with opt-52 bit0', () => {
    const reply = buildReply(requestWithMaxMsg(320), {
      messageType: DHCPOFFER,
      yiaddr: '192.168.1.100',
      serverId: '192.168.1.1',
      options: bigOptions(10, 30),
    });
    const bits = reparseReply(reply).options.get(OPT_OVERLOAD);
    expect(bits).toBeDefined();
    expect((bits?.[0] ?? 0) & 0x1).toBe(0x1);
    expect((bits?.[0] ?? 0) & 0x2).toBe(0x0);
  });

  it('17b — a spill larger than the file field fills file then sname (both opt-52 bits)', () => {
    const opts = bigOptions(13, 30);
    const reply = buildReply(requestWithMaxMsg(320), {
      messageType: DHCPOFFER,
      yiaddr: '192.168.1.100',
      serverId: '192.168.1.1',
      options: opts,
    });
    const msg = reparseReply(reply);
    const bits = msg.options.get(OPT_OVERLOAD)?.[0] ?? 0;
    expect(bits & 0x1).toBe(0x1);
    expect(bits & 0x2).toBe(0x2);
    for (const { code, value } of opts) {
      expect(msg.options.get(code)).toEqual(value);
    }
  });

  it('18 — round-trips: parsePacket(buildReply(oversized)) recovers all options with precedence', () => {
    const opts = bigOptions(10, 30);
    const reply = buildReply(requestWithMaxMsg(320), {
      messageType: DHCPOFFER,
      yiaddr: '192.168.1.100',
      serverId: '192.168.1.1',
      options: opts,
    });
    const msg = reparseReply(reply);
    for (const { code, value } of opts) {
      expect(msg.options.get(code)).toEqual(value);
    }
    expect(msg.messageType).toBe(DHCPOFFER);
    expect(decodeIp(msg.options.get(OPT_SERVER_ID) ?? Buffer.alloc(0))).toBe('192.168.1.1');
  });

  it('19 — throws when the option set exceeds file + sname capacity', () => {
    expect(() =>
      buildReply(requestWithMaxMsg(320), {
        messageType: DHCPOFFER,
        yiaddr: '192.168.1.100',
        serverId: '192.168.1.1',
        options: bigOptions(40, 200),
      }),
    ).toThrow(DhcpParseError);
  });

  it('20 — overload and a bootfile are mutually exclusive (throws)', () => {
    expect(() =>
      buildReply(requestWithMaxMsg(320), {
        messageType: DHCPOFFER,
        yiaddr: '192.168.1.100',
        serverId: '192.168.1.1',
        bootfile: 'undionly.kpxe',
        options: bigOptions(10, 30),
      }),
    ).toThrow(/bootfile/);
  });

  it('23 — overload and a serverName are mutually exclusive (throws)', () => {
    expect(() =>
      buildReply(requestWithMaxMsg(320), {
        messageType: DHCPOFFER,
        yiaddr: '192.168.1.100',
        serverId: '192.168.1.1',
        serverName: 'boot.lan',
        options: bigOptions(10, 30),
      }),
    ).toThrow(/sname/);
  });

  it('21 — the 300-byte floor is preserved when overload fires', () => {
    const reply = buildReply(requestWithMaxMsg(320), {
      messageType: DHCPOFFER,
      yiaddr: '192.168.1.100',
      serverId: '192.168.1.1',
      options: bigOptions(10, 30),
    });
    expect(reply.length).toBeGreaterThanOrEqual(BOOTP_MIN_REPLY_LEN);
  });

  it('22 — the 548-byte floor holds without overload (regression)', () => {
    const reply = buildReply(baseRequest, {
      messageType: DHCPNAK,
      yiaddr: '0.0.0.0',
      serverId: '192.168.1.1',
      options: [],
    });
    expect(reply.length).toBe(BOOTP_MIN_REPLY_LEN);
  });
});

function rawBootReply(opts: { giaddr?: string; yiaddr?: string } = {}): Buffer {
  const head = Buffer.alloc(28);
  head[0] = BOOTREPLY;
  head[1] = 0x01;
  head[2] = 0x06;
  head.writeUInt32BE(0x3903f326, 4);
  encodeIp(opts.yiaddr ?? '10.0.0.55').copy(head, 16);
  encodeIp(opts.giaddr ?? '10.0.0.1').copy(head, 24);

  const chaddr = Buffer.alloc(16);
  macToBytes(CHADDR_MAC).copy(chaddr, 0);
  const snameFile = Buffer.alloc(64 + 128);
  const cookie = Buffer.from([0x63, 0x82, 0x53, 0x63]);
  const options = Buffer.from([0x35, 0x01, DHCPOFFER, 0xff]);
  return Buffer.concat([head, chaddr, snameFile, cookie, options]);
}

describe('parsePacket BOOTREPLY', () => {
  it('rejects a stray BOOTREPLY (op=2) on :67', () => {
    expect(() => parsePacket(rawBootReply({ giaddr: '10.0.0.1', yiaddr: '10.0.0.55' }))).toThrow(DhcpParseError);
  });
});
