import { clampTtl, FLAG_QR_RESPONSE, skipName, skipQuestion } from './protocol.js';

const HEADER_LEN = 12;
const RR_FIXED_LEN = 10;

const RCODE_MASK = 0x0f;
const RCODE_NOERROR = 0;
const RCODE_NXDOMAIN = 3;
const FLAG_TC = 0x0200;

const QTYPE_SOA = 6;
const QTYPE_OPT = 41;

const MAX_CACHE_TTL_SECONDS = 86400;
const MAX_NEGATIVE_TTL_SECONDS = 600;

export const DEFAULT_CACHE_CAPACITY = 150;

interface CacheEntry {
  bytes: Buffer;
  expiresAtMs: number;
}

export interface DnsCacheOptions {
  capacity: number;
  nowMs?: () => number;
  maxCacheTtlSeconds?: number;
  minCacheTtlSeconds?: number;
  negTtlSeconds?: number;
}

function cacheKey(qname: string, qtype: number): string {
  return `${qname} ${qtype}`;
}

function withTxnId(bytes: Buffer, txnId: number): Buffer {
  const out = Buffer.from(bytes);
  out.writeUInt16BE(txnId & 0xffff, 0);
  return out;
}

function withDecrementedTtls(bytes: Buffer, remainingSeconds: number): Buffer {
  if (bytes.length < HEADER_LEN) return bytes;
  const rrCount = bytes.readUInt16BE(6) + bytes.readUInt16BE(8);
  if (rrCount === 0) return bytes;
  const questionEnd = skipQuestion(bytes);
  if (questionEnd === null) return bytes;

  const out = Buffer.from(bytes);
  let offset = questionEnd;
  for (let i = 0; i < rrCount; i++) {
    const afterName = skipName(out, offset);
    if (afterName === null) return bytes;
    if (afterName + RR_FIXED_LEN > out.length) return bytes;
    const type = out.readUInt16BE(afterName);
    const rdlength = out.readUInt16BE(afterName + 8);
    const rdataEnd = afterName + RR_FIXED_LEN + rdlength;
    if (rdataEnd > out.length) return bytes;
    if (type !== QTYPE_OPT) {
      const ttl = out.readUInt32BE(afterName + 4);
      if (remainingSeconds < ttl) out.writeUInt32BE(remainingSeconds, afterName + 4);
    }
    offset = rdataEnd;
  }
  return out;
}

export function minResponseTtlSeconds(packet: Buffer): number | null {
  if (packet.length < HEADER_LEN) return null;
  const ancount = packet.readUInt16BE(6);
  const nscount = packet.readUInt16BE(8);
  const rrCount = ancount + nscount;
  if (rrCount === 0) return null;

  let offset = skipQuestion(packet);
  if (offset === null) return null;

  let minTtl = Number.POSITIVE_INFINITY;
  for (let i = 0; i < rrCount; i++) {
    const afterName = skipName(packet, offset);
    if (afterName === null) return null;
    offset = afterName;
    if (offset + RR_FIXED_LEN > packet.length) return null;
    const ttl = packet.readUInt32BE(offset + 4);
    const rdlength = packet.readUInt16BE(offset + 8);
    offset += RR_FIXED_LEN + rdlength;
    if (offset > packet.length) return null;
    if (ttl < minTtl) minTtl = ttl;
  }

  if (minTtl === 0) return null;
  return Math.min(minTtl, MAX_CACHE_TTL_SECONDS);
}

export function negativeTtlSeconds(packet: Buffer, negTtlFallback = 0): number | null {
  if (packet.length < HEADER_LEN) return negTtlFallback > 0 ? negTtlFallback : null;
  const ancount = packet.readUInt16BE(6);
  const nscount = packet.readUInt16BE(8);
  if (nscount === 0) return negTtlFallback > 0 ? negTtlFallback : null;

  let offset = skipQuestion(packet);
  if (offset === null) return null;

  for (let i = 0; i < ancount; i++) {
    const skipped = skipRr(packet, offset);
    if (skipped === null) return null;
    offset = skipped;
  }

  for (let i = 0; i < nscount; i++) {
    const afterName = skipName(packet, offset);
    if (afterName === null) return null;
    if (afterName + RR_FIXED_LEN > packet.length) return null;
    const rrtype = packet.readUInt16BE(afterName);
    const ttl = packet.readUInt32BE(afterName + 4);
    const rdlength = packet.readUInt16BE(afterName + 8);
    const rdataStart = afterName + RR_FIXED_LEN;
    const rdataEnd = rdataStart + rdlength;
    if (rdataEnd > packet.length) return null;
    if (rrtype === QTYPE_SOA) {
      if (rdlength < 22) return null;
      const minimum = packet.readUInt32BE(rdataEnd - 4);
      const ttlSeconds = Math.min(ttl, minimum);
      if (ttlSeconds === 0) return null;
      return Math.min(ttlSeconds, MAX_NEGATIVE_TTL_SECONDS);
    }
    offset = rdataEnd;
  }

  return negTtlFallback > 0 ? negTtlFallback : null;
}

function skipRr(packet: Buffer, offset: number): number | null {
  const afterName = skipName(packet, offset);
  if (afterName === null) return null;
  if (afterName + RR_FIXED_LEN > packet.length) return null;
  const rdlength = packet.readUInt16BE(afterName + 8);
  const end = afterName + RR_FIXED_LEN + rdlength;
  if (end > packet.length) return null;
  return end;
}

function stripAdditionalSection(packet: Buffer): Buffer | null {
  if (packet.length < HEADER_LEN) return null;
  const arcount = packet.readUInt16BE(10);
  if (arcount === 0) return packet;

  const ancount = packet.readUInt16BE(6);
  const nscount = packet.readUInt16BE(8);

  let offset = skipQuestion(packet);
  if (offset === null) return null;
  for (let i = 0; i < ancount + nscount; i++) {
    const skipped = skipRr(packet, offset);
    if (skipped === null) return null;
    offset = skipped;
  }
  if (offset > packet.length) return null;

  const out = Buffer.from(packet.subarray(0, offset));
  out.writeUInt16BE(0, 10);
  return out;
}

export class DnsCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly capacity: number;
  private readonly nowMs: () => number;
  private readonly maxCacheTtlSeconds: number;
  private readonly minCacheTtlSeconds: number;
  private readonly negTtlSeconds: number;

  constructor(options: DnsCacheOptions) {
    this.capacity = options.capacity;
    this.nowMs = options.nowMs ?? Date.now;
    this.maxCacheTtlSeconds = options.maxCacheTtlSeconds ?? 0;
    this.minCacheTtlSeconds = options.minCacheTtlSeconds ?? 0;
    this.negTtlSeconds = options.negTtlSeconds ?? 0;
  }

  get(qname: string, qtype: number, txnId: number): Buffer | null {
    const key = cacheKey(qname, qtype);
    const entry = this.entries.get(key);
    if (entry === undefined) return null;
    const now = this.nowMs();
    if (now >= entry.expiresAtMs) {
      this.entries.delete(key);
      return null;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    const remaining = Math.max(1, Math.ceil((entry.expiresAtMs - now) / 1000));
    return withTxnId(withDecrementedTtls(entry.bytes, remaining), txnId);
  }

  set(qname: string, qtype: number, bytes: Buffer, ttlSeconds: number): void {
    if (this.capacity <= 0) return;
    if (ttlSeconds <= 0) return;
    const key = cacheKey(qname, qtype);
    this.entries.delete(key);
    this.entries.set(key, { bytes: Buffer.from(bytes), expiresAtMs: this.nowMs() + ttlSeconds * 1000 });
    while (this.entries.size > this.capacity) {
      const lru = this.entries.keys().next().value;
      if (lru === undefined) break;
      this.entries.delete(lru);
    }
  }

  maybeStore(qname: string, qtype: number, bytes: Buffer): void {
    if (this.capacity <= 0) return;
    if (bytes.length < HEADER_LEN) return;
    const flags = bytes.readUInt16BE(2);
    if ((flags & FLAG_QR_RESPONSE) === 0) return;
    if ((flags & FLAG_TC) !== 0) return;
    if (bytes.readUInt16BE(4) !== 1) return;
    if (skipQuestion(bytes) === null) return;

    const rcode = flags & RCODE_MASK;
    const ancount = bytes.readUInt16BE(6);

    let ttlSeconds: number | null;
    if (rcode === RCODE_NXDOMAIN || (rcode === RCODE_NOERROR && ancount === 0)) {
      ttlSeconds = negativeTtlSeconds(bytes, this.negTtlSeconds);
    } else if (rcode === RCODE_NOERROR) {
      ttlSeconds = minResponseTtlSeconds(bytes);
    } else {
      return;
    }

    if (ttlSeconds === null || ttlSeconds <= 0) return;

    const stored = stripAdditionalSection(bytes);
    if (stored === null) return;

    this.set(qname, qtype, stored, clampTtl(ttlSeconds, this.minCacheTtlSeconds, this.maxCacheTtlSeconds));
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}
