import { expandIpv6 } from '../common/ipv6-utils.js';

export const FLAG_QR_RESPONSE = 0x8000;
const FLAG_AA = 0x0400;
export const FLAG_TC = 0x0200;
const FLAG_RD = 0x0100;
const FLAG_RA = 0x0080;

const RCODE_NXDOMAIN = 3;
const RCODE_SERVFAIL = 2;
const RCODE_NOTIMP = 4;

export const QTYPE_A = 1;
export const QTYPE_PTR = 12;
export const QTYPE_AAAA = 28;
const QTYPE_OPT = 41;
export const QCLASS_IN = 1;

const HEADER_LEN = 12;
const RR_FIXED_LEN = 10;
const COMPRESSION_POINTER_MASK = 0xc0;
const MAX_NAME_OCTETS = 255;

export class DnsParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DnsParseError';
  }
}

export interface ParsedQuery {
  txnId: number;
  qname: string;
  qtype: number;
  qclass: number;
  opcode: number;
  recursionDesired: boolean;
}

export function parseQuery(packet: Buffer): ParsedQuery {
  if (packet.length < HEADER_LEN) {
    throw new DnsParseError('packet shorter than DNS header');
  }

  const txnId = packet.readUInt16BE(0);
  const flags = packet.readUInt16BE(2);
  if ((flags & FLAG_QR_RESPONSE) !== 0) {
    throw new DnsParseError('packet is a response, not a query');
  }
  const qdcount = packet.readUInt16BE(4);
  if (qdcount < 1) {
    throw new DnsParseError('no question in query');
  }
  if (qdcount > 1) {
    throw new DnsParseError(`multi-question query not supported (qdcount=${qdcount})`);
  }

  const opcode = (flags >> 11) & 0x0f;
  const recursionDesired = (flags & FLAG_RD) !== 0;
  const qnameParts: string[] = [];
  let nameLen = 0;
  let offset = HEADER_LEN;
  for (;;) {
    if (offset >= packet.length) {
      throw new DnsParseError('truncated qname');
    }
    const length = packet[offset];
    if (length === 0) {
      nameLen += 1;
      if (nameLen > MAX_NAME_OCTETS) {
        throw new DnsParseError('qname exceeds 255 octets');
      }
      offset += 1;
      break;
    }
    if ((length & 0xc0) !== 0) {
      throw new DnsParseError('compression pointer in question section');
    }
    nameLen += 1 + length;
    if (nameLen > MAX_NAME_OCTETS) {
      throw new DnsParseError('qname exceeds 255 octets');
    }
    offset += 1;
    const end = offset + length;
    if (end > packet.length) {
      throw new DnsParseError('qname label runs past packet end');
    }
    qnameParts.push(packet.toString('ascii', offset, end));
    offset = end;
  }

  if (offset + 4 > packet.length) {
    throw new DnsParseError('truncated qtype/qclass');
  }
  const qtype = packet.readUInt16BE(offset);
  const qclass = packet.readUInt16BE(offset + 2);

  return {
    txnId,
    qname: qnameParts.join('.').toLowerCase(),
    qtype,
    qclass,
    opcode,
    recursionDesired,
  };
}

export function buildAResponse(packet: Buffer, answerIps: string[], ttl: number): Buffer {
  if (answerIps.length === 0) {
    throw new DnsParseError('buildAResponse requires at least one answer IP');
  }
  const { txnId, qtype, recursionDesired } = parseQuery(packet);
  if (qtype !== QTYPE_A) {
    throw new DnsParseError(`buildAResponse called for qtype=${qtype}, expected A`);
  }

  const question = sliceQuestion(packet);
  const flags = FLAG_QR_RESPONSE | FLAG_AA | FLAG_RA | (recursionDesired ? FLAG_RD : 0);
  const header = buildHeader(txnId, flags, 1, answerIps.length, 0, 0);
  const wireTtl = ttl & 0x7fffffff;

  const answers = answerIps.map((ip) => {
    const record = Buffer.alloc(16);
    record.writeUInt16BE(0xc00c, 0);
    record.writeUInt16BE(QTYPE_A, 2);
    record.writeUInt16BE(QCLASS_IN, 4);
    record.writeUInt32BE(wireTtl, 6);
    record.writeUInt16BE(4, 10);
    packIpv4(ip).copy(record, 12);
    return record;
  });

  return Buffer.concat([header, question, ...answers]);
}

export function buildEmptyNoError(packet: Buffer): Buffer {
  const { txnId, recursionDesired } = parseQuery(packet);
  const question = sliceQuestion(packet);
  const flags = FLAG_QR_RESPONSE | FLAG_AA | FLAG_RA | (recursionDesired ? FLAG_RD : 0);
  const header = buildHeader(txnId, flags, 1, 0, 0, 0);
  return Buffer.concat([header, question]);
}

export function buildNxdomain(packet: Buffer): Buffer {
  const { txnId, recursionDesired } = parseQuery(packet);
  const question = sliceQuestion(packet);
  const flags = FLAG_QR_RESPONSE | FLAG_AA | FLAG_RA | (recursionDesired ? FLAG_RD : 0) | RCODE_NXDOMAIN;
  const header = buildHeader(txnId, flags, 1, 0, 0, 0);
  return Buffer.concat([header, question]);
}

export function buildServfail(packet: Buffer): Buffer {
  const { txnId, recursionDesired } = parseQuery(packet);
  const question = sliceQuestion(packet);
  const flags = FLAG_QR_RESPONSE | FLAG_RA | (recursionDesired ? FLAG_RD : 0) | RCODE_SERVFAIL;
  const header = buildHeader(txnId, flags, 1, 0, 0, 0);
  return Buffer.concat([header, question]);
}

export function readOpcode(packet: Buffer): number {
  return (packet.readUInt16BE(2) >> 11) & 0x0f;
}

export function buildNotImplemented(packet: Buffer): Buffer {
  const { txnId, opcode, recursionDesired } = parseQuery(packet);
  const question = sliceQuestion(packet);
  const flags = FLAG_QR_RESPONSE | (opcode << 11) | (recursionDesired ? FLAG_RD : 0) | RCODE_NOTIMP;
  const header = buildHeader(txnId, flags, 1, 0, 0, 0);
  return Buffer.concat([header, question]);
}

export function buildNotImplementedHeaderOnly(packet: Buffer): Buffer {
  const txnId = packet.readUInt16BE(0);
  const opcode = readOpcode(packet);
  const rd = packet.readUInt16BE(2) & FLAG_RD;
  const flags = FLAG_QR_RESPONSE | (opcode << 11) | rd | RCODE_NOTIMP;
  return buildHeader(txnId, flags, 0, 0, 0, 0);
}

export const UDP_MAX_MESSAGE_BYTES = 512;

export function truncateForUdp(response: Buffer): Buffer {
  if (response.length < HEADER_LEN) return response;
  if (response.length <= UDP_MAX_MESSAGE_BYTES) return response;

  const questionEnd = skipQuestion(response);
  const header = Buffer.from(response.subarray(0, HEADER_LEN));
  header.writeUInt16BE(header.readUInt16BE(2) | FLAG_TC, 2);
  header.writeUInt16BE(0, 6);
  header.writeUInt16BE(0, 8);
  header.writeUInt16BE(0, 10);

  if (questionEnd === null || questionEnd > UDP_MAX_MESSAGE_BYTES) {
    header.writeUInt16BE(0, 4);
    return header;
  }
  return Buffer.concat([header, response.subarray(HEADER_LEN, questionEnd)]);
}

function buildHeader(
  txnId: number,
  flags: number,
  qdcount: number,
  ancount: number,
  nscount: number,
  arcount: number,
): Buffer {
  const header = Buffer.alloc(HEADER_LEN);
  header.writeUInt16BE(txnId, 0);
  header.writeUInt16BE(flags, 2);
  header.writeUInt16BE(qdcount, 4);
  header.writeUInt16BE(ancount, 6);
  header.writeUInt16BE(nscount, 8);
  header.writeUInt16BE(arcount, 10);
  return header;
}

export function sliceQuestion(packet: Buffer): Buffer {
  let offset = HEADER_LEN;
  while (offset < packet.length && packet[offset] !== 0) {
    if ((packet[offset] & COMPRESSION_POINTER_MASK) !== 0) {
      throw new DnsParseError('compression pointer or reserved label type in question');
    }
    if (offset - HEADER_LEN + 1 + packet[offset] >= MAX_NAME_OCTETS) {
      throw new DnsParseError('qname exceeds 255 octets');
    }
    offset += 1 + packet[offset];
  }
  if (offset >= packet.length) {
    throw new DnsParseError('qname runs past packet end');
  }
  if (offset + 1 + 4 > packet.length) {
    throw new DnsParseError('truncated qtype/qclass');
  }
  return packet.subarray(HEADER_LEN, offset + 1 + 4);
}

export function skipName(packet: Buffer, offset: number): number | null {
  let cursor = offset;
  for (;;) {
    if (cursor >= packet.length) return null;
    const length = packet[cursor];
    if ((length & COMPRESSION_POINTER_MASK) === COMPRESSION_POINTER_MASK) {
      if (cursor + 2 > packet.length) return null;
      return cursor + 2;
    }
    if (length > 63) return null;
    if (length === 0) return cursor + 1;
    cursor += 1 + length;
  }
}

export function skipQuestion(packet: Buffer): number | null {
  const afterName = skipName(packet, HEADER_LEN);
  if (afterName === null) return null;
  const afterFixed = afterName + 4;
  if (afterFixed > packet.length) return null;
  return afterFixed;
}

export function clampTtl(ttl: number, min: number, max: number): number {
  let t = ttl;
  if (max !== 0 && t > max) t = max;
  if (min !== 0 && t < min) t = min;
  return t;
}

export function clampAnswerTtls(buf: Buffer, opts: { min: number; max: number }): Buffer {
  if (opts.min === 0 && opts.max === 0) return buf;
  if (buf.length < HEADER_LEN) return buf;
  if (buf.readUInt16BE(4) !== 1) return buf;
  const rrCount = buf.readUInt16BE(6) + buf.readUInt16BE(8) + buf.readUInt16BE(10);
  const questionEnd = skipQuestion(buf);
  if (questionEnd === null) return buf;

  const out = Buffer.from(buf);
  let offset = questionEnd;
  for (let i = 0; i < rrCount; i++) {
    // On any parse-boundary failure, return the untouched original — never a half-clamped response with only the leading RRs rewritten.
    const afterName = skipName(out, offset);
    if (afterName === null) return buf;
    if (afterName + RR_FIXED_LEN > out.length) return buf;
    const type = out.readUInt16BE(afterName);
    const rdlength = out.readUInt16BE(afterName + 8);
    const rdataEnd = afterName + RR_FIXED_LEN + rdlength;
    if (rdataEnd > out.length) return buf;
    if (type !== QTYPE_OPT) {
      const ttl = out.readUInt32BE(afterName + 4);
      const clamped = clampTtl(ttl, opts.min, opts.max);
      if (clamped !== ttl) out.writeUInt32BE(clamped, afterName + 4);
    }
    offset = rdataEnd;
  }
  return out;
}

export function buildAAAAResponse(packet: Buffer, answerIps: string[], ttl: number): Buffer {
  if (answerIps.length === 0) {
    throw new DnsParseError('buildAAAAResponse requires at least one answer IP');
  }
  const { txnId, qtype, recursionDesired } = parseQuery(packet);
  if (qtype !== QTYPE_AAAA) {
    throw new DnsParseError(`buildAAAAResponse called for qtype=${qtype}, expected AAAA`);
  }

  const question = sliceQuestion(packet);
  const flags = FLAG_QR_RESPONSE | FLAG_AA | FLAG_RA | (recursionDesired ? FLAG_RD : 0);
  const header = buildHeader(txnId, flags, 1, answerIps.length, 0, 0);
  const wireTtl = ttl & 0x7fffffff;

  const answers = answerIps.map((ip) => {
    const record = Buffer.alloc(28);
    record.writeUInt16BE(0xc00c, 0);
    record.writeUInt16BE(QTYPE_AAAA, 2);
    record.writeUInt16BE(QCLASS_IN, 4);
    record.writeUInt32BE(wireTtl, 6);
    record.writeUInt16BE(16, 10);
    packIpv6(ip).copy(record, 12);
    return record;
  });

  return Buffer.concat([header, question, ...answers]);
}

export function buildPtrResponse(packet: Buffer, hostnames: string[], ttl: number): Buffer {
  const { txnId, qtype, recursionDesired } = parseQuery(packet);
  if (qtype !== QTYPE_PTR) {
    throw new DnsParseError(`buildPtrResponse called for qtype=${qtype}, expected PTR`);
  }
  if (hostnames.length === 0) {
    throw new DnsParseError('buildPtrResponse requires at least one hostname');
  }

  const question = sliceQuestion(packet);
  const flags = FLAG_QR_RESPONSE | FLAG_AA | FLAG_RA | (recursionDesired ? FLAG_RD : 0);
  const header = buildHeader(txnId, flags, 1, hostnames.length, 0, 0);
  const wireTtl = ttl & 0x7fffffff;

  const records: Buffer[] = [];
  for (const hostname of hostnames) {
    const encodedName = encodeDnsName(hostname);
    const record = Buffer.alloc(12 + encodedName.length);
    record.writeUInt16BE(0xc00c, 0);
    record.writeUInt16BE(QTYPE_PTR, 2);
    record.writeUInt16BE(QCLASS_IN, 4);
    record.writeUInt32BE(wireTtl, 6);
    record.writeUInt16BE(encodedName.length, 10);
    encodedName.copy(record, 12);
    records.push(record);
  }

  return Buffer.concat([header, question, ...records]);
}

function packIpv4(ip: string): Buffer {
  const octets = ip.split('.');
  if (octets.length !== 4) {
    throw new DnsParseError(`invalid IPv4 address: ${ip}`);
  }
  const buf = Buffer.alloc(4);
  for (let i = 0; i < 4; i++) {
    const value = Number.parseInt(octets[i], 10);
    if (!Number.isInteger(value) || value < 0 || value > 255) {
      throw new DnsParseError(`invalid IPv4 address: ${ip}`);
    }
    buf[i] = value;
  }
  return buf;
}

export function packIpv6(ip: string): Buffer {
  const normalized = expandIpv6(ip);
  if (normalized === null) {
    throw new DnsParseError(`invalid IPv6 address: ${ip}`);
  }
  const groups = normalized.split(':');
  if (groups.length !== 8) {
    throw new DnsParseError(`invalid IPv6 address: ${ip}`);
  }
  const buf = Buffer.alloc(16);
  for (let i = 0; i < 8; i++) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(groups[i])) {
      throw new DnsParseError(`invalid IPv6 address: ${ip}`);
    }
    const value = Number.parseInt(groups[i], 16);
    buf.writeUInt16BE(value, i * 2);
  }
  return buf;
}

export function encodeDnsName(name: string): Buffer {
  let normalized = name;
  if (normalized.endsWith('.')) {
    normalized = normalized.slice(0, -1);
  }
  if (normalized === '') {
    return Buffer.from([0]);
  }
  const labels = normalized.split('.');
  const parts: Buffer[] = [];
  let wireLen = 1;
  for (const label of labels) {
    if (label.length === 0 || label.length > 63) {
      throw new DnsParseError(`invalid DNS label in name: ${name}`);
    }
    wireLen += 1 + label.length;
    if (wireLen > MAX_NAME_OCTETS) {
      throw new DnsParseError(`encoded name exceeds ${MAX_NAME_OCTETS} octets: ${name}`);
    }
    parts.push(Buffer.from([label.length]));
    parts.push(Buffer.from(label, 'ascii'));
  }
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}
