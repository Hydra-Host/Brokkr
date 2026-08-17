import { getErrorMessage } from '../../common/error-utils.js';
import { decodeIp, encodeIp } from '../dhcp-options.js';
import { formatMac, macToBytes } from '../protocol.js';

const ETH_HEADER_LEN = 14;
const IPV4_MIN_HEADER_LEN = 20;
const UDP_HEADER_LEN = 8;
const ETHERTYPE_IPV4 = 0x0800;
const IPV4_VERSION_IHL = 0x45; // version 4, IHL 5 (20 bytes, no options)
const IPV4_PROTO_UDP = 17;
const IPV4_DEFAULT_TTL = 64;
const MAC_BYTES = 6;

const BROADCAST_MAC = Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);

export { BROADCAST_MAC, ETH_HEADER_LEN, ETHERTYPE_IPV4, IPV4_MIN_HEADER_LEN, MAC_BYTES, UDP_HEADER_LEN };

export class FrameParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FrameParseError';
  }
}

/** RFC 1071 one's-complement checksum; an odd trailing byte is the high byte of a final 16-bit word. */
export function onesComplementSum(buf: Buffer): number {
  let sum = 0;
  const len = buf.length;
  let i = 0;
  // Sum 16-bit words
  for (; i + 1 < len; i += 2) {
    sum += (buf[i] << 8) | buf[i + 1];
  }
  // Odd trailing byte
  if (i < len) {
    sum += buf[i] << 8;
  }
  // Fold 32-bit carries into 16 bits
  while (sum > 0xffff) {
    sum = (sum & 0xffff) + (sum >>> 16);
  }
  return ~sum & 0xffff;
}

// UDP checksum over the RFC 768 pseudo-header + segment. A zero (uncomputed) checksum is legal
// on send, but we compute it so receivers that validate don't drop us.
export function udpChecksum(srcIp: Buffer, dstIp: Buffer, udpSegment: Buffer): number {
  // Buffer.copy silently truncates/zero-pads wrong-length IPs, yielding a wrong checksum, not an error.
  if (srcIp.length !== 4 || dstIp.length !== 4) {
    throw new FrameParseError(`udpChecksum: IPv4 address must be 4 bytes (src=${srcIp.length}, dst=${dstIp.length})`);
  }
  // Pseudo-header: srcIP(4) + dstIP(4) + zero(1) + proto(1) + udpLength(2) = 12 bytes
  const pseudoLen = 12 + udpSegment.length;
  const pseudo = Buffer.alloc(pseudoLen);
  srcIp.copy(pseudo, 0);
  dstIp.copy(pseudo, 4);
  pseudo[8] = 0;
  pseudo[9] = IPV4_PROTO_UDP;
  pseudo.writeUInt16BE(udpSegment.length, 10);
  udpSegment.copy(pseudo, 12);
  const sum = onesComplementSum(pseudo);
  // RFC 768: if the computed checksum is zero, transmit 0xFFFF
  return sum === 0 ? 0xffff : sum;
}

export interface FrameBuildParams {
  srcMac: Buffer;
  dstMac: Buffer;
  srcIp: Buffer; // 4 bytes, network order
  dstIp: Buffer; // 4 bytes, network order
  srcPort: number;
  dstPort: number;
  payload: Buffer; // DHCP payload
}

export function buildFrame(params: FrameBuildParams): Buffer {
  const { srcMac, dstMac, srcIp, dstIp, srcPort, dstPort, payload } = params;
  // Fail loudly on wrong-length address buffers: Buffer.copy silently truncates, which would
  // otherwise emit a structurally-corrupt frame (zero-padded MAC/IP) with no error.
  if (srcMac.length !== MAC_BYTES || dstMac.length !== MAC_BYTES) {
    throw new FrameParseError(
      `buildFrame: MAC must be ${MAC_BYTES} bytes (src=${srcMac.length}, dst=${dstMac.length})`,
    );
  }
  if (srcIp.length !== 4 || dstIp.length !== 4) {
    throw new FrameParseError(`buildFrame: IPv4 address must be 4 bytes (src=${srcIp.length}, dst=${dstIp.length})`);
  }
  const ttl = IPV4_DEFAULT_TTL;
  const ipId = 0;

  const udpLen = UDP_HEADER_LEN + payload.length;
  const ipTotalLen = IPV4_MIN_HEADER_LEN + udpLen;
  const frameLen = ETH_HEADER_LEN + ipTotalLen;

  const frame = Buffer.alloc(frameLen);
  let offset = 0;

  // --- Ethernet header ---
  dstMac.copy(frame, offset);
  offset += MAC_BYTES;
  srcMac.copy(frame, offset);
  offset += MAC_BYTES;
  frame.writeUInt16BE(ETHERTYPE_IPV4, offset);
  offset += 2;

  // --- IPv4 header (20 bytes, no options) ---
  const ipStart = offset;
  frame[offset] = IPV4_VERSION_IHL;
  offset += 1;
  frame[offset] = 0; // DSCP/ECN
  offset += 1;
  frame.writeUInt16BE(ipTotalLen, offset);
  offset += 2;
  frame.writeUInt16BE(ipId, offset); // identification
  offset += 2;
  frame.writeUInt16BE(0x4000, offset); // flags: DF set, fragment offset 0
  offset += 2;
  frame[offset] = ttl;
  offset += 1;
  frame[offset] = IPV4_PROTO_UDP;
  offset += 1;
  // Checksum placeholder (zeroed) — filled after the header is complete
  frame.writeUInt16BE(0, offset);
  offset += 2;
  srcIp.copy(frame, offset);
  offset += 4;
  dstIp.copy(frame, offset);
  offset += 4;

  // Compute and write the IPv4 header checksum
  const ipHeader = frame.subarray(ipStart, ipStart + IPV4_MIN_HEADER_LEN);
  const cksum = onesComplementSum(ipHeader);
  ipHeader.writeUInt16BE(cksum, 10);

  // --- UDP header ---
  const udpStart = offset;
  frame.writeUInt16BE(srcPort, offset);
  offset += 2;
  frame.writeUInt16BE(dstPort, offset);
  offset += 2;
  frame.writeUInt16BE(udpLen, offset);
  offset += 2;
  // UDP checksum placeholder
  frame.writeUInt16BE(0, offset);
  offset += 2;

  // --- Payload ---
  payload.copy(frame, offset);

  // Compute and write the UDP checksum over pseudo-header + udp segment
  const udpSegment = frame.subarray(udpStart, udpStart + udpLen);
  const uCksum = udpChecksum(srcIp, dstIp, udpSegment);
  frame.writeUInt16BE(uCksum, udpStart + 6);

  return frame;
}

export interface ParsedFrame {
  srcMac: Buffer;
  dstMac: Buffer;
  srcIp: Buffer;
  dstIp: Buffer;
  srcPort: number;
  dstPort: number;
  payload: Buffer;
  isBroadcast: boolean;
}

// SOCK_RAW delivers frames with no kernel checksum verification, so the IPv4 header checksum is
// validated here. The UDP checksum is not: DHCPv4 clients commonly send 0 ("not computed", RFC 768).
export function parseFrame(frame: Buffer): ParsedFrame {
  if (frame.length < ETH_HEADER_LEN) {
    throw new FrameParseError(`frame too short for Ethernet header: ${frame.length} < ${ETH_HEADER_LEN}`);
  }

  const dstMac = Buffer.from(frame.subarray(0, MAC_BYTES));
  const srcMac = Buffer.from(frame.subarray(MAC_BYTES, MAC_BYTES * 2));
  const ethertype = frame.readUInt16BE(12);
  if (ethertype !== ETHERTYPE_IPV4) {
    throw new FrameParseError(`unexpected ethertype 0x${ethertype.toString(16)}, expected IPv4 (0x0800)`);
  }

  // --- IPv4 ---
  const ipStart = ETH_HEADER_LEN;
  if (frame.length < ipStart + IPV4_MIN_HEADER_LEN) {
    throw new FrameParseError(`frame too short for IPv4 header: ${frame.length}`);
  }

  const versionIhl = frame[ipStart];
  const version = (versionIhl >>> 4) & 0xf;
  if (version !== 4) {
    throw new FrameParseError(`IPv4 version ${version} is not 4`);
  }
  const ihl = (versionIhl & 0x0f) * 4;
  if (ihl < IPV4_MIN_HEADER_LEN) {
    throw new FrameParseError(`IPv4 IHL ${ihl} is less than minimum ${IPV4_MIN_HEADER_LEN}`);
  }
  if (frame.length < ipStart + ihl) {
    throw new FrameParseError(`frame too short for IPv4 header with IHL ${ihl}`);
  }

  const ipTotalLen = frame.readUInt16BE(ipStart + 2);
  if (ipTotalLen < ihl + UDP_HEADER_LEN) {
    throw new FrameParseError(`IPv4 total length ${ipTotalLen} too short for UDP`);
  }
  if (frame.length < ipStart + ipTotalLen) {
    throw new FrameParseError(`frame truncated: IPv4 total length ${ipTotalLen}, available ${frame.length - ipStart}`);
  }

  // RFC 1071: summing the whole header including the checksum field yields 0 when valid.
  const ipHeaderBuf = frame.subarray(ipStart, ipStart + ihl);
  if (onesComplementSum(ipHeaderBuf) !== 0) {
    throw new FrameParseError('bad IPv4 header checksum');
  }

  const protocol = frame[ipStart + 9];
  if (protocol !== IPV4_PROTO_UDP) {
    throw new FrameParseError(`IPv4 protocol ${protocol} is not UDP (${IPV4_PROTO_UDP})`);
  }

  const srcIp = Buffer.from(frame.subarray(ipStart + 12, ipStart + 16));
  const dstIp = Buffer.from(frame.subarray(ipStart + 16, ipStart + 20));

  // --- UDP ---
  const udpStart = ipStart + ihl;
  if (frame.length < udpStart + UDP_HEADER_LEN) {
    throw new FrameParseError(`frame too short for UDP header at offset ${udpStart}`);
  }

  const srcPort = frame.readUInt16BE(udpStart);
  const dstPort = frame.readUInt16BE(udpStart + 2);
  const udpLen = frame.readUInt16BE(udpStart + 4);
  if (udpLen < UDP_HEADER_LEN) {
    throw new FrameParseError(`UDP length ${udpLen} is less than header size ${UDP_HEADER_LEN}`);
  }
  if (udpStart + udpLen > ipStart + ipTotalLen) {
    throw new FrameParseError(`UDP length ${udpLen} exceeds IPv4 payload`);
  }

  const payloadStart = udpStart + UDP_HEADER_LEN;
  const payloadEnd = udpStart + udpLen;
  const payload = Buffer.from(frame.subarray(payloadStart, payloadEnd));

  const isBroadcast = dstMac.equals(BROADCAST_MAC);

  return { srcMac, dstMac, srcIp, dstIp, srcPort, dstPort, payload, isBroadcast };
}

/** Decode a 4-byte IPv4 Buffer to dotted-quad string. Throws FrameParseError on invalid input. */
export function bufferToIp(buf: Buffer): string {
  try {
    return decodeIp(buf);
  } catch (error) {
    throw new FrameParseError(getErrorMessage(error));
  }
}

/** Encode a dotted-quad IPv4 string to a 4-byte Buffer. Throws FrameParseError on invalid input. */
export function ipToBuffer(ip: string): Buffer {
  try {
    return encodeIp(ip);
  } catch (error) {
    throw new FrameParseError(getErrorMessage(error));
  }
}

/** Parse a colon/dash-separated MAC address to a 6-byte Buffer. Enforces exactly 6 octets. */
export function macToBuffer(mac: string): Buffer {
  let buf: Buffer;
  try {
    buf = macToBytes(mac);
  } catch (error) {
    throw new FrameParseError(getErrorMessage(error));
  }
  if (buf.length !== MAC_BYTES) {
    throw new FrameParseError(`invalid MAC address: ${mac}`);
  }
  return buf;
}

/** Format a 6-byte MAC Buffer as a lowercased colon-hex string. */
export function bufferToMac(buf: Buffer): string {
  if (buf.length !== MAC_BYTES) {
    throw new FrameParseError(`expected ${MAC_BYTES}-byte MAC, got ${buf.length}`);
  }
  return formatMac(buf);
}
