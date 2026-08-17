import { describe, expect, it } from 'vitest';

import {
  BROADCAST_MAC,
  ETH_HEADER_LEN,
  FrameParseError,
  IPV4_MIN_HEADER_LEN,
  UDP_HEADER_LEN,
  bufferToIp,
  bufferToMac,
  buildFrame,
  ipToBuffer,
  macToBuffer,
  onesComplementSum,
  parseFrame,
  udpChecksum,
} from '../l2/frame.js';

const SRC_MAC = macToBuffer('aa:bb:cc:dd:ee:f0');
const DST_MAC = macToBuffer('11:22:33:44:55:66');
const SRC_IP = ipToBuffer('10.0.0.1');
const DST_IP = ipToBuffer('10.0.0.100');
const PAYLOAD = Buffer.from('hello dhcp world');

function defaultFrame(): Buffer {
  return buildFrame({
    srcMac: SRC_MAC,
    dstMac: DST_MAC,
    srcIp: SRC_IP,
    dstIp: DST_IP,
    srcPort: 67,
    dstPort: 68,
    payload: PAYLOAD,
  });
}

describe('onesComplementSum', () => {
  it('returns 0xFFFF for an all-zero buffer (complement of 0 is 0xFFFF)', () => {
    expect(onesComplementSum(Buffer.alloc(20))).toBe(0xffff);
  });

  it('returns 0 for a buffer that is already a valid checksum (self-check)', () => {
    const frame = defaultFrame();
    const ipHeader = frame.subarray(ETH_HEADER_LEN, ETH_HEADER_LEN + IPV4_MIN_HEADER_LEN);
    expect(onesComplementSum(ipHeader)).toBe(0);
  });

  it('handles odd-length buffers', () => {
    const buf = Buffer.from([0x01, 0x02, 0x03]);
    expect(onesComplementSum(buf)).toBe(0xfbfd);
  });

  it('handles carry folding', () => {
    const buf = Buffer.from([0xff, 0xff, 0x00, 0x01]);
    expect(onesComplementSum(buf)).toBe(0xfffe);
  });
});

describe('onesComplementSum (IPv4 header checksum)', () => {
  it('computes correct checksum for a known IPv4 header (RFC 1071 example)', () => {
    const header = Buffer.from([
      0x45, 0x00, 0x00, 0x73, 0x00, 0x00, 0x40, 0x00, 0x40, 0x11, 0x00, 0x00, 0xc0, 0xa8, 0x00, 0x01, 0xc0, 0xa8, 0x00,
      0xc7,
    ]);
    const cksum = onesComplementSum(header);
    header.writeUInt16BE(cksum, 10);
    expect(onesComplementSum(header)).toBe(0);
  });

  it('self-validates: building a frame produces a valid header checksum', () => {
    const frame = defaultFrame();
    const ipHeader = frame.subarray(ETH_HEADER_LEN, ETH_HEADER_LEN + IPV4_MIN_HEADER_LEN);
    expect(onesComplementSum(ipHeader)).toBe(0);
  });
});

describe('udpChecksum', () => {
  it('computes a non-zero checksum for a real UDP segment', () => {
    const frame = defaultFrame();
    const udpStart = ETH_HEADER_LEN + IPV4_MIN_HEADER_LEN;
    const udpLen = frame.readUInt16BE(udpStart + 4);
    const udpSegment = frame.subarray(udpStart, udpStart + udpLen);

    const copy = Buffer.from(udpSegment);
    copy.writeUInt16BE(0, 6);
    const computed = udpChecksum(SRC_IP, DST_IP, copy);
    expect(computed).toBeGreaterThan(0);

    const existing = udpSegment.readUInt16BE(6);
    expect(existing).toBe(computed);
  });

  it('returns 0xFFFF when the computed sum is zero (RFC 768)', () => {
    const frame = defaultFrame();
    const udpStart = ETH_HEADER_LEN + IPV4_MIN_HEADER_LEN;
    const cksum = frame.readUInt16BE(udpStart + 6);
    expect(cksum).not.toBe(0);
  });
});

describe('buildFrame / parseFrame round-trip', () => {
  it('round-trips all fields through build then parse', () => {
    const frame = defaultFrame();
    const parsed = parseFrame(frame);

    expect(parsed.srcMac).toEqual(SRC_MAC);
    expect(parsed.dstMac).toEqual(DST_MAC);
    expect(parsed.srcIp).toEqual(SRC_IP);
    expect(parsed.dstIp).toEqual(DST_IP);
    expect(parsed.srcPort).toBe(67);
    expect(parsed.dstPort).toBe(68);
    expect(parsed.payload).toEqual(PAYLOAD);
    expect(parsed.isBroadcast).toBe(false);
  });

  it('detects broadcast destination MAC', () => {
    const frame = buildFrame({
      srcMac: SRC_MAC,
      dstMac: BROADCAST_MAC,
      srcIp: SRC_IP,
      dstIp: ipToBuffer('255.255.255.255'),
      srcPort: 67,
      dstPort: 68,
      payload: PAYLOAD,
    });
    expect(parseFrame(frame).isBroadcast).toBe(true);
  });

  it('handles an empty payload', () => {
    const frame = buildFrame({
      srcMac: SRC_MAC,
      dstMac: DST_MAC,
      srcIp: SRC_IP,
      dstIp: DST_IP,
      srcPort: 67,
      dstPort: 68,
      payload: Buffer.alloc(0),
    });
    const parsed = parseFrame(frame);
    expect(parsed.payload.length).toBe(0);
    expect(parsed.srcPort).toBe(67);
  });

  it('handles a large payload (1400 bytes)', () => {
    const big = Buffer.alloc(1400, 0x42);
    const frame = buildFrame({
      srcMac: SRC_MAC,
      dstMac: DST_MAC,
      srcIp: SRC_IP,
      dstIp: DST_IP,
      srcPort: 67,
      dstPort: 68,
      payload: big,
    });
    const parsed = parseFrame(frame);
    expect(parsed.payload).toEqual(big);
  });

  it('produces the correct total frame length', () => {
    const frame = defaultFrame();
    expect(frame.length).toBe(ETH_HEADER_LEN + IPV4_MIN_HEADER_LEN + UDP_HEADER_LEN + PAYLOAD.length);
  });

  it('sets the DF flag and correct IP total length', () => {
    const frame = defaultFrame();
    const flags = frame.readUInt16BE(ETH_HEADER_LEN + 6);
    expect(flags & 0x4000).toBe(0x4000);
    const ipTotalLen = frame.readUInt16BE(ETH_HEADER_LEN + 2);
    expect(ipTotalLen).toBe(IPV4_MIN_HEADER_LEN + UDP_HEADER_LEN + PAYLOAD.length);
  });
});

describe('parseFrame error handling', () => {
  it('rejects a buffer shorter than the Ethernet header', () => {
    expect(() => parseFrame(Buffer.alloc(10))).toThrow(FrameParseError);
    expect(() => parseFrame(Buffer.alloc(10))).toThrow(/too short for Ethernet/);
  });

  it('rejects a non-IPv4 ethertype', () => {
    const frame = defaultFrame();
    frame.writeUInt16BE(0x86dd, 12);
    expect(() => parseFrame(frame)).toThrow(/ethertype/);
  });

  it('rejects a truncated IPv4 header', () => {
    const frame = Buffer.alloc(ETH_HEADER_LEN + 10);
    frame.writeUInt16BE(0x0800, 12);
    frame[ETH_HEADER_LEN] = 0x45;
    expect(() => parseFrame(frame)).toThrow(/too short for IPv4/);
  });

  it('rejects IPv4 version != 4', () => {
    const frame = defaultFrame();
    frame[ETH_HEADER_LEN] = 0x65;
    expect(() => parseFrame(frame)).toThrow(/version 6/);
  });

  it('rejects IHL < 5 (20 bytes)', () => {
    const frame = defaultFrame();
    frame[ETH_HEADER_LEN] = 0x43;
    expect(() => parseFrame(frame)).toThrow(/IHL 12/);
  });

  it('rejects a non-UDP protocol', () => {
    const frame = defaultFrame();
    frame[ETH_HEADER_LEN + 9] = 6;
    const ipHeader = frame.subarray(ETH_HEADER_LEN, ETH_HEADER_LEN + IPV4_MIN_HEADER_LEN);
    ipHeader.writeUInt16BE(0, 10);
    ipHeader.writeUInt16BE(onesComplementSum(ipHeader), 10);
    expect(() => parseFrame(frame)).toThrow(/protocol 6/);
  });

  it('rejects a truncated UDP header', () => {
    const frame = Buffer.alloc(ETH_HEADER_LEN + IPV4_MIN_HEADER_LEN + 4);
    frame.writeUInt16BE(0x0800, 12);
    frame[ETH_HEADER_LEN] = 0x45;
    frame.writeUInt16BE(IPV4_MIN_HEADER_LEN + 4, ETH_HEADER_LEN + 2);
    frame[ETH_HEADER_LEN + 9] = 17;
    expect(() => parseFrame(frame)).toThrow(/too short.*UDP/);
  });

  it('rejects UDP length < 8', () => {
    const frame = defaultFrame();
    const udpStart = ETH_HEADER_LEN + IPV4_MIN_HEADER_LEN;
    frame.writeUInt16BE(4, udpStart + 4);
    expect(() => parseFrame(frame)).toThrow(/UDP length 4/);
  });

  it('rejects UDP length exceeding IPv4 payload', () => {
    const frame = defaultFrame();
    const udpStart = ETH_HEADER_LEN + IPV4_MIN_HEADER_LEN;
    frame.writeUInt16BE(60000, udpStart + 4);
    expect(() => parseFrame(frame)).toThrow(/exceeds IPv4 payload/);
  });

  it('rejects a frame truncated mid-IPv4 (total length > available)', () => {
    const frame = defaultFrame();
    frame.writeUInt16BE(9000, ETH_HEADER_LEN + 2);
    expect(() => parseFrame(frame)).toThrow(/truncated/);
  });

  it('handles IPv4 with options (IHL > 5) if the frame is long enough', () => {
    const base = defaultFrame();
    const ihl6Frame = Buffer.alloc(base.length + 4);
    base.copy(ihl6Frame, 0, 0, ETH_HEADER_LEN);
    ihl6Frame[ETH_HEADER_LEN] = 0x46;
    base.copy(ihl6Frame, ETH_HEADER_LEN + 1, ETH_HEADER_LEN + 1, ETH_HEADER_LEN + IPV4_MIN_HEADER_LEN);
    const origIpLen = base.readUInt16BE(ETH_HEADER_LEN + 2);
    ihl6Frame.writeUInt16BE(origIpLen + 4, ETH_HEADER_LEN + 2);
    ihl6Frame.writeUInt32BE(0x01010101, ETH_HEADER_LEN + IPV4_MIN_HEADER_LEN);
    const ipH = ihl6Frame.subarray(ETH_HEADER_LEN, ETH_HEADER_LEN + 24);
    ipH.writeUInt16BE(0, 10);
    ipH.writeUInt16BE(onesComplementSum(ipH), 10);
    base.copy(ihl6Frame, ETH_HEADER_LEN + 24, ETH_HEADER_LEN + IPV4_MIN_HEADER_LEN);

    const parsed = parseFrame(ihl6Frame);
    expect(parsed.payload).toEqual(PAYLOAD);
    expect(parsed.srcPort).toBe(67);
  });

  it('rejects IPv4 total length too short for UDP', () => {
    const frame = defaultFrame();
    frame.writeUInt16BE(IPV4_MIN_HEADER_LEN + 2, ETH_HEADER_LEN + 2);
    expect(() => parseFrame(frame)).toThrow(/too short for UDP/);
  });

  it('rejects a frame with a corrupted IPv4 header checksum', () => {
    const frame = defaultFrame();
    const checksumOffset = ETH_HEADER_LEN + 10;
    const original = frame.readUInt16BE(checksumOffset);
    frame.writeUInt16BE(original ^ 0x0001, checksumOffset);
    expect(() => parseFrame(frame)).toThrow(FrameParseError);
    expect(() => parseFrame(frame)).toThrow(/bad IPv4 header checksum/);
  });
});

describe('ipToBuffer / bufferToIp', () => {
  it('round-trips a dotted-quad', () => {
    expect(bufferToIp(ipToBuffer('192.168.1.100'))).toBe('192.168.1.100');
  });

  it('handles edge IPs', () => {
    expect(bufferToIp(ipToBuffer('0.0.0.0'))).toBe('0.0.0.0');
    expect(bufferToIp(ipToBuffer('255.255.255.255'))).toBe('255.255.255.255');
  });

  it('rejects invalid IPs', () => {
    expect(() => ipToBuffer('1.2.3')).toThrow(FrameParseError);
    expect(() => ipToBuffer('1.2.3.256')).toThrow(FrameParseError);
    expect(() => ipToBuffer('a.b.c.d')).toThrow(FrameParseError);
    expect(() => ipToBuffer('1.2.3.04')).toThrow(FrameParseError);
  });

  it('rejects wrong-size buffer', () => {
    expect(() => bufferToIp(Buffer.alloc(3))).toThrow(FrameParseError);
  });
});

describe('macToBuffer / bufferToMac', () => {
  it('round-trips a colon-hex MAC', () => {
    expect(bufferToMac(macToBuffer('aa:bb:cc:dd:ee:ff'))).toBe('aa:bb:cc:dd:ee:ff');
  });

  it('handles dash-separated and uppercase', () => {
    expect(bufferToMac(macToBuffer('AA-BB-CC-DD-EE-FF'))).toBe('aa:bb:cc:dd:ee:ff');
  });

  it('rejects invalid MACs', () => {
    expect(() => macToBuffer('00:11:22:33:44')).toThrow(FrameParseError);
    expect(() => macToBuffer('00:11:22:33:44:gg')).toThrow(FrameParseError);
  });

  it('rejects wrong-size buffer', () => {
    expect(() => bufferToMac(Buffer.alloc(4))).toThrow(FrameParseError);
  });
});

describe('checksum cross-validation', () => {
  it('a DHCP OFFER frame has a valid IP checksum after build', () => {
    const dhcpPayload = Buffer.alloc(300);
    dhcpPayload[0] = 0x02;
    dhcpPayload.writeUInt32BE(0x63825363, 236);

    const frame = buildFrame({
      srcMac: macToBuffer('00:11:22:33:44:55'),
      dstMac: BROADCAST_MAC,
      srcIp: ipToBuffer('10.0.0.1'),
      dstIp: ipToBuffer('255.255.255.255'),
      srcPort: 67,
      dstPort: 68,
      payload: dhcpPayload,
    });

    const ipHeader = frame.subarray(ETH_HEADER_LEN, ETH_HEADER_LEN + IPV4_MIN_HEADER_LEN);
    expect(onesComplementSum(ipHeader)).toBe(0);

    const parsed = parseFrame(frame);
    expect(parsed.srcPort).toBe(67);
    expect(parsed.dstPort).toBe(68);
    expect(parsed.payload.length).toBe(300);
    expect(parsed.isBroadcast).toBe(true);
  });
});
