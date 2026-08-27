import { isRecord } from '@repo/utils';
import { createHash } from 'node:crypto';

// `pass$` stays anchored so the fleet schema's `passthrough`/`passthroughSupported` keep their diagnostic value
export const SECRET_KEY_RE =
  /(secret|token|password|passwd|private|credential|api[_-]?key|authorization|passphrase|user[_-]?data|cloud[_-]?init|pub[_-]?keys?|pass$|_keys?$)/i;

export const isSecretKey = (key: string): boolean => SECRET_KEY_RE.test(key);

export const looksLikeDsn = (value: string): boolean => value.includes('://') && value.includes('@');

// the run is bounded: unbounded it backtracks quadratically on long schemeless text (seconds of cpu per 50 KiB)
const DSN_SCHEME = '(?:[a-z][a-z0-9+.-]{0,63})';
// greedy (a password may contain '@') but barred from the chars RFC 3986 excludes from an authority, so one match can never span two dsns
const DSN_USERINFO = '[^\\s/?#]*@';
const WHOLE_DSN_USERINFO_RE = new RegExp(`^(${DSN_SCHEME}://)${DSN_USERINFO}`, 'i');
const EMBEDDED_DSN_USERINFO_RE = new RegExp(`(${DSN_SCHEME}?://)${DSN_USERINFO}`, 'gi');

// Redact the WHOLE userinfo (a secret can ride in the username); fail closed — a DSN `new URL` can't parse must never be returned raw.
export function maskDsn(value: string): string {
  try {
    const u = new URL(value);
    if (u.username || u.password) {
      u.username = '***';
      u.password = '';
    }
    return u.toString();
  } catch {
    const masked = value.replace(WHOLE_DSN_USERINFO_RE, '$1***@');
    return masked === value ? '***' : masked;
  }
}

// rewrites only the userinfo: a dsn rides inside sql/netplan/prose, and collapsing the whole value would destroy the evidence the audit trail exists for
export function maskEmbeddedDsns(value: string): string {
  return value.replace(EMBEDDED_DSN_USERINFO_RE, '$1***@');
}

export const REDACTED = '***';
const redactSecretValue = (value: unknown): string =>
  Array.isArray(value) ? `<redacted: ${value.length} items>` : REDACTED;

const AUDIT_PARAMS_MAX_BYTES = 8192;
const TRUNCATION_SUFFIX = '…[truncated]';

export function redactPayload(value: unknown): unknown {
  return redact(value, new WeakSet());
}

// The config write body is `entries: { <nix path>: value }`. A path key cannot be judged by name --
// zoneCrypto.bridgeAtRestKey is declared secret and reads as ordinary -- so every value is masked.
const PATH_KEYED_BODY = 'entries';
const maskPathKeyedValues = (entries: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, v === null ? null : redactSecretValue(v)]));

// `seen` is path-scoped (deleted on the way out) so a shared non-cyclic reference still expands
function redact(value: unknown, seen: WeakSet<object>): unknown {
  // a credential can ride in the VALUE under an innocuous key (`hub.DATABASE_URL`), which the key predicate alone can never catch
  if (typeof value === 'string') return maskEmbeddedDsns(value);
  if (Array.isArray(value)) {
    if (seen.has(value)) return REDACTED;
    seen.add(value);
    const items = value.map((item) => redact(item, seen));
    seen.delete(value);
    return items;
  }
  if (isRecord(value)) {
    if (seen.has(value)) return REDACTED;
    seen.add(value);
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      out[key] = isSecretKey(key)
        ? redactSecretValue(child)
        : key === PATH_KEYED_BODY && isRecord(child)
          ? maskPathKeyedValues(child)
          : redact(child, seen);
    }
    seen.delete(value);
    return out;
  }
  return value;
}

export const PAYLOAD_BYTE_CAP = 8 * 1024;

export interface RedactedPayload {
  value: unknown;
  truncated: boolean;
}

interface Budget {
  left: number;
  truncated: boolean;
}

// the budget is a per-node heuristic, not exact byte accounting — it exists to stop expanding a
// multi-MiB collector payload early, not to land the serialized result on the cap exactly
export function redactPayloadCapped(value: unknown, cap = PAYLOAD_BYTE_CAP): RedactedPayload {
  const budget: Budget = { left: cap, truncated: false };
  return { value: walkCapped(value, budget, new WeakSet()), truncated: budget.truncated };
}

function walkCapped(value: unknown, budget: Budget, seen: WeakSet<object>): unknown {
  if (Array.isArray(value)) {
    if (seen.has(value)) return REDACTED;
    seen.add(value);
    const out: unknown[] = [];
    for (const item of value) {
      if (budget.left <= 0) {
        budget.truncated = true;
        break;
      }
      budget.left -= 1;
      out.push(walkCapped(item, budget, seen));
    }
    seen.delete(value);
    return out;
  }
  if (isRecord(value)) {
    if (seen.has(value)) return REDACTED;
    seen.add(value);
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (budget.left <= 0) {
        budget.truncated = true;
        break;
      }
      budget.left -= key.length + 4;
      // a key is emitted whole or not at all — truncating one could collide with another and drop it
      if (budget.left < 0) {
        budget.truncated = true;
        break;
      }
      out[key] = isSecretKey(key)
        ? redactSecretValue(item)
        : key === PATH_KEYED_BODY && isRecord(item)
          ? maskPathKeyedValues(item)
          : walkCapped(item, budget, seen);
    }
    seen.delete(value);
    return out;
  }
  return walkCappedScalar(value, budget);
}

function walkCappedScalar(value: unknown, budget: Budget): unknown {
  if (typeof value !== 'string') {
    budget.left -= 8;
    return value;
  }
  // mask before the cut — a credential in the kept prefix must not survive truncation
  const masked = maskEmbeddedDsns(value);
  budget.left -= masked.length + 2;
  if (budget.left >= 0) return masked;
  budget.truncated = true;
  const keep = masked.length + budget.left;
  return keep > 0 ? `${masked.slice(0, keep)}${TRUNCATION_SUFFIX}` : TRUNCATION_SUFFIX;
}

export interface RedactedText {
  value: string;
  truncated: boolean;
}

// free text from a third party (an endpoint's response, an error the hub recorded) is masked before
// the cut, so a credential in the kept prefix cannot survive truncation
export function redactTextCapped(value: string, cap: number): RedactedText {
  const masked = maskEmbeddedDsns(value);
  if (masked.length <= cap) return { value: masked, truncated: false };
  return { value: `${masked.slice(0, cap)}${TRUNCATION_SUFFIX}`, truncated: true };
}

export function serializeAuditParams(value: unknown): string | null {
  if (value === undefined) return null;
  const redacted = redactPayload(value);
  if (isRecord(redacted) && Object.keys(redacted).length === 0) return null;
  const json = JSON.stringify(redacted);
  if (json === undefined) return null;
  return Buffer.byteLength(json) <= AUDIT_PARAMS_MAX_BYTES ? json : truncateToCap(json);
}

// an over-cap payload is stored as a JSON *string* holding a prefix — slicing the object itself would leave unparseable JSON
function truncateToCap(json: string): string {
  let keep = AUDIT_PARAMS_MAX_BYTES;
  let out = JSON.stringify(json.slice(0, keep) + TRUNCATION_SUFFIX);
  let overflow = Buffer.byteLength(out) - AUDIT_PARAMS_MAX_BYTES;
  while (overflow > 0 && keep > 0) {
    keep = Math.max(0, keep - overflow);
    out = JSON.stringify(json.slice(0, keep) + TRUNCATION_SUFFIX);
    overflow = Buffer.byteLength(out) - AUDIT_PARAMS_MAX_BYTES;
  }
  return out;
}

/** A secret's value never leaves the host, so an overridden secret is only detectable by comparing two
 *  fingerprints of it. Same input, same digest — that is the whole contract. */
export const secretDigest = (value: string): string =>
  value ? createHash('sha256').update(value).digest('hex').slice(0, 8) : '';

// Even with `reveal`, a secret-keyed value is NEVER returned raw — the fingerprint confirms identity
// without the credential leaving the box. The length is carried because two blanks are worth telling apart.
export const fingerprintSecret = (value: string): string =>
  value ? `***sha256:${secretDigest(value)} (len ${value.length})` : '***';
