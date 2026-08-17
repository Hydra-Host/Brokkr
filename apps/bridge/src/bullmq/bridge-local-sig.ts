import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';

import { isRecord } from '@repo/utils';

const MAX_AGE_SECONDS = 300;
const FUTURE_SKEW_SECONDS = 60;
const VERSION = 1;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const AEAD_INFO = Buffer.from('brokkr-bridge-local-aead-v1', 'utf8');
const SIGNING_INFO = Buffer.from('brokkr-bridge-local-signing-v1', 'utf8');

export interface BridgeLocalRouting {
  job_id: string;
  job_name: string;
  queue_name: string;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!isRecord(value)) return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) sorted[key] = sortKeys(value[key]);
  return sorted;
}

function deriveKey(key: Buffer, info: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', key, Buffer.alloc(0), info, KEY_BYTES));
}

function canonicalBytes(payload: Record<string, unknown>, routing: BridgeLocalRouting, ts: string): Buffer {
  return Buffer.from(
    JSON.stringify({
      job_id: routing.job_id,
      job_name: routing.job_name,
      payload: sortKeys(payload),
      queue_name: routing.queue_name,
      ts,
      v: VERSION,
    }),
    'utf8',
  );
}

function aadBytes(routing: BridgeLocalRouting, ts: string): Buffer {
  return Buffer.from(
    JSON.stringify({
      job_id: routing.job_id,
      job_name: routing.job_name,
      queue_name: routing.queue_name,
      ts,
      v: VERSION,
    }),
    'utf8',
  );
}

function signature(key: Buffer, payload: Record<string, unknown>, routing: BridgeLocalRouting, ts: string): string {
  return createHmac('sha256', deriveKey(key, SIGNING_INFO))
    .update(canonicalBytes(payload, routing, ts))
    .digest('hex');
}

function validateTimestamp(ts: string): void {
  if (!/^\d+$/.test(ts)) throw new Error('Invalid bridge-local timestamp');
  const timestamp = Number(ts);
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(timestamp) || now - timestamp > MAX_AGE_SECONDS || timestamp - now > FUTURE_SKEW_SECONDS) {
    throw new Error('Bridge-local signature timestamp is outside the allowed window');
  }
}

export function signBridgeLocalJob(
  key: Buffer,
  payload: Record<string, unknown>,
  routing: BridgeLocalRouting,
): { ts: string; sig: string } {
  const ts = String(Math.floor(Date.now() / 1000));
  return { ts, sig: signature(key, payload, routing, ts) };
}

export function verifyBridgeLocalSig(
  key: Buffer,
  ts: string,
  sig: string,
  payload: Record<string, unknown>,
  routing: BridgeLocalRouting,
): void {
  validateTimestamp(ts);
  const expected = Buffer.from(signature(key, payload, routing, ts), 'hex');
  const actual = Buffer.from(sig, 'hex');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error('Invalid bridge-local signature');
  }
}

export function sealBridgeLocalJob(
  key: Buffer,
  payload: Record<string, unknown>,
  routing: BridgeLocalRouting,
): Record<string, unknown> {
  const { ts, sig } = signBridgeLocalJob(key, payload, routing);
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(key, AEAD_INFO), nonce);
  cipher.setAAD(aadBytes(routing, ts));
  const ciphertext = Buffer.concat([cipher.update(canonicalBytes(payload, routing, ts)), cipher.final()]);
  return {
    __bridge_local: true,
    __bridge_local_v: VERSION,
    __bridge_local_ts: ts,
    __bridge_local_sig: sig,
    __bridge_local_nonce: nonce.toString('base64'),
    __bridge_local_ciphertext: ciphertext.toString('base64'),
    __bridge_local_tag: cipher.getAuthTag().toString('base64'),
  };
}

export function openBridgeLocalJob(
  key: Buffer,
  envelope: Record<string, unknown>,
  routing: BridgeLocalRouting,
): Record<string, unknown> {
  const ts = envelope.__bridge_local_ts;
  const sig = envelope.__bridge_local_sig;
  if (typeof ts !== 'string' || typeof sig !== 'string') {
    throw new Error('Bridge-local signature fields are missing');
  }
  validateTimestamp(ts);
  if (
    envelope.__bridge_local_v !== VERSION ||
    typeof envelope.__bridge_local_nonce !== 'string' ||
    typeof envelope.__bridge_local_ciphertext !== 'string' ||
    typeof envelope.__bridge_local_tag !== 'string'
  ) {
    throw new Error('Bridge-local encryption fields are missing');
  }
  const nonce = Buffer.from(envelope.__bridge_local_nonce, 'base64');
  const tag = Buffer.from(envelope.__bridge_local_tag, 'base64');
  if (nonce.length !== NONCE_BYTES || tag.length !== TAG_BYTES) {
    throw new Error('Bridge-local encryption fields are invalid');
  }
  const decipher = createDecipheriv('aes-256-gcm', deriveKey(key, AEAD_INFO), nonce);
  decipher.setAAD(aadBytes(routing, ts));
  decipher.setAuthTag(tag);
  const decoded = Buffer.concat([
    decipher.update(Buffer.from(envelope.__bridge_local_ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
  const parsed: unknown = JSON.parse(decoded);
  if (!isRecord(parsed) || !isRecord(parsed.payload)) throw new Error('Bridge-local payload is invalid');
  const payload = parsed.payload;
  verifyBridgeLocalSig(key, ts, sig, payload, routing);
  return payload;
}
