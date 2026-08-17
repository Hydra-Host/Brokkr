// Encoding must byte-match Python `json.dumps(value, default=str)`: `(", ", ": ")` separators, ASCII-only `\uXXXX` escapes, size measured over the escaped string; oversized rows are dropped so one misbehaving collector can't hand the hub an undeserializable payload.

import { isRecord } from '@repo/utils';

import { MAX_COLLECTOR_PAYLOAD_BYTES } from './bullmq.types';

export interface CollectorCacheRow {
  field: string;
  payload: string;
  rawSize: number;
}

export interface OversizedCollectorField {
  field: string;
  rawSize: number;
}

function* iterCollectorEntries(collector: string, data: unknown): Generator<[string, unknown]> {
  if (isRecord(data)) {
    for (const key of Object.keys(data)) {
      yield [key, data[key]];
    }
  } else {
    yield [collector, data];
  }
}

const ESCAPES: Record<string, string> = {
  '\\': '\\\\',
  '"': '\\"',
  '\b': '\\b',
  '\f': '\\f',
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
};

function pad4(n: number): string {
  const s = n.toString(16);
  return '0000'.slice(s.length) + s;
}

function encodeString(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    const code = s.charCodeAt(i);
    if (ch in ESCAPES) {
      out += ESCAPES[ch];
    } else if (code < 0x20 || code > 0x7e) {
      out += '\\u' + pad4(code);
    } else {
      out += ch;
    }
  }
  out += '"';
  return out;
}

function encodeNumber(n: number): string {
  if (!Number.isFinite(n)) {
    if (Number.isNaN(n)) return 'NaN';
    return n > 0 ? 'Infinity' : '-Infinity';
  }
  if (Number.isInteger(n)) return n.toString();
  return n.toString();
}

function encodeValue(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return encodeNumber(v);
  if (typeof v === 'string') return encodeString(v);
  if (Array.isArray(v)) {
    const items = v.map((item) => encodeValue(item));
    return '[' + items.join(', ') + ']';
  }
  if (isRecord(v)) {
    const parts: string[] = [];
    for (const key of Object.keys(v)) {
      parts.push(encodeString(key) + ': ' + encodeValue(v[key]));
    }
    return '{' + parts.join(', ') + '}';
  }
  return encodeString(String(v));
}

export function splitCollectorForCache(
  collector: string,
  data: unknown,
  maxPayloadBytes: number = MAX_COLLECTOR_PAYLOAD_BYTES,
): CollectorCacheRow[] {
  const rows: CollectorCacheRow[] = [];
  for (const [field, value] of iterCollectorEntries(collector, data)) {
    const payload = encodeValue(value);
    const rawSize = payload.length;
    if (rawSize > maxPayloadBytes) continue;
    rows.push({ field, payload, rawSize });
  }
  return rows;
}

export function oversizedCollectorFields(
  collector: string,
  data: unknown,
  maxPayloadBytes: number = MAX_COLLECTOR_PAYLOAD_BYTES,
): OversizedCollectorField[] {
  const dropped: OversizedCollectorField[] = [];
  for (const [field, value] of iterCollectorEntries(collector, data)) {
    const rawSize = encodeValue(value).length;
    if (rawSize > maxPayloadBytes) {
      dropped.push({ field, rawSize });
    }
  }
  return dropped;
}
