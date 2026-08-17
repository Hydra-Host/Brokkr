import { describe, expect, it } from 'vitest';

import { DnsCache, minResponseTtlSeconds, negativeTtlSeconds } from '../cache.js';

const QTYPE_A = 1;
const QTYPE_AAAA = 28;
const QTYPE_SOA = 6;
const QCLASS_IN = 1;

function encodeName(name: string): Buffer {
  const labels: Buffer[] = [];
  for (const part of name.split('.')) {
    labels.push(Buffer.from([part.length]), Buffer.from(part, 'ascii'));
  }
  labels.push(Buffer.from([0]));
  return Buffer.concat(labels);
}

function questionSection(qname: string, qtype: number): Buffer {
  const tail = Buffer.alloc(4);
  tail.writeUInt16BE(qtype, 0);
  tail.writeUInt16BE(QCLASS_IN, 2);
  return Buffer.concat([encodeName(qname), tail]);
}

interface ResponseFixture {
  txnId?: number;
  flags?: number;
  qname: string;
  qtype: number;
  answers?: Buffer[];
  authority?: Buffer[];
  additional?: Buffer[];
}

const FLAG_QR_RESPONSE = 0x8000;
const FLAG_RD = 0x0100;
const FLAG_RA = 0x0080;
const FLAG_TC = 0x0200;

function buildResponse(fixture: ResponseFixture): Buffer {
  const answers = fixture.answers ?? [];
  const authority = fixture.authority ?? [];
  const additional = fixture.additional ?? [];
  const header = Buffer.alloc(12);
  header.writeUInt16BE(fixture.txnId ?? 0x1234, 0);
  header.writeUInt16BE(fixture.flags ?? FLAG_QR_RESPONSE | FLAG_RD | FLAG_RA, 2);
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(answers.length, 6);
  header.writeUInt16BE(authority.length, 8);
  header.writeUInt16BE(additional.length, 10);
  return Buffer.concat([
    header,
    questionSection(fixture.qname, fixture.qtype),
    ...answers,
    ...authority,
    ...additional,
  ]);
}

function aRecord(name: string, ip: string, ttl: number): Buffer {
  const rdata = Buffer.from(ip.split('.').map((o) => Number.parseInt(o, 10)));
  const head = Buffer.alloc(10);
  head.writeUInt16BE(QTYPE_A, 0);
  head.writeUInt16BE(QCLASS_IN, 2);
  head.writeUInt32BE(ttl, 4);
  head.writeUInt16BE(rdata.length, 8);
  return Buffer.concat([encodeName(name), head, rdata]);
}

function soaRecord(name: string, ttl: number, minimum: number): Buffer {
  const mname = encodeName('ns.' + name);
  const rname = encodeName('hostmaster.' + name);
  const fixed = Buffer.alloc(20);
  fixed.writeUInt32BE(2024010101, 0);
  fixed.writeUInt32BE(7200, 4);
  fixed.writeUInt32BE(3600, 8);
  fixed.writeUInt32BE(1209600, 12);
  fixed.writeUInt32BE(minimum, 16);
  const rdata = Buffer.concat([mname, rname, fixed]);
  const head = Buffer.alloc(10);
  head.writeUInt16BE(QTYPE_SOA, 0);
  head.writeUInt16BE(QCLASS_IN, 2);
  head.writeUInt32BE(ttl, 4);
  head.writeUInt16BE(rdata.length, 8);
  return Buffer.concat([encodeName(name), head, rdata]);
}

const QTYPE_OPT = 41;
function optRecord(udpPayloadSize = 4096): Buffer {
  const buf = Buffer.alloc(11);
  buf.writeUInt8(0, 0);
  buf.writeUInt16BE(QTYPE_OPT, 1);
  buf.writeUInt16BE(udpPayloadSize, 3);
  buf.writeUInt32BE(0, 5);
  buf.writeUInt16BE(0, 9);
  return buf;
}

function rcodeOf(packet: Buffer): number {
  return packet.readUInt16BE(2) & 0x0f;
}

function txnIdOf(packet: Buffer): number {
  return packet.readUInt16BE(0);
}

function clock(start = 1_000_000): { nowMs: () => number; advance: (ms: number) => void } {
  let t = start;
  return { nowMs: () => t, advance: (ms) => void (t += ms) };
}

describe('DnsCache get/set', () => {
  it('1: misses before store, hits after', () => {
    const cache = new DnsCache({ capacity: 10 });
    expect(cache.get('example.com', QTYPE_A, 0x1111)).toBeNull();
    cache.set('example.com', QTYPE_A, buildResponse({ qname: 'example.com', qtype: QTYPE_A }), 60);
    expect(cache.get('example.com', QTYPE_A, 0x1111)).not.toBeNull();
  });

  it('2: serves a copy with only the txn-id rewritten; stored bytes stay pristine', () => {
    const cache = new DnsCache({ capacity: 10, nowMs: clock().nowMs });
    const stored = buildResponse({
      txnId: 0xaaaa,
      qname: 'example.com',
      qtype: QTYPE_A,
      answers: [aRecord('example.com', '93.184.216.34', 60)],
    });
    cache.set('example.com', QTYPE_A, stored, 60);

    const served = cache.get('example.com', QTYPE_A, 0xbbbb);
    expect(served).not.toBeNull();
    expect(txnIdOf(served!)).toBe(0xbbbb);
    expect(served!.subarray(2).equals(stored.subarray(2))).toBe(true);
    expect(txnIdOf(stored)).toBe(0xaaaa);
    served!.writeUInt16BE(0xffff, 0);
    expect(cache.get('example.com', QTYPE_A, 0xcccc)!.subarray(2).equals(stored.subarray(2))).toBe(true);
  });

  it('3: key uses the lowercased qname (parseQuery lowercases before lookup)', () => {
    const cache = new DnsCache({ capacity: 10 });
    cache.set('example.com', QTYPE_A, buildResponse({ qname: 'example.com', qtype: QTYPE_A }), 60);
    expect(cache.get('example.com', QTYPE_A, 0x1)).not.toBeNull();
  });

  it('4: qtype is part of the key (A stored, AAAA misses)', () => {
    const cache = new DnsCache({ capacity: 10 });
    cache.set('example.com', QTYPE_A, buildResponse({ qname: 'example.com', qtype: QTYPE_A }), 60);
    expect(cache.get('example.com', QTYPE_AAAA, 0x1)).toBeNull();
    expect(cache.get('example.com', QTYPE_A, 0x1)).not.toBeNull();
  });

  it('5: expires via the injected clock (hit at t=59, miss + evict at t=60)', () => {
    const c = clock();
    const cache = new DnsCache({ capacity: 10, nowMs: c.nowMs });
    cache.set('example.com', QTYPE_A, buildResponse({ qname: 'example.com', qtype: QTYPE_A }), 60);
    c.advance(59_000);
    expect(cache.get('example.com', QTYPE_A, 0x1)).not.toBeNull();
    c.advance(1_000);
    expect(cache.get('example.com', QTYPE_A, 0x1)).toBeNull();
    expect(cache.size).toBe(0);
  });
});

describe('DnsCache maybeStore', () => {
  it('6: caches NXDOMAIN negatively from the authority SOA (min of RR TTL and MINIMUM)', () => {
    const cache = new DnsCache({ capacity: 10 });
    const resp = buildResponse({
      flags: FLAG_QR_RESPONSE | FLAG_RD | FLAG_RA | 3,
      qname: 'nope.example.com',
      qtype: QTYPE_A,
      authority: [soaRecord('example.com', 300, 120)],
    });
    expect(rcodeOf(resp)).toBe(3);
    cache.maybeStore('nope.example.com', QTYPE_A, resp);
    expect(cache.size).toBe(1);
    expect(cache.get('nope.example.com', QTYPE_A, 0x1)).not.toBeNull();
  });

  it('6b: negative TTL is min(SOA RR TTL, MINIMUM) — the smaller RR TTL wins', () => {
    const c = clock();
    const cache = new DnsCache({ capacity: 10, nowMs: c.nowMs });
    const resp = buildResponse({
      flags: FLAG_QR_RESPONSE | FLAG_RD | FLAG_RA | 3,
      qname: 'nope.example.com',
      qtype: QTYPE_A,
      authority: [soaRecord('example.com', 50, 300)],
    });
    cache.maybeStore('nope.example.com', QTYPE_A, resp);
    c.advance(49_000);
    expect(cache.get('nope.example.com', QTYPE_A, 0x1)).not.toBeNull();
    c.advance(1_000);
    expect(cache.get('nope.example.com', QTYPE_A, 0x1)).toBeNull();
  });

  it('7: caches NODATA (NOERROR, ancount=0) negatively from the authority SOA', () => {
    const cache = new DnsCache({ capacity: 10 });
    const resp = buildResponse({
      qname: 'host.example.com',
      qtype: QTYPE_AAAA,
      answers: [],
      authority: [soaRecord('example.com', 200, 90)],
    });
    expect(rcodeOf(resp)).toBe(0);
    cache.maybeStore('host.example.com', QTYPE_AAAA, resp);
    expect(cache.size).toBe(1);
  });

  it('8: does not cache a negative response with no SOA', () => {
    const cache = new DnsCache({ capacity: 10 });
    const resp = buildResponse({
      flags: FLAG_QR_RESPONSE | FLAG_RD | FLAG_RA | 3,
      qname: 'nope.example.com',
      qtype: QTYPE_A,
    });
    cache.maybeStore('nope.example.com', QTYPE_A, resp);
    expect(cache.size).toBe(0);
  });

  it('9: caps the negative TTL at 600s', () => {
    const c = clock();
    const cache = new DnsCache({ capacity: 10, nowMs: c.nowMs });
    const resp = buildResponse({
      flags: FLAG_QR_RESPONSE | FLAG_RD | FLAG_RA | 3,
      qname: 'nope.example.com',
      qtype: QTYPE_A,
      authority: [soaRecord('example.com', 100_000, 100_000)],
    });
    cache.maybeStore('nope.example.com', QTYPE_A, resp);
    c.advance(600_000);
    expect(cache.get('nope.example.com', QTYPE_A, 0x1)).toBeNull();
  });

  it('10: caps the positive TTL at 86400s', () => {
    const c = clock();
    const cache = new DnsCache({ capacity: 10, nowMs: c.nowMs });
    const resp = buildResponse({
      qname: 'example.com',
      qtype: QTYPE_A,
      answers: [aRecord('example.com', '1.2.3.4', 1_000_000)],
    });
    cache.maybeStore('example.com', QTYPE_A, resp);
    c.advance(86_400_000);
    expect(cache.get('example.com', QTYPE_A, 0x1)).toBeNull();
  });

  it('11: does not cache an all-zero-TTL answer', () => {
    const cache = new DnsCache({ capacity: 10 });
    const resp = buildResponse({
      qname: 'example.com',
      qtype: QTYPE_A,
      answers: [aRecord('example.com', '1.2.3.4', 0)],
    });
    cache.maybeStore('example.com', QTYPE_A, resp);
    expect(cache.size).toBe(0);
  });

  it('12: does not cache SERVFAIL', () => {
    const cache = new DnsCache({ capacity: 10 });
    const resp = buildResponse({
      flags: FLAG_QR_RESPONSE | FLAG_RD | FLAG_RA | 2,
      qname: 'example.com',
      qtype: QTYPE_A,
      answers: [aRecord('example.com', '1.2.3.4', 60)],
    });
    cache.maybeStore('example.com', QTYPE_A, resp);
    expect(cache.size).toBe(0);
  });

  it('13: does not cache REFUSED', () => {
    const cache = new DnsCache({ capacity: 10 });
    const resp = buildResponse({
      flags: FLAG_QR_RESPONSE | FLAG_RD | FLAG_RA | 5,
      qname: 'example.com',
      qtype: QTYPE_A,
      answers: [aRecord('example.com', '1.2.3.4', 60)],
    });
    cache.maybeStore('example.com', QTYPE_A, resp);
    expect(cache.size).toBe(0);
  });

  it('14: does not cache a truncated (TC bit set) response', () => {
    const cache = new DnsCache({ capacity: 10 });
    const resp = buildResponse({
      flags: FLAG_QR_RESPONSE | FLAG_RD | FLAG_RA | FLAG_TC,
      qname: 'example.com',
      qtype: QTYPE_A,
      answers: [aRecord('example.com', '1.2.3.4', 60)],
    });
    cache.maybeStore('example.com', QTYPE_A, resp);
    expect(cache.size).toBe(0);
  });

  it('15: does not cache a malformed response (QR=0 / qdcount != 1)', () => {
    const cache = new DnsCache({ capacity: 10 });
    const notAResponse = buildResponse({ flags: FLAG_RD, qname: 'example.com', qtype: QTYPE_A });
    cache.maybeStore('example.com', QTYPE_A, notAResponse);
    expect(cache.size).toBe(0);

    const badQdcount = buildResponse({
      qname: 'example.com',
      qtype: QTYPE_A,
      answers: [aRecord('example.com', '1.2.3.4', 60)],
    });
    badQdcount.writeUInt16BE(2, 4);
    cache.maybeStore('example.com', QTYPE_A, badQdcount);
    expect(cache.size).toBe(0);
  });
});

describe('DnsCache maybeStore strips the OPT pseudo-RR', () => {
  it('caches an EDNS reply with ARCOUNT=0 and no OPT bytes in the additional section', () => {
    const cache = new DnsCache({ capacity: 10 });
    const opt = optRecord(4096);
    const resp = buildResponse({
      qname: 'example.com',
      qtype: QTYPE_A,
      answers: [aRecord('example.com', '93.184.216.34', 60)],
      additional: [opt],
    });
    expect(resp.readUInt16BE(10)).toBe(1);

    cache.maybeStore('example.com', QTYPE_A, resp);
    expect(cache.size).toBe(1);

    const served = cache.get('example.com', QTYPE_A, 0x1)!;
    expect(served).not.toBeNull();
    expect(served.readUInt16BE(10)).toBe(0);
    expect(served.length).toBe(resp.length - opt.length);
    expect(served.includes(opt)).toBe(false);
    expect(served.readUInt16BE(6)).toBe(1);
  });

  it('fails closed (does not cache) when the additional-section walk overruns', () => {
    const cache = new DnsCache({ capacity: 10 });
    const resp = buildResponse({
      qname: 'example.com',
      qtype: QTYPE_A,
      answers: [aRecord('example.com', '93.184.216.34', 60)],
      additional: [optRecord(4096)],
    });
    resp.writeUInt16BE(0xffff, 50);
    cache.maybeStore('example.com', QTYPE_A, resp);
    expect(cache.size).toBe(0);
  });
});

describe('DnsCache eviction and TTL', () => {
  it('16: evicts the LRU at capacity, and promote-on-hit protects a recently used key', () => {
    const cache = new DnsCache({ capacity: 2 });
    cache.set('a.com', QTYPE_A, buildResponse({ qname: 'a.com', qtype: QTYPE_A }), 60);
    cache.set('b.com', QTYPE_A, buildResponse({ qname: 'b.com', qtype: QTYPE_A }), 60);
    expect(cache.get('a.com', QTYPE_A, 0x1)).not.toBeNull();
    cache.set('c.com', QTYPE_A, buildResponse({ qname: 'c.com', qtype: QTYPE_A }), 60);
    expect(cache.size).toBe(2);
    expect(cache.get('b.com', QTYPE_A, 0x1)).toBeNull();
    expect(cache.get('a.com', QTYPE_A, 0x1)).not.toBeNull();
    expect(cache.get('c.com', QTYPE_A, 0x1)).not.toBeNull();
  });

  it('17: message TTL is the minimum across a multi-record answer', () => {
    const resp = buildResponse({
      qname: 'example.com',
      qtype: QTYPE_A,
      answers: [
        aRecord('example.com', '1.1.1.1', 300),
        aRecord('example.com', '2.2.2.2', 45),
        aRecord('example.com', '3.3.3.3', 120),
      ],
    });
    expect(minResponseTtlSeconds(resp)).toBe(45);
  });

  it('18: capacity 0 disables the cache (set and maybeStore are no-ops)', () => {
    const cache = new DnsCache({ capacity: 0 });
    cache.set('example.com', QTYPE_A, buildResponse({ qname: 'example.com', qtype: QTYPE_A }), 60);
    expect(cache.size).toBe(0);
    cache.maybeStore(
      'example.com',
      QTYPE_A,
      buildResponse({ qname: 'example.com', qtype: QTYPE_A, answers: [aRecord('example.com', '1.2.3.4', 60)] }),
    );
    expect(cache.size).toBe(0);
    expect(cache.get('example.com', QTYPE_A, 0x1)).toBeNull();
  });
});

describe('TTL helpers', () => {
  it('minResponseTtlSeconds returns null on a header-only / no-RR packet', () => {
    expect(minResponseTtlSeconds(Buffer.alloc(12))).toBeNull();
    expect(minResponseTtlSeconds(Buffer.alloc(4))).toBeNull();
  });

  it('minResponseTtlSeconds returns null on a truncated RR header', () => {
    const resp = buildResponse({
      qname: 'example.com',
      qtype: QTYPE_A,
      answers: [aRecord('example.com', '1.2.3.4', 60)],
    });
    expect(minResponseTtlSeconds(resp.subarray(0, resp.length - 2))).toBeNull();
  });

  it('negativeTtlSeconds reads MINIMUM from the final SOA RDATA field', () => {
    const resp = buildResponse({
      flags: FLAG_QR_RESPONSE | 3,
      qname: 'nope.example.com',
      qtype: QTYPE_A,
      authority: [soaRecord('example.com', 5000, 77)],
    });
    expect(negativeTtlSeconds(resp)).toBe(77);
  });
});

function firstAnswerTtl(packet: Buffer): number {
  const skip = (offset: number): number => {
    let cursor = offset;
    for (;;) {
      const len = packet[cursor];
      if ((len & 0xc0) === 0xc0) return cursor + 2;
      if (len === 0) return cursor + 1;
      cursor += 1 + len;
    }
  };
  const afterQuestion = skip(12) + 4;
  const afterAnswerName = skip(afterQuestion);
  return packet.readUInt32BE(afterAnswerName + 4);
}

describe('DnsCache TTL clamping', () => {
  it('12: --max-cache-ttl clamps the expiry down (hit at 299, miss at 301); served TTL decremented to remaining', () => {
    const c = clock();
    const cache = new DnsCache({ capacity: 10, nowMs: c.nowMs, maxCacheTtlSeconds: 300 });
    const resp = buildResponse({
      qname: 'example.com',
      qtype: QTYPE_A,
      answers: [aRecord('example.com', '1.2.3.4', 1000)],
    });
    cache.maybeStore('example.com', QTYPE_A, resp);
    c.advance(299_000);
    const served = cache.get('example.com', QTYPE_A, 0x1);
    expect(served).not.toBeNull();
    expect(firstAnswerTtl(served!)).toBe(1);
    c.advance(2_000);
    expect(cache.get('example.com', QTYPE_A, 0x1)).toBeNull();
  });

  it('13: --min-cache-ttl raises the expiry floor (hit at 119, miss at 121)', () => {
    const c = clock();
    const cache = new DnsCache({ capacity: 10, nowMs: c.nowMs, minCacheTtlSeconds: 120 });
    const resp = buildResponse({
      qname: 'example.com',
      qtype: QTYPE_A,
      answers: [aRecord('example.com', '1.2.3.4', 30)],
    });
    cache.maybeStore('example.com', QTYPE_A, resp);
    c.advance(119_000);
    expect(cache.get('example.com', QTYPE_A, 0x1)).not.toBeNull();
    c.advance(2_000);
    expect(cache.get('example.com', QTYPE_A, 0x1)).toBeNull();
  });

  it('14: max ceiling then min floor (200 ttl, max60, min120 → 120 expiry)', () => {
    const c = clock();
    const cache = new DnsCache({ capacity: 10, nowMs: c.nowMs, maxCacheTtlSeconds: 60, minCacheTtlSeconds: 120 });
    const resp = buildResponse({
      qname: 'example.com',
      qtype: QTYPE_A,
      answers: [aRecord('example.com', '1.2.3.4', 200)],
    });
    cache.maybeStore('example.com', QTYPE_A, resp);
    c.advance(119_000);
    expect(cache.get('example.com', QTYPE_A, 0x1)).not.toBeNull();
    c.advance(2_000);
    expect(cache.get('example.com', QTYPE_A, 0x1)).toBeNull();
  });

  it('15: dormant (both unset) uses today’s expiry (RR TTL, capped at 86400)', () => {
    const c = clock();
    const cache = new DnsCache({ capacity: 10, nowMs: c.nowMs });
    const resp = buildResponse({
      qname: 'example.com',
      qtype: QTYPE_A,
      answers: [aRecord('example.com', '1.2.3.4', 200)],
    });
    cache.maybeStore('example.com', QTYPE_A, resp);
    c.advance(199_000);
    expect(cache.get('example.com', QTYPE_A, 0x1)).not.toBeNull();
    c.advance(2_000);
    expect(cache.get('example.com', QTYPE_A, 0x1)).toBeNull();
  });

  it('16: --neg-ttl caches a SOA-less negative (hit at 29, miss at 31); without it → not cached', () => {
    const c = clock();
    const withNeg = new DnsCache({ capacity: 10, nowMs: c.nowMs, negTtlSeconds: 30 });
    const soaless = buildResponse({
      flags: FLAG_QR_RESPONSE | FLAG_RD | FLAG_RA | 3,
      qname: 'nope.example.com',
      qtype: QTYPE_A,
    });
    withNeg.maybeStore('nope.example.com', QTYPE_A, soaless);
    expect(withNeg.size).toBe(1);
    c.advance(29_000);
    expect(withNeg.get('nope.example.com', QTYPE_A, 0x1)).not.toBeNull();
    c.advance(2_000);
    expect(withNeg.get('nope.example.com', QTYPE_A, 0x1)).toBeNull();

    const noNeg = new DnsCache({ capacity: 10 });
    noNeg.maybeStore('nope.example.com', QTYPE_A, soaless);
    expect(noNeg.size).toBe(0);
  });

  it('17: --neg-ttl does NOT override a present SOA (SOA-derived TTL wins)', () => {
    const c = clock();
    const cache = new DnsCache({ capacity: 10, nowMs: c.nowMs, negTtlSeconds: 500 });
    const withSoa = buildResponse({
      flags: FLAG_QR_RESPONSE | FLAG_RD | FLAG_RA | 3,
      qname: 'nope.example.com',
      qtype: QTYPE_A,
      authority: [soaRecord('example.com', 60, 60)],
    });
    cache.maybeStore('nope.example.com', QTYPE_A, withSoa);
    c.advance(59_000);
    expect(cache.get('nope.example.com', QTYPE_A, 0x1)).not.toBeNull();
    c.advance(2_000);
    expect(cache.get('nope.example.com', QTYPE_A, 0x1)).toBeNull();
  });

  it('18: --neg-ttl fallback composes with --max-cache-ttl (1000 fallback clamped to 200)', () => {
    const c = clock();
    const cache = new DnsCache({ capacity: 10, nowMs: c.nowMs, negTtlSeconds: 1000, maxCacheTtlSeconds: 200 });
    const soaless = buildResponse({
      flags: FLAG_QR_RESPONSE | FLAG_RD | FLAG_RA | 3,
      qname: 'nope.example.com',
      qtype: QTYPE_A,
    });
    cache.maybeStore('nope.example.com', QTYPE_A, soaless);
    c.advance(199_000);
    expect(cache.get('nope.example.com', QTYPE_A, 0x1)).not.toBeNull();
    c.advance(2_000);
    expect(cache.get('nope.example.com', QTYPE_A, 0x1)).toBeNull();
  });

  it('19: stored bytes are kept verbatim — pre-clamped RR TTL survives store+serve', () => {
    const cache = new DnsCache({ capacity: 10 });
    const preClamped = buildResponse({
      qname: 'example.com',
      qtype: QTYPE_A,
      answers: [aRecord('example.com', '1.2.3.4', 300)],
    });
    cache.maybeStore('example.com', QTYPE_A, preClamped);
    const served = cache.get('example.com', QTYPE_A, 0x1);
    expect(served).not.toBeNull();
    expect(firstAnswerTtl(served!)).toBe(300);
  });

  it('20: served RR TTL counts down as the clock advances (RFC 1035 §6.1.3)', () => {
    const c = clock();
    const cache = new DnsCache({ capacity: 10, nowMs: c.nowMs });
    cache.maybeStore(
      'example.com',
      QTYPE_A,
      buildResponse({ qname: 'example.com', qtype: QTYPE_A, answers: [aRecord('example.com', '1.2.3.4', 300)] }),
    );
    expect(firstAnswerTtl(cache.get('example.com', QTYPE_A, 0x1)!)).toBe(300);
    c.advance(100_000);
    expect(firstAnswerTtl(cache.get('example.com', QTYPE_A, 0x1)!)).toBe(200);
    c.advance(150_000);
    expect(firstAnswerTtl(cache.get('example.com', QTYPE_A, 0x1)!)).toBe(50);
  });

  it('21: decrement is bounded at >=1s while still cached, never 0', () => {
    const c = clock();
    const cache = new DnsCache({ capacity: 10, nowMs: c.nowMs });
    cache.maybeStore(
      'example.com',
      QTYPE_A,
      buildResponse({ qname: 'example.com', qtype: QTYPE_A, answers: [aRecord('example.com', '1.2.3.4', 300)] }),
    );
    c.advance(299_500);
    expect(firstAnswerTtl(cache.get('example.com', QTYPE_A, 0x1)!)).toBe(1);
  });
});
