import { describe, expect, it } from 'vitest';

import {
  DnsParseError,
  FLAG_TC,
  QTYPE_A,
  QTYPE_AAAA,
  QTYPE_PTR,
  buildAAAAResponse,
  buildAResponse,
  buildEmptyNoError,
  buildNotImplemented,
  buildNotImplementedHeaderOnly,
  buildNxdomain,
  buildPtrResponse,
  buildServfail,
  clampAnswerTtls,
  clampTtl,
  encodeDnsName,
  packIpv6,
  parseQuery,
  readOpcode,
  truncateForUdp,
} from '../protocol.js';

const hex = (s: string): Buffer => Buffer.from(s, 'hex');

const QUERY_BROKKR_LAN_A = hex('1234010000010000000000000662726f6b6b72036c616e0000010001');

const QUERY_BROKKR_LAN_AAAA = hex('1234010000010000000000000662726f6b6b72036c616e00001c0001');

const QUERY_EXAMPLE_COM_A = hex('abcd01000001000000000000076578616d706c6503636f6d0000010001');

const QUERY_BROKKR_LAN_A_UPPERCASE = hex('1234010000010000000000000642524f4b4b52034c414e0000010001');

const EXPECTED_A_RESPONSE_192_168_1_5 = hex(
  '123485800001000100000000' +
    '0662726f6b6b72036c616e00' +
    '00010001' +
    'c00c' +
    '0001' +
    '0001' +
    '0000003c' +
    '0004' +
    'c0a80105',
);

const EXPECTED_EMPTY_AAAA_RESPONSE = hex('123485800001000000000000' + '0662726f6b6b72036c616e00' + '001c0001');

const EXPECTED_SERVFAIL_EXAMPLE = hex('abcd81820001000000000000' + '076578616d706c6503636f6d00' + '00010001');

const EXPECTED_NXDOMAIN_EXAMPLE = hex('abcd85830001000000000000' + '076578616d706c6503636f6d00' + '00010001');

describe('parseQuery', () => {
  it('extracts txnId, qname, qtype, rd', () => {
    const { txnId, qname, qtype, recursionDesired } = parseQuery(QUERY_BROKKR_LAN_A);
    expect(txnId).toBe(0x1234);
    expect(qname).toBe('brokkr.lan');
    expect(qtype).toBe(QTYPE_A);
    expect(recursionDesired).toBe(true);
  });

  it('parses AAAA qtype', () => {
    const { qname, qtype } = parseQuery(QUERY_BROKKR_LAN_AAAA);
    expect(qname).toBe('brokkr.lan');
    expect(qtype).toBe(QTYPE_AAAA);
  });

  it('normalizes qname to lowercase', () => {
    const { qname } = parseQuery(QUERY_BROKKR_LAN_A_UPPERCASE);
    expect(qname).toBe('brokkr.lan');
  });

  it('rejects packet shorter than header', () => {
    expect(() => parseQuery(hex('1234'))).toThrow(DnsParseError);
    expect(() => parseQuery(hex('1234'))).toThrow(/shorter than DNS header/);
  });

  it('rejects a response packet (QR bit set)', () => {
    const response = hex('1234810000010000000000000662726f6b6b72036c616e0000010001');
    expect(() => parseQuery(response)).toThrow(DnsParseError);
    expect(() => parseQuery(response)).toThrow(/response, not a query/);
  });

  it('rejects qdcount zero', () => {
    const bad = hex('123401000000000000000000');
    expect(() => parseQuery(bad)).toThrow(/no question/);
  });

  it('rejects a multi-question query (qdcount > 1)', () => {
    const q = '0662726f6b6b72036c616e0000010001';
    const bad = hex('123401000002000000000000' + q + q);
    expect(() => parseQuery(bad)).toThrow(DnsParseError);
    expect(() => parseQuery(bad)).toThrow(/multi-question/);
  });

  it('accepts a single question followed by a trailing OPT record (qdcount stays 1)', () => {
    const question = '0662726f6b6b72036c616e0000010001';
    const optRecord = '0000291000000000000000';
    const packet = hex('123401000001000000000001' + question + optRecord);
    const { qname, qtype } = parseQuery(packet);
    expect(qname).toBe('brokkr.lan');
    expect(qtype).toBe(QTYPE_A);
  });

  it('rejects compression pointer in question', () => {
    const bad = hex('123401000001000000000000c00000010001');
    expect(() => parseQuery(bad)).toThrow(/compression pointer/);
  });

  it('rejects truncated qname', () => {
    const bad = hex('1234010000010000000000000a616263');
    expect(() => parseQuery(bad)).toThrow(/runs past packet end/);
  });

  it('rejects truncated qtype', () => {
    const bad = hex('1234010000010000000000000662726f6b6b72036c616e00');
    expect(() => parseQuery(bad)).toThrow(/truncated qtype/);
  });

  it('rd flag false when not set', () => {
    const noRd = hex('1234000000010000000000000662726f6b6b72036c616e0000010001');
    const { recursionDesired } = parseQuery(noRd);
    expect(recursionDesired).toBe(false);
  });

  it('reads qclass (IN by default)', () => {
    const { qclass } = parseQuery(QUERY_BROKKR_LAN_A);
    expect(qclass).toBe(1);
  });

  it('extracts opcode 0 for a standard query', () => {
    expect(parseQuery(QUERY_BROKKR_LAN_A).opcode).toBe(0);
  });

  it('extracts the 4-bit opcode from the flags word (IQUERY=1, STATUS=2)', () => {
    const iquery = Buffer.from(QUERY_BROKKR_LAN_A);
    iquery.writeUInt16BE(0x0900, 2);
    expect(parseQuery(iquery).opcode).toBe(1);

    const status = Buffer.from(QUERY_BROKKR_LAN_A);
    status.writeUInt16BE(0x1100, 2);
    expect(parseQuery(status).opcode).toBe(2);
  });

  const queryWithNameOctets = (nameOctets: number): Buffer => {
    const header = Buffer.alloc(12);
    header.writeUInt16BE(0x1234, 0);
    header.writeUInt16BE(0x0100, 2);
    header.writeUInt16BE(1, 4);
    const labels: Buffer[] = [];
    let remaining = nameOctets - 1;
    while (remaining > 0) {
      const len = Math.min(63, remaining - 1);
      labels.push(Buffer.from([len]), Buffer.alloc(len, 0x61));
      remaining -= 1 + len;
    }
    labels.push(Buffer.from([0]));
    const qtail = Buffer.alloc(4);
    qtail.writeUInt16BE(1, 0);
    qtail.writeUInt16BE(1, 2);
    return Buffer.concat([header, ...labels, qtail]);
  };

  it('rejects a qname exceeding 255 octets (5x63 = 320 inside a <512B packet)', () => {
    const oversized = queryWithNameOctets(321);
    expect(oversized.length).toBeLessThan(512);
    expect(() => parseQuery(oversized)).toThrow(DnsParseError);
    expect(() => parseQuery(oversized)).toThrow(/255 octets/);
  });

  it('accepts a qname at exactly 255 octets', () => {
    expect(() => parseQuery(queryWithNameOctets(255))).not.toThrow();
  });

  it('rejects a qname at 256 octets (one past the cap)', () => {
    expect(() => parseQuery(queryWithNameOctets(256))).toThrow(/255 octets/);
  });
});

describe('buildAResponse', () => {
  it('byte-exact response for known query', () => {
    const response = buildAResponse(QUERY_BROKKR_LAN_A, ['192.168.1.5'], 60);
    expect(response.equals(EXPECTED_A_RESPONSE_192_168_1_5)).toBe(true);
  });

  it('preserves transaction id', () => {
    const response = buildAResponse(QUERY_BROKKR_LAN_A, ['10.0.0.1'], 300);
    expect(response.subarray(0, 2).equals(QUERY_BROKKR_LAN_A.subarray(0, 2))).toBe(true);
  });

  it('sets QR, AA, RA bits and NOERROR rcode', () => {
    const response = buildAResponse(QUERY_BROKKR_LAN_A, ['10.0.0.1'], 60);
    const flags = response.readUInt16BE(2);
    expect(flags & 0x8000).toBeTruthy();
    expect(flags & 0x0400).toBeTruthy();
    expect(flags & 0x0080).toBeTruthy();
    expect(flags & 0x0f).toBe(0);
  });

  it('echoes rd flag from query', () => {
    const responseRd = buildAResponse(QUERY_BROKKR_LAN_A, ['10.0.0.1'], 60);
    expect(responseRd.readUInt16BE(2) & 0x0100).toBeTruthy();

    const noRdQuery = hex('1234000000010000000000000662726f6b6b72036c616e0000010001');
    const responseNoRd = buildAResponse(noRdQuery, ['10.0.0.1'], 60);
    expect(responseNoRd.readUInt16BE(2) & 0x0100).toBeFalsy();
  });

  it('has one question and one answer', () => {
    const response = buildAResponse(QUERY_BROKKR_LAN_A, ['192.168.1.5'], 60);
    expect(response.readUInt16BE(4)).toBe(1);
    expect(response.readUInt16BE(6)).toBe(1);
  });

  it('answer uses name compression pointer', () => {
    const response = buildAResponse(QUERY_BROKKR_LAN_A, ['192.168.1.5'], 60);
    expect(response.subarray(28, 30).equals(hex('c00c'))).toBe(true);
  });

  it('ttl is encoded as uint32 be', () => {
    const response = buildAResponse(QUERY_BROKKR_LAN_A, ['192.168.1.5'], 3600);
    expect(response.readUInt32BE(34)).toBe(3600);
  });

  it('rdata is packed ipv4', () => {
    const response = buildAResponse(QUERY_BROKKR_LAN_A, ['172.16.12.14'], 60);
    expect(response.subarray(40, 44).equals(Buffer.from([172, 16, 12, 14]))).toBe(true);
  });

  it('rejects non-A qtype', () => {
    expect(() => buildAResponse(QUERY_BROKKR_LAN_AAAA, ['192.168.1.5'], 60)).toThrow(/expected A/);
  });

  it('rejects empty ip list', () => {
    expect(() => buildAResponse(QUERY_BROKKR_LAN_A, [], 60)).toThrow(/at least one/);
  });
});

describe('buildAResponse (multi-IP)', () => {
  it('has n answers', () => {
    const ips = ['10.0.0.1', '10.0.0.2', '10.0.0.3'];
    const response = buildAResponse(QUERY_BROKKR_LAN_A, ips, 60);
    expect(response.readUInt16BE(6)).toBe(3);
  });

  it('preserves order', () => {
    const ips = ['10.0.0.5', '172.16.12.14', '192.168.1.1'];
    const response = buildAResponse(QUERY_BROKKR_LAN_A, ips, 60);
    ips.forEach((ip, i) => {
      const answerStart = 28 + i * 16;
      const rdata = response.subarray(answerStart + 12, answerStart + 16);
      const expected = Buffer.from(ip.split('.').map((o) => Number.parseInt(o, 10)));
      expect(rdata.equals(expected)).toBe(true);
    });
  });

  it('uses name compression for every answer', () => {
    const ips = ['10.0.0.1', '10.0.0.2'];
    const response = buildAResponse(QUERY_BROKKR_LAN_A, ips, 60);
    for (let i = 0; i < ips.length; i++) {
      const answerStart = 28 + i * 16;
      expect(response.subarray(answerStart, answerStart + 2).equals(hex('c00c'))).toBe(true);
    }
  });

  it('single ip in list matches single-ip shape', () => {
    const response = buildAResponse(QUERY_BROKKR_LAN_A, ['192.168.1.5'], 60);
    expect(response.equals(EXPECTED_A_RESPONSE_192_168_1_5)).toBe(true);
  });
});

describe('buildNxdomain', () => {
  it('byte-exact response', () => {
    const response = buildNxdomain(QUERY_EXAMPLE_COM_A);
    expect(response.equals(EXPECTED_NXDOMAIN_EXAMPLE)).toBe(true);
  });

  it('rcode is nxdomain', () => {
    const response = buildNxdomain(QUERY_EXAMPLE_COM_A);
    expect(response.readUInt16BE(2) & 0x0f).toBe(3);
  });

  it('aa bit set', () => {
    const response = buildNxdomain(QUERY_EXAMPLE_COM_A);
    expect(response.readUInt16BE(2) & 0x0400).toBeTruthy();
  });

  it('ancount is zero', () => {
    const response = buildNxdomain(QUERY_EXAMPLE_COM_A);
    expect(response.readUInt16BE(6)).toBe(0);
  });
});

describe('buildEmptyNoError', () => {
  it('byte-exact response for aaaa query', () => {
    const response = buildEmptyNoError(QUERY_BROKKR_LAN_AAAA);
    expect(response.equals(EXPECTED_EMPTY_AAAA_RESPONSE)).toBe(true);
  });

  it('ancount is zero', () => {
    const response = buildEmptyNoError(QUERY_BROKKR_LAN_AAAA);
    expect(response.readUInt16BE(6)).toBe(0);
  });

  it('rcode is noerror and aa set', () => {
    const response = buildEmptyNoError(QUERY_BROKKR_LAN_AAAA);
    const flags = response.readUInt16BE(2);
    expect(flags & 0x0f).toBe(0);
    expect(flags & 0x0400).toBeTruthy();
  });

  it('question is echoed', () => {
    const response = buildEmptyNoError(QUERY_BROKKR_LAN_AAAA);
    expect(response.subarray(12).equals(QUERY_BROKKR_LAN_AAAA.subarray(12))).toBe(true);
  });
});

describe('buildServfail', () => {
  it('byte-exact response', () => {
    const response = buildServfail(QUERY_EXAMPLE_COM_A);
    expect(response.equals(EXPECTED_SERVFAIL_EXAMPLE)).toBe(true);
  });

  it('rcode is servfail', () => {
    const response = buildServfail(QUERY_EXAMPLE_COM_A);
    expect(response.readUInt16BE(2) & 0x0f).toBe(2);
  });

  it('aa bit not set', () => {
    const response = buildServfail(QUERY_EXAMPLE_COM_A);
    expect(response.readUInt16BE(2) & 0x0400).toBeFalsy();
  });
});

describe('buildNotImplemented', () => {
  const iquery = ((): Buffer => {
    const q = Buffer.from(QUERY_BROKKR_LAN_A);
    q.writeUInt16BE(0x0900, 2);
    return q;
  })();

  it('rcode is NOTIMP (4)', () => {
    const response = buildNotImplemented(iquery);
    expect(response.readUInt16BE(2) & 0x0f).toBe(4);
  });

  it('sets QR and echoes the request opcode in the response', () => {
    const flags = buildNotImplemented(iquery).readUInt16BE(2);
    expect(flags & 0x8000).toBeTruthy();
    expect((flags >> 11) & 0x0f).toBe(1);
  });

  it('ancount is zero and the question is echoed', () => {
    const response = buildNotImplemented(iquery);
    expect(response.readUInt16BE(6)).toBe(0);
    expect(response.subarray(12).equals(iquery.subarray(12))).toBe(true);
  });

  it('preserves the transaction id', () => {
    expect(buildNotImplemented(iquery).readUInt16BE(0)).toBe(0x1234);
  });

  it('clears RA (non-recursive authoritative server)', () => {
    expect(buildNotImplemented(iquery).readUInt16BE(2) & 0x0080).toBe(0);
  });

  it('copies RD from the request', () => {
    expect(buildNotImplemented(iquery).readUInt16BE(2) & 0x0100).toBeTruthy();
    const noRd = Buffer.from(iquery);
    noRd.writeUInt16BE(0x0800, 2);
    expect(buildNotImplemented(noRd).readUInt16BE(2) & 0x0100).toBe(0);
  });
});

describe('buildNotImplementedHeaderOnly', () => {
  const iqueryHeaderOnly = ((): Buffer => {
    const h = Buffer.alloc(12);
    h.writeUInt16BE(0x1234, 0);
    h.writeUInt16BE(0x0800, 2);
    return h;
  })();

  it('is a 12-byte, question-less header with all counts zero', () => {
    const out = buildNotImplementedHeaderOnly(iqueryHeaderOnly);
    expect(out.length).toBe(12);
    expect(out.readUInt16BE(4)).toBe(0);
    expect(out.readUInt16BE(6)).toBe(0);
    expect(out.readUInt16BE(8)).toBe(0);
    expect(out.readUInt16BE(10)).toBe(0);
  });

  it('sets QR + NOTIMP and echoes txn id and opcode', () => {
    const out = buildNotImplementedHeaderOnly(iqueryHeaderOnly);
    expect(out.readUInt16BE(0)).toBe(0x1234);
    const flags = out.readUInt16BE(2);
    expect(flags & 0x8000).toBeTruthy();
    expect(flags & 0x0f).toBe(4);
    expect((flags >> 11) & 0x0f).toBe(1);
  });

  it('clears RA, consistent with buildNotImplemented', () => {
    expect(buildNotImplementedHeaderOnly(iqueryHeaderOnly).readUInt16BE(2) & 0x0080).toBe(0);
  });

  it('copies RD from the request header (RFC 1035 §4.1.1)', () => {
    expect(buildNotImplementedHeaderOnly(iqueryHeaderOnly).readUInt16BE(2) & 0x0100).toBe(0);
    const rdSet = Buffer.from(iqueryHeaderOnly);
    rdSet.writeUInt16BE(0x0900, 2);
    expect(buildNotImplementedHeaderOnly(rdSet).readUInt16BE(2) & 0x0100).toBeTruthy();
  });
});

describe('readOpcode', () => {
  it('reads opcode 0 from a standard query header', () => {
    expect(readOpcode(QUERY_BROKKR_LAN_A)).toBe(0);
  });

  it('reads the opcode nibble from bits 11-14 of the flags word', () => {
    const status = Buffer.from(QUERY_BROKKR_LAN_A);
    status.writeUInt16BE(0x1100, 2);
    expect(readOpcode(status)).toBe(2);
  });
});

describe('truncateForUdp', () => {
  const oversize = ((): Buffer => {
    const base = buildAResponse(QUERY_BROKKR_LAN_A, ['192.168.1.5'], 60);
    const padding = Buffer.alloc(600, 0);
    const buf = Buffer.concat([base, padding]);
    buf.writeUInt16BE(50, 6);
    return buf;
  })();

  it('returns short responses unchanged (<= 512)', () => {
    const small = buildAResponse(QUERY_BROKKR_LAN_A, ['192.168.1.5'], 60);
    expect(truncateForUdp(small)).toBe(small);
  });

  it('caps an oversize response to <= 512 bytes', () => {
    expect(oversize.length).toBeGreaterThan(512);
    expect(truncateForUdp(oversize).length).toBeLessThanOrEqual(512);
  });

  it('sets the TC bit and zeroes the answer/authority/additional counts', () => {
    const out = truncateForUdp(oversize);
    expect(out.readUInt16BE(2) & FLAG_TC).toBeTruthy();
    expect(out.readUInt16BE(6)).toBe(0);
    expect(out.readUInt16BE(8)).toBe(0);
    expect(out.readUInt16BE(10)).toBe(0);
  });

  it('preserves the header id and the echoed question', () => {
    const out = truncateForUdp(oversize);
    expect(out.readUInt16BE(0)).toBe(0x1234);
    expect(out.readUInt16BE(4)).toBe(1);
    expect(out.subarray(12).equals(QUERY_BROKKR_LAN_A.subarray(12))).toBe(true);
  });
});

describe('round-trip', () => {
  it('response echoes a parseable question', () => {
    const response = buildAResponse(QUERY_BROKKR_LAN_A, ['192.168.1.5'], 60);
    const asQuery = Buffer.from(response);
    asQuery.writeUInt16BE(response.readUInt16BE(2) & ~0x8000, 2);
    const { txnId, qname, qtype } = parseQuery(asQuery);
    expect(txnId).toBe(0x1234);
    expect(qname).toBe('brokkr.lan');
    expect(qtype).toBe(QTYPE_A);
  });
});

describe('clampTtl', () => {
  it('treats max=0 as unbounded above, min=0 as unbounded below', () => {
    expect(clampTtl(5, 0, 0)).toBe(5);
    expect(clampTtl(9999, 0, 0)).toBe(9999);
    expect(clampTtl(1, 10, 0)).toBe(10);
    expect(clampTtl(9999, 0, 100)).toBe(100);
  });
});

describe('clampAnswerTtls', () => {
  const withAnswerTtl = (ttl: number): Buffer => buildAResponse(QUERY_BROKKR_LAN_A, ['192.168.1.5'], ttl);
  const answerTtlOffset = QUERY_BROKKR_LAN_A.length + 6;

  it('returns the same Buffer ref when both bounds are disabled (min=0,max=0)', () => {
    const buf = withAnswerTtl(60);
    expect(clampAnswerTtls(buf, { min: 0, max: 0 })).toBe(buf);
  });

  it('caps a TTL above max', () => {
    const out = clampAnswerTtls(withAnswerTtl(9999), { min: 0, max: 100 });
    expect(out.readUInt32BE(answerTtlOffset)).toBe(100);
  });

  it('floors a TTL below min', () => {
    const out = clampAnswerTtls(withAnswerTtl(1), { min: 30, max: 0 });
    expect(out.readUInt32BE(answerTtlOffset)).toBe(30);
  });

  it('leaves an in-range TTL untouched', () => {
    const out = clampAnswerTtls(withAnswerTtl(60), { min: 30, max: 100 });
    expect(out.readUInt32BE(answerTtlOffset)).toBe(60);
  });

  it('does not clamp an OPT (type 41) pseudo-RR TTL', () => {
    const base = withAnswerTtl(9999);
    const opt = Buffer.alloc(11);
    opt.writeUInt8(0, 0);
    opt.writeUInt16BE(41, 1);
    opt.writeUInt16BE(4096, 3);
    opt.writeUInt32BE(0x11111111, 5);
    opt.writeUInt16BE(0, 9);
    const buf = Buffer.concat([base, opt]);
    buf.writeUInt16BE(2, 6);
    const out = clampAnswerTtls(buf, { min: 0, max: 100 });
    expect(out.readUInt32BE(answerTtlOffset)).toBe(100);
    expect(out.readUInt32BE(base.length + 5)).toBe(0x11111111);
  });

  it('returns the original buffer when an RR is truncated (all-or-nothing)', () => {
    const buf = withAnswerTtl(9999).subarray(0, QUERY_BROKKR_LAN_A.length + 4);
    expect(clampAnswerTtls(buf, { min: 0, max: 100 })).toBe(buf);
  });

  it('is all-or-nothing when a later RR is malformed (leading RRs stay untouched)', () => {
    const base = withAnswerTtl(9999);
    const buf = Buffer.concat([base, Buffer.from([0x00, 0x00, 41])]);
    buf.writeUInt16BE(2, 6);
    const out = clampAnswerTtls(buf, { min: 0, max: 100 });
    expect(out).toBe(buf);
    expect(out.readUInt32BE(answerTtlOffset)).toBe(9999);
  });
});

const QUERY_PTR_1_168_192 = hex(
  'abcd0100000100000000000001310331363803313932' + '07696e2d61646472046172706100000c0001',
);

const QUERY_BROKKR_LAN_PTR = hex(
  '12340100000100000000000001350131033136380331393207696e2d61646472046172706100000c0001',
);

describe('QTYPE_PTR export', () => {
  it('equals 12', () => {
    expect(QTYPE_PTR).toBe(12);
  });
});

describe('buildAAAAResponse', () => {
  it('builds a valid AAAA response for a single IPv6 address', () => {
    const response = buildAAAAResponse(QUERY_BROKKR_LAN_AAAA, ['2001:0db8:0000:0000:0000:0000:0000:0001'], 60);
    const flags = response.readUInt16BE(2);
    expect(flags & 0x8000).toBeTruthy();
    expect(flags & 0x0400).toBeTruthy();
    expect(flags & 0x0080).toBeTruthy();
    expect(flags & 0x0f).toBe(0);
    expect(response.readUInt16BE(4)).toBe(1);
    expect(response.readUInt16BE(6)).toBe(1);
    const questionLen = QUERY_BROKKR_LAN_AAAA.length - 12;
    const answerStart = 12 + questionLen;
    expect(response.readUInt16BE(answerStart + 10)).toBe(16);
    const rdata = response.subarray(answerStart + 12, answerStart + 12 + 16);
    expect(rdata.readUInt16BE(0)).toBe(0x2001);
    expect(rdata.readUInt16BE(2)).toBe(0x0db8);
    expect(rdata.readUInt16BE(14)).toBe(0x0001);
  });

  it('builds a response with multiple AAAA answers', () => {
    const ips = ['2001:db8::1', '2001:db8::2', 'fe80::1'];
    const response = buildAAAAResponse(QUERY_BROKKR_LAN_AAAA, ips, 120);
    expect(response.readUInt16BE(6)).toBe(3);
    const questionLen = QUERY_BROKKR_LAN_AAAA.length - 12;
    for (let i = 0; i < ips.length; i++) {
      const answerStart = 12 + questionLen + i * 28;
      expect(response.subarray(answerStart, answerStart + 2).equals(hex('c00c'))).toBe(true);
      expect(response.readUInt16BE(answerStart + 2)).toBe(QTYPE_AAAA);
      expect(response.readUInt16BE(answerStart + 10)).toBe(16);
    }
  });

  it('throws DnsParseError if called with wrong qtype', () => {
    expect(() => buildAAAAResponse(QUERY_BROKKR_LAN_A, ['::1'], 60)).toThrow(DnsParseError);
    expect(() => buildAAAAResponse(QUERY_BROKKR_LAN_A, ['::1'], 60)).toThrow(/expected AAAA/);
  });

  it('throws DnsParseError if called with empty answerIps', () => {
    expect(() => buildAAAAResponse(QUERY_BROKKR_LAN_AAAA, [], 60)).toThrow(DnsParseError);
    expect(() => buildAAAAResponse(QUERY_BROKKR_LAN_AAAA, [], 60)).toThrow(/at least one/);
  });

  it('handles full-form IPv6 address', () => {
    const response = buildAAAAResponse(QUERY_BROKKR_LAN_AAAA, ['2001:0db8:0000:0000:0000:0000:0000:0001'], 60);
    const questionLen = QUERY_BROKKR_LAN_AAAA.length - 12;
    const rdata = response.subarray(12 + questionLen + 12, 12 + questionLen + 12 + 16);
    expect(rdata.readUInt16BE(0)).toBe(0x2001);
    expect(rdata.readUInt16BE(2)).toBe(0x0db8);
    for (let i = 2; i < 7; i++) {
      expect(rdata.readUInt16BE(i * 2)).toBe(0x0000);
    }
    expect(rdata.readUInt16BE(14)).toBe(0x0001);
  });

  it('handles abbreviated (::) IPv6 address', () => {
    const response = buildAAAAResponse(QUERY_BROKKR_LAN_AAAA, ['::1'], 60);
    const questionLen = QUERY_BROKKR_LAN_AAAA.length - 12;
    const rdata = response.subarray(12 + questionLen + 12, 12 + questionLen + 12 + 16);
    for (let i = 0; i < 7; i++) {
      expect(rdata.readUInt16BE(i * 2)).toBe(0);
    }
    expect(rdata.readUInt16BE(14)).toBe(1);
  });

  it('preserves transaction id', () => {
    const response = buildAAAAResponse(QUERY_BROKKR_LAN_AAAA, ['::1'], 60);
    expect(response.readUInt16BE(0)).toBe(0x1234);
  });

  it('echoes rd flag from query', () => {
    const responseRd = buildAAAAResponse(QUERY_BROKKR_LAN_AAAA, ['::1'], 60);
    expect(responseRd.readUInt16BE(2) & 0x0100).toBeTruthy();

    const noRdQuery = Buffer.from(QUERY_BROKKR_LAN_AAAA);
    noRdQuery.writeUInt16BE(0x0000, 2);
    noRdQuery.writeUInt16BE(1, 4);
    const responseNoRd = buildAAAAResponse(noRdQuery, ['::1'], 60);
    expect(responseNoRd.readUInt16BE(2) & 0x0100).toBeFalsy();
  });

  it('ttl is encoded as uint32 be', () => {
    const response = buildAAAAResponse(QUERY_BROKKR_LAN_AAAA, ['::1'], 3600);
    const questionLen = QUERY_BROKKR_LAN_AAAA.length - 12;
    expect(response.readUInt32BE(12 + questionLen + 6)).toBe(3600);
  });

  it('uses name compression pointer for every answer', () => {
    const ips = ['::1', '::2'];
    const response = buildAAAAResponse(QUERY_BROKKR_LAN_AAAA, ips, 60);
    const questionLen = QUERY_BROKKR_LAN_AAAA.length - 12;
    for (let i = 0; i < ips.length; i++) {
      const answerStart = 12 + questionLen + i * 28;
      expect(response.subarray(answerStart, answerStart + 2).equals(hex('c00c'))).toBe(true);
    }
  });

  it('rr type is AAAA (28)', () => {
    const response = buildAAAAResponse(QUERY_BROKKR_LAN_AAAA, ['::1'], 60);
    const questionEnd = QUERY_BROKKR_LAN_AAAA.length;
    expect(response.readUInt16BE(questionEnd + 2)).toBe(28);
  });

  it('rdlength is 16', () => {
    const response = buildAAAAResponse(QUERY_BROKKR_LAN_AAAA, ['::1'], 60);
    const questionEnd = QUERY_BROKKR_LAN_AAAA.length;
    expect(response.readUInt16BE(questionEnd + 10)).toBe(16);
  });

  it('rdata contains packed ipv6 bytes', () => {
    const response = buildAAAAResponse(QUERY_BROKKR_LAN_AAAA, ['2001:db8::1'], 60);
    const rdataStart = QUERY_BROKKR_LAN_AAAA.length + 12;
    expect(response.readUInt16BE(rdataStart)).toBe(0x2001);
    expect(response.readUInt16BE(rdataStart + 2)).toBe(0x0db8);
    expect(response.readUInt16BE(rdataStart + 14)).toBe(0x0001);
  });

  it('each answer record is exactly 28 bytes', () => {
    const response = buildAAAAResponse(QUERY_BROKKR_LAN_AAAA, ['::1', '::2'], 60);
    const questionLen = QUERY_BROKKR_LAN_AAAA.length - 12;
    const totalLen = 12 + questionLen + 2 * 28;
    expect(response.length).toBe(totalLen);
  });
});

describe('buildPtrResponse', () => {
  it('builds a valid PTR response', () => {
    const response = buildPtrResponse(QUERY_BROKKR_LAN_PTR, ['server-1.lan'], 60);
    const flags = response.readUInt16BE(2);
    expect(flags & 0x8000).toBeTruthy();
    expect(flags & 0x0400).toBeTruthy();
    expect(flags & 0x0080).toBeTruthy();
    expect(flags & 0x0f).toBe(0);
    expect(response.readUInt16BE(4)).toBe(1);
    expect(response.readUInt16BE(6)).toBe(1);
    const questionLen = QUERY_BROKKR_LAN_PTR.length - 12;
    const answerStart = 12 + questionLen;
    expect(response.readUInt16BE(answerStart + 2)).toBe(12);
    const rdlength = response.readUInt16BE(answerStart + 10);
    const rdata = response.subarray(answerStart + 12, answerStart + 12 + rdlength);
    const expectedName = encodeDnsName('server-1.lan');
    expect(rdata.equals(expectedName)).toBe(true);
  });

  it('handles multi-label hostnames', () => {
    const response = buildPtrResponse(QUERY_BROKKR_LAN_PTR, ['server-1.zone.lan'], 60);
    const questionLen = QUERY_BROKKR_LAN_PTR.length - 12;
    const answerStart = 12 + questionLen;
    const rdlength = response.readUInt16BE(answerStart + 10);
    const rdata = response.subarray(answerStart + 12, answerStart + 12 + rdlength);
    const expectedName = encodeDnsName('server-1.zone.lan');
    expect(rdata.equals(expectedName)).toBe(true);
  });

  it('handles trailing-dot hostnames', () => {
    const response = buildPtrResponse(QUERY_BROKKR_LAN_PTR, ['server-1.lan.'], 60);
    const questionLen = QUERY_BROKKR_LAN_PTR.length - 12;
    const answerStart = 12 + questionLen;
    const rdlength = response.readUInt16BE(answerStart + 10);
    const rdata = response.subarray(answerStart + 12, answerStart + 12 + rdlength);
    const expectedName = encodeDnsName('server-1.lan');
    expect(rdata.equals(expectedName)).toBe(true);
  });

  it('throws DnsParseError if called with wrong qtype', () => {
    expect(() => buildPtrResponse(QUERY_BROKKR_LAN_A, ['server-1.lan'], 60)).toThrow(DnsParseError);
    expect(() => buildPtrResponse(QUERY_BROKKR_LAN_A, ['server-1.lan'], 60)).toThrow(/expected PTR/);
  });

  it('preserves transaction id', () => {
    const response = buildPtrResponse(QUERY_BROKKR_LAN_PTR, ['server-1.lan'], 60);
    expect(response.readUInt16BE(0)).toBe(0x1234);
  });

  it('uses name compression pointer', () => {
    const response = buildPtrResponse(QUERY_BROKKR_LAN_PTR, ['server-1.lan'], 60);
    const questionLen = QUERY_BROKKR_LAN_PTR.length - 12;
    const answerStart = 12 + questionLen;
    expect(response.subarray(answerStart, answerStart + 2).equals(hex('c00c'))).toBe(true);
  });

  it('ttl is encoded as uint32 be', () => {
    const response = buildPtrResponse(QUERY_BROKKR_LAN_PTR, ['server-1.lan'], 7200);
    const questionLen = QUERY_BROKKR_LAN_PTR.length - 12;
    expect(response.readUInt32BE(12 + questionLen + 6)).toBe(7200);
  });

  it('echoes rd flag from query', () => {
    const responseRd = buildPtrResponse(QUERY_BROKKR_LAN_PTR, ['server-1.lan'], 60);
    expect(responseRd.readUInt16BE(2) & 0x0100).toBeTruthy();

    const noRdQuery = Buffer.from(QUERY_BROKKR_LAN_PTR);
    noRdQuery.writeUInt16BE(0x0000, 2);
    noRdQuery.writeUInt16BE(1, 4);
    const responseNoRd = buildPtrResponse(noRdQuery, ['server-1.lan'], 60);
    expect(responseNoRd.readUInt16BE(2) & 0x0100).toBeFalsy();
  });

  it('rr type is PTR (12)', () => {
    const response = buildPtrResponse(QUERY_PTR_1_168_192, ['host.lan'], 60);
    const questionEnd = QUERY_PTR_1_168_192.length;
    expect(response.readUInt16BE(questionEnd + 2)).toBe(12);
  });

  it('rdata contains wire-encoded hostname', () => {
    const response = buildPtrResponse(QUERY_PTR_1_168_192, ['host.lan'], 60);
    const questionEnd = QUERY_PTR_1_168_192.length;
    const rdlength = response.readUInt16BE(questionEnd + 10);
    const rdata = response.subarray(questionEnd + 12, questionEnd + 12 + rdlength);
    const expected = encodeDnsName('host.lan');
    expect(rdata.equals(expected)).toBe(true);
  });

  it('rdlength matches the wire-encoded name length', () => {
    const response = buildPtrResponse(QUERY_PTR_1_168_192, ['some.very.deep.hostname.example.com'], 60);
    const questionEnd = QUERY_PTR_1_168_192.length;
    const rdlength = response.readUInt16BE(questionEnd + 10);
    const expected = encodeDnsName('some.very.deep.hostname.example.com');
    expect(rdlength).toBe(expected.length);
  });

  it('produces one answer for single hostname', () => {
    const response = buildPtrResponse(QUERY_PTR_1_168_192, ['host.lan'], 60);
    expect(response.readUInt16BE(6)).toBe(1);
  });
});

describe('packIpv6', () => {
  it('packs an ipv4-mapped address into the correct low bytes', () => {
    const buf = packIpv6('::ffff:192.168.0.1');
    expect(buf.subarray(0, 10)).toEqual(Buffer.alloc(10));
    expect(buf.subarray(10, 16)).toEqual(Buffer.from([0xff, 0xff, 0xc0, 0xa8, 0x00, 0x01]));
  });

  it('rejects a malformed dotted tail instead of truncating', () => {
    expect(() => packIpv6('::ffff:192.168.0')).toThrow();
    expect(() => packIpv6('::ffff:192.168.0.999')).toThrow();
  });

  it('packs a full-form IPv6 address into 16 bytes', () => {
    const buf = packIpv6('2001:0db8:0000:0000:0000:0000:0000:0001');
    expect(buf.length).toBe(16);
    expect(buf.readUInt16BE(0)).toBe(0x2001);
    expect(buf.readUInt16BE(2)).toBe(0x0db8);
    expect(buf.readUInt16BE(14)).toBe(0x0001);
  });

  it('packs an abbreviated (::) IPv6 address', () => {
    const buf = packIpv6('::1');
    expect(buf.length).toBe(16);
    for (let i = 0; i < 7; i++) {
      expect(buf.readUInt16BE(i * 2)).toBe(0);
    }
    expect(buf.readUInt16BE(14)).toBe(1);
  });

  it('packs fe80::1', () => {
    const buf = packIpv6('fe80::1');
    expect(buf.readUInt16BE(0)).toBe(0xfe80);
    for (let i = 2; i < 14; i++) expect(buf[i]).toBe(0);
    expect(buf.readUInt16BE(14)).toBe(1);
  });

  it('packs 2001:db8::1', () => {
    const buf = packIpv6('2001:db8::1');
    expect(buf.readUInt16BE(0)).toBe(0x2001);
    expect(buf.readUInt16BE(2)).toBe(0x0db8);
    expect(buf.readUInt16BE(14)).toBe(1);
  });

  it('handles :: at start with trailing groups', () => {
    const buf = packIpv6('::ffff:c0a8:0105');
    expect(buf.readUInt16BE(10)).toBe(0xffff);
    expect(buf.readUInt16BE(12)).toBe(0xc0a8);
    expect(buf.readUInt16BE(14)).toBe(0x0105);
  });

  it('handles all-zeros', () => {
    const buf = packIpv6('::');
    expect(buf.length).toBe(16);
    for (let i = 0; i < 16; i++) expect(buf[i]).toBe(0);
  });

  it('throws on invalid input', () => {
    expect(() => packIpv6('not-an-ip')).toThrow(DnsParseError);
  });

  it('rejects too many groups after expansion', () => {
    expect(() => packIpv6('1:2:3:4:5:6:7:8:9')).toThrow(DnsParseError);
  });
});

describe('encodeDnsName', () => {
  it('encodes a simple name', () => {
    const buf = encodeDnsName('server-1.lan');
    expect(buf[0]).toBe(8);
    expect(buf.toString('ascii', 1, 9)).toBe('server-1');
    expect(buf[9]).toBe(3);
    expect(buf.toString('ascii', 10, 13)).toBe('lan');
    expect(buf[13]).toBe(0);
  });

  it('strips a trailing dot', () => {
    const withDot = encodeDnsName('server-1.lan.');
    const withoutDot = encodeDnsName('server-1.lan');
    expect(withDot.equals(withoutDot)).toBe(true);
  });

  it('encodes a single label', () => {
    const buf = encodeDnsName('localhost');
    expect(buf[0]).toBe(9);
    expect(buf.toString('ascii', 1, 10)).toBe('localhost');
    expect(buf[10]).toBe(0);
  });

  it('encodes a multi-label name', () => {
    const buf = encodeDnsName('a.b.c.d');
    expect(buf[0]).toBe(1);
    expect(buf[2]).toBe(1);
    expect(buf[4]).toBe(1);
    expect(buf[6]).toBe(1);
    expect(buf[8]).toBe(0);
  });

  it('encodes the root as a single zero byte', () => {
    expect(encodeDnsName('')).toEqual(Buffer.from([0]));
  });

  it('rejects an empty label', () => {
    expect(() => encodeDnsName('brokkr..lan')).toThrow(DnsParseError);
  });

  it('rejects a label longer than 63 bytes', () => {
    const longLabel = 'a'.repeat(64);
    expect(() => encodeDnsName(`${longLabel}.lan`)).toThrow(DnsParseError);
  });

  it('accepts a label at exactly 63 bytes', () => {
    const label = 'a'.repeat(63);
    const buf = encodeDnsName(`${label}.lan`);
    expect(buf[0]).toBe(63);
  });
});
