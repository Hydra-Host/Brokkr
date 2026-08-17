import { describe, expect, it } from 'vitest';

import { normalizeAgentLogEntry } from '../agent-log-normalize';
import { REPORTLOGS_MAX_FIELDS_JSON_BYTES, REPORTLOGS_MAX_MESSAGE_BYTES } from '../logging-context.constants';

const PREFIX = '[agent device=d] ';

function utf8Bytes(s: string): number {
  return Buffer.byteLength(s, 'utf-8');
}

describe('normalizeAgentLogEntry — message byte-cap invariants', () => {
  it('message at cap is not truncated', () => {
    const msg = 'a'.repeat(REPORTLOGS_MAX_MESSAGE_BYTES);
    const result = normalizeAgentLogEntry({
      level: 'info',
      message: msg,
      fieldsJson: '{}',
      deviceId: 'd',
    });
    expect(result.message.endsWith(msg)).toBe(true);
  });

  it('message at cap+1 is truncated to cap bytes after prefix', () => {
    const msg = 'a'.repeat(REPORTLOGS_MAX_MESSAGE_BYTES + 1);
    const result = normalizeAgentLogEntry({
      level: 'info',
      message: msg,
      fieldsJson: '{}',
      deviceId: 'd',
    });
    const body = result.message.slice(PREFIX.length);
    expect(utf8Bytes(body)).toBe(REPORTLOGS_MAX_MESSAGE_BYTES);
  });

  it('utf-8 partial codepoint at boundary is dropped', () => {
    const msg = 'a'.repeat(REPORTLOGS_MAX_MESSAGE_BYTES - 1) + 'é';
    const result = normalizeAgentLogEntry({
      level: 'info',
      message: msg,
      fieldsJson: '{}',
      deviceId: 'd',
    });
    const body = result.message.slice(PREFIX.length);
    expect(body).toBe('a'.repeat(REPORTLOGS_MAX_MESSAGE_BYTES - 1));
  });
});

describe('normalizeAgentLogEntry — fields_json byte-cap invariants', () => {
  it('fields_json at cap is parsed (not truncated)', () => {
    const overhead = '{"k":""}'.length;
    const payload = '{"k":"' + 'p'.repeat(REPORTLOGS_MAX_FIELDS_JSON_BYTES - overhead) + '"}';
    expect(utf8Bytes(payload)).toBe(REPORTLOGS_MAX_FIELDS_JSON_BYTES);
    const result = normalizeAgentLogEntry({
      level: 'info',
      message: 'm',
      fieldsJson: payload,
      deviceId: 'd',
    });
    expect(result.fieldsJsonTruncated).toBe(false);
    expect(result.fieldsJsonBytes).toBe(REPORTLOGS_MAX_FIELDS_JSON_BYTES);
  });

  it('fields_json at cap+1 is marked truncated', () => {
    const overhead = '{"k":""}'.length;
    const payload = '{"k":"' + 'p'.repeat(REPORTLOGS_MAX_FIELDS_JSON_BYTES + 1 - overhead) + '"}';
    expect(utf8Bytes(payload)).toBe(REPORTLOGS_MAX_FIELDS_JSON_BYTES + 1);
    const result = normalizeAgentLogEntry({
      level: 'info',
      message: 'm',
      fieldsJson: payload,
      deviceId: 'd',
    });
    expect(result.fieldsJsonTruncated).toBe(true);
    expect(result.fieldsJsonBytes).toBe(REPORTLOGS_MAX_FIELDS_JSON_BYTES + 1);
  });
});

describe('normalizeAgentLogEntry — CWE-117 verbatim passthrough', () => {
  const PAYLOADS: readonly string[] = [
    'line1\nline2',
    'line1\r\nline2',
    '\x1b[31mRED\x1b[0m normal',
    '\x07\x08\x0b\x0c',
    'before\x00after',
    '[agent device=evil] forged line',
  ];

  it.each(PAYLOADS)('message passthrough verbatim: %j', (payload) => {
    const result = normalizeAgentLogEntry({
      level: 'info',
      message: payload,
      fieldsJson: '{}',
      deviceId: 'd',
    });
    expect(result.message).toBe(`[agent device=d] ${payload}`);
  });

  it('device_id with newline rendered verbatim', () => {
    const result = normalizeAgentLogEntry({
      level: 'info',
      message: 'm',
      fieldsJson: '{}',
      deviceId: 'd\nFAKE',
    });
    expect(result.message).toBe('[agent device=d\nFAKE] m');
  });
});

describe('normalizeAgentLogEntry — trace-id extraction', () => {
  const TRACE_ID = '0af7651916cd43dd8448eb211c80319c';
  const SPAN_ID = 'b7ad6b7169203331';

  it('extracts well-formed lowercase-hex trace_id/span_id from fields', () => {
    const result = normalizeAgentLogEntry({
      level: 'info',
      message: 'm',
      fieldsJson: JSON.stringify({ trace_id: TRACE_ID, span_id: SPAN_ID }),
      deviceId: 'd',
    });
    expect(result.traceId).toBe(TRACE_ID);
    expect(result.spanId).toBe(SPAN_ID);
  });

  it('omits malformed ids (wrong length, uppercase, non-hex, non-string)', () => {
    const cases = [
      { trace_id: TRACE_ID.slice(1), span_id: SPAN_ID.slice(1) },
      { trace_id: TRACE_ID.toUpperCase(), span_id: SPAN_ID.toUpperCase() },
      { trace_id: 'z'.repeat(32), span_id: 'z'.repeat(16) },
      { trace_id: 42, span_id: true },
    ];
    for (const fields of cases) {
      const result = normalizeAgentLogEntry({
        level: 'info',
        message: 'm',
        fieldsJson: JSON.stringify(fields),
        deviceId: 'd',
      });
      expect(result.traceId).toBeUndefined();
      expect(result.spanId).toBeUndefined();
    }
  });

  it('omits ids entirely when fields carry none', () => {
    const result = normalizeAgentLogEntry({
      level: 'info',
      message: 'm',
      fieldsJson: '{}',
      deviceId: 'd',
    });
    expect(result.traceId).toBeUndefined();
    expect(result.spanId).toBeUndefined();
  });
});
