import { isRecord } from './type-guards';

// `pass$` stays anchored so a `passthrough` flag keeps its diagnostic value
export const SECRET_KEY_RE =
  /(secret|token|password|passwd|private|credential|api[_-]?key|authorization|passphrase|user[_-]?data|cloud[_-]?init|pub[_-]?keys?|pass$|_keys?$)/i;

export const REDACTED = '***';
export const DEFAULT_PAYLOAD_BYTE_CAP = 16 * 1024;

export interface RedactPayloadOptions {
  maxBytes?: number;
}

export interface TruncatedPayload {
  truncated: true;
  bytes: number;
}

function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactValue);
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    out[key] = SECRET_KEY_RE.test(key) ? REDACTED : redactValue(inner);
  }
  return out;
}

/** Redacts secret-shaped keys at any depth, then caps the JSON size; above the cap only the size survives. */
export function redactPayload(value: unknown, options: RedactPayloadOptions = {}): unknown {
  if (value === null || value === undefined) return null;
  const redacted = redactValue(value);
  const bytes = new TextEncoder().encode(JSON.stringify(redacted)).length;
  const cap = options.maxBytes ?? DEFAULT_PAYLOAD_BYTE_CAP;
  if (bytes > cap) {
    const truncated: TruncatedPayload = { truncated: true, bytes };
    return truncated;
  }
  return redacted;
}
