import { Buffer } from 'node:buffer';

import type { SealDirection } from './errors';

export interface Aad {
  aad_v: number;
  zone_id: string;
  queue_name: string;
  direction: SealDirection;
  job_id: string;
  created_at: number;
}

export const REQUIRED_FIELDS: readonly string[] = [
  'aad_v',
  'created_at',
  'direction',
  'job_id',
  'queue_name',
  'zone_id',
];

export const SUPPORTED_AAD_VERSIONS: readonly number[] = [1];

export const VALID_DIRECTIONS: readonly SealDirection[] = ['hub_to_bridge', 'bridge_to_hub'];

const REQUIRED_FIELDS_SET = new Set<string>(REQUIRED_FIELDS);
const SUPPORTED_AAD_VERSIONS_SET = new Set<number>(SUPPORTED_AAD_VERSIONS);
const VALID_DIRECTIONS_SET: Set<string> = new Set(VALID_DIRECTIONS);

// Output is frozen, mirrored in bridge/services/auth/aad.py — any drift breaks decryption end-to-end (feeds both AES-GCM AAD and HKDF salt).
export function canonicalizeAad(aad: unknown): Buffer {
  validateAad(aad);
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(aad).sort()) {
    sorted[key] = aad[key];
  }
  return Buffer.from(JSON.stringify(sorted), 'utf8');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describeShape(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function validateAad(aad: unknown): asserts aad is Aad & Record<string, unknown> {
  if (!isPlainObject(aad)) {
    throw new Error(`aad must be an object, got ${describeShape(aad)}`);
  }

  const extra = Object.keys(aad).filter((k) => !REQUIRED_FIELDS_SET.has(k));
  if (extra.length > 0) {
    throw new Error(`aad contains unexpected fields: ${extra.sort().join(', ')}`);
  }
  const missing = REQUIRED_FIELDS.filter((k) => !(k in aad));
  if (missing.length > 0) {
    throw new Error(`aad is missing required fields: ${missing.sort().join(', ')}`);
  }

  const aadV = aad['aad_v'];
  if (typeof aadV !== 'number' || !Number.isInteger(aadV)) {
    throw new Error(`aad.aad_v must be an integer, got ${typeof aadV}`);
  }
  if (!SUPPORTED_AAD_VERSIONS_SET.has(aadV)) {
    throw new Error(`unsupported aad_v: ${aadV}`);
  }

  for (const field of ['zone_id', 'queue_name', 'direction', 'job_id']) {
    if (typeof aad[field] !== 'string') {
      throw new Error(`aad.${field} must be a string, got ${typeof aad[field]}`);
    }
  }

  const direction = aad['direction'];
  if (typeof direction !== 'string' || !VALID_DIRECTIONS_SET.has(direction)) {
    throw new Error(`aad.direction must be one of [${VALID_DIRECTIONS.join(', ')}], got ${JSON.stringify(direction)}`);
  }

  const createdAt = aad['created_at'];
  if (typeof createdAt !== 'number' || !Number.isInteger(createdAt)) {
    throw new Error(`aad.created_at must be an integer (Unix millis), got ${typeof createdAt}`);
  }
  if (createdAt < 0 || createdAt > Number.MAX_SAFE_INTEGER) {
    throw new Error(`aad.created_at must be in [0, ${Number.MAX_SAFE_INTEGER}], got ${createdAt}`);
  }
}
