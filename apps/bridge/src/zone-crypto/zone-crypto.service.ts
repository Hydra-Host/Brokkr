import { Injectable } from '@nestjs/common';

import { KEY_SIZE } from './auth-dh.types';

export interface ZoneCryptoSnapshot {
  zonePriv: Buffer;
  zonePub: Buffer;
  hubPub: Buffer;
  enrolledAt: number;
}

function typeName(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'string') return 'string';
  if (Array.isArray(value)) return 'array';
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return 'Uint8Array';
  if (typeof value === 'object') return 'object';
  return typeof value;
}

export function decodeHexKey(name: string, value: unknown, expectedLength: number): Buffer {
  if (typeof value !== 'string') {
    throw new Error(`zone_crypto.${name} must be a hex string, got ${typeName(value)}`);
  }
  const stripped = value.replace(/[\t\n\v\f\r ]/g, '');
  if (!/^[0-9a-fA-F]*$/.test(stripped) || stripped.length % 2 !== 0) {
    throw new Error(`zone_crypto.${name} is not valid hex`);
  }
  const buf = Buffer.from(stripped, 'hex');
  if (buf.length !== expectedLength) {
    throw new Error(`zone_crypto.${name} must be ${expectedLength} bytes, got ${buf.length}`);
  }
  return buf;
}

export function zoneCryptoToCacheBlob(state: ZoneCryptoSnapshot): Buffer {
  const payload = {
    enrolled_at: state.enrolledAt,
    hub_pub: state.hubPub.toString('hex'),
    zone_priv: state.zonePriv.toString('hex'),
    zone_pub: state.zonePub.toString('hex'),
  };
  return Buffer.from(JSON.stringify(payload), 'utf-8');
}

export function zoneCryptoFromCacheBlob(blob: Buffer): ZoneCryptoSnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(blob.toString('utf-8'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`zone_crypto cache blob is not valid JSON: ${message}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`zone_crypto cache blob must be a JSON object, got ${typeName(parsed)}`);
  }
  const obj = parsed as Record<string, unknown>;
  const zonePriv = decodeHexKey('zone_priv', obj.zone_priv, KEY_SIZE);
  const zonePub = decodeHexKey('zone_pub', obj.zone_pub, KEY_SIZE);
  const hubPub = decodeHexKey('hub_pub', obj.hub_pub, KEY_SIZE);
  const enrolledAt = obj.enrolled_at;
  if (typeof enrolledAt === 'boolean' || typeof enrolledAt !== 'number' || !Number.isInteger(enrolledAt)) {
    throw new Error(`zone_crypto.enrolled_at must be int (Unix millis), got ${typeName(enrolledAt)}`);
  }
  return { zonePriv, zonePub, hubPub, enrolledAt };
}

// The bootstrap runs BEFORE the Nest container exists, so it writes to this module-level singleton; the injectable service delegates so both paths see the same state.
let activeZoneCryptoSnapshot: ZoneCryptoSnapshot | null = null;

export function getActiveZoneCryptoSnapshot(): ZoneCryptoSnapshot | null {
  return activeZoneCryptoSnapshot;
}

export function setActiveZoneCryptoSnapshot(state: ZoneCryptoSnapshot): void {
  activeZoneCryptoSnapshot = state;
}

export function clearActiveZoneCryptoSnapshot(): void {
  activeZoneCryptoSnapshot = null;
}

@Injectable()
export class ZoneCryptoService {
  get(): ZoneCryptoSnapshot | null {
    return getActiveZoneCryptoSnapshot();
  }

  set(state: ZoneCryptoSnapshot): void {
    setActiveZoneCryptoSnapshot(state);
  }

  clear(): void {
    clearActiveZoneCryptoSnapshot();
  }
}
