import { Test, TestingModule } from '@nestjs/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import { KEY_SIZE } from '../auth-dh.types';
import {
  ZoneCryptoService,
  ZoneCryptoSnapshot,
  clearActiveZoneCryptoSnapshot,
  zoneCryptoFromCacheBlob,
  zoneCryptoToCacheBlob,
} from '../zone-crypto.service';

function sampleState(enrolledAt = 1_730_000_000_000): ZoneCryptoSnapshot {
  return {
    zonePriv: Buffer.from(Array.from({ length: KEY_SIZE }, (_, b) => b)),
    zonePub: Buffer.from(Array.from({ length: KEY_SIZE }, (_, b) => (b + 1) % 256)),
    hubPub: Buffer.from(Array.from({ length: KEY_SIZE }, (_, b) => (b + 2) % 256)),
    enrolledAt,
  };
}

describe('zone-crypto cache blob serialisation', () => {
  it('produces canonical JSON: lex-sorted keys, no whitespace, hex-encoded keys, integer enrolled_at', () => {
    const state = sampleState();
    const blob = zoneCryptoToCacheBlob(state);
    expect(Buffer.isBuffer(blob)).toBe(true);

    const text = blob.toString('utf-8');
    expect(text.startsWith('{"enrolled_at":')).toBe(true);
    expect(text).not.toContain(' ');
    expect(text).not.toContain(', ');
    expect(text).toContain(`"zone_priv":"${state.zonePriv.toString('hex')}"`);
    expect(text).toContain(`"zone_pub":"${state.zonePub.toString('hex')}"`);
    expect(text).toContain(`"hub_pub":"${state.hubPub.toString('hex')}"`);
  });

  it('keys appear in lex-sorted order', () => {
    const state = sampleState();
    const text = zoneCryptoToCacheBlob(state).toString('utf-8');

    const fields = ['enrolled_at', 'hub_pub', 'zone_priv', 'zone_pub'] as const;
    const positions = Object.fromEntries(fields.map((f) => [f, text.indexOf(`"${f}":`)]));
    expect(positions.enrolled_at).toBeLessThan(positions.hub_pub);
    expect(positions.hub_pub).toBeLessThan(positions.zone_priv);
    expect(positions.zone_priv).toBeLessThan(positions.zone_pub);
  });

  it('is byte-deterministic across encodings of the same state', () => {
    const state = sampleState();
    expect(zoneCryptoToCacheBlob(state).equals(zoneCryptoToCacheBlob(state))).toBe(true);
  });
});

describe('zone-crypto cache blob parsing', () => {
  it('round-trip recovers state', () => {
    const state = sampleState();
    const recovered = zoneCryptoFromCacheBlob(zoneCryptoToCacheBlob(state));
    expect(recovered.zonePriv.equals(state.zonePriv)).toBe(true);
    expect(recovered.zonePub.equals(state.zonePub)).toBe(true);
    expect(recovered.hubPub.equals(state.hubPub)).toBe(true);
    expect(recovered.enrolledAt).toBe(state.enrolledAt);
  });

  it('rejects non-JSON input', () => {
    expect(() => zoneCryptoFromCacheBlob(Buffer.from('not json'))).toThrow(/not valid JSON/);
  });

  it('rejects a JSON array (non-object root)', () => {
    expect(() => zoneCryptoFromCacheBlob(Buffer.from('["array", "not", "object"]'))).toThrow(/must be a JSON object/);
  });

  it.each(['zone_priv', 'zone_pub', 'hub_pub', 'enrolled_at'])('rejects payload missing field %s', (missingField) => {
    const payload = JSON.parse(zoneCryptoToCacheBlob(sampleState()).toString('utf-8'));
    delete payload[missingField];
    expect(() => zoneCryptoFromCacheBlob(Buffer.from(JSON.stringify(payload), 'utf-8'))).toThrow();
  });

  it.each(['zone_priv', 'zone_pub', 'hub_pub'])('rejects non-string %s with "must be a hex string"', (keyField) => {
    const payload = JSON.parse(zoneCryptoToCacheBlob(sampleState()).toString('utf-8'));
    payload[keyField] = 123;
    expect(() => zoneCryptoFromCacheBlob(Buffer.from(JSON.stringify(payload), 'utf-8'))).toThrow(
      new RegExp(`${keyField} must be a hex string`),
    );
  });

  it.each(['zone_priv', 'zone_pub', 'hub_pub'])('rejects invalid hex in %s with "is not valid hex"', (keyField) => {
    const payload = JSON.parse(zoneCryptoToCacheBlob(sampleState()).toString('utf-8'));
    payload[keyField] = 'not-hex-zz';
    expect(() => zoneCryptoFromCacheBlob(Buffer.from(JSON.stringify(payload), 'utf-8'))).toThrow(
      new RegExp(`${keyField} is not valid hex`),
    );
  });

  it.each(['zone_priv', 'zone_pub', 'hub_pub'])('rejects %s of wrong length (16 bytes instead of 32)', (keyField) => {
    const payload = JSON.parse(zoneCryptoToCacheBlob(sampleState()).toString('utf-8'));
    payload[keyField] = '00'.repeat(16);
    expect(() => zoneCryptoFromCacheBlob(Buffer.from(JSON.stringify(payload), 'utf-8'))).toThrow(
      new RegExp(`${keyField} must be ${KEY_SIZE} bytes`),
    );
  });

  it('rejects string enrolled_at', () => {
    const payload = JSON.parse(zoneCryptoToCacheBlob(sampleState()).toString('utf-8'));
    payload.enrolled_at = '1730000000000';
    expect(() => zoneCryptoFromCacheBlob(Buffer.from(JSON.stringify(payload), 'utf-8'))).toThrow(
      /enrolled_at must be int/,
    );
  });

  it('rejects bool enrolled_at', () => {
    const payload = JSON.parse(zoneCryptoToCacheBlob(sampleState()).toString('utf-8'));
    payload.enrolled_at = true;
    expect(() => zoneCryptoFromCacheBlob(Buffer.from(JSON.stringify(payload), 'utf-8'))).toThrow(
      /enrolled_at must be int/,
    );
  });
});

describe('ZoneCryptoService holder accessors', () => {
  let service: ZoneCryptoService;

  beforeEach(async () => {
    clearActiveZoneCryptoSnapshot();
    const module: TestingModule = await Test.createTestingModule({
      providers: [ZoneCryptoService],
    }).compile();
    service = module.get(ZoneCryptoService);
  });

  it('get returns null initially', () => {
    expect(service.get()).toBeNull();
  });

  it('set then get returns the same state', () => {
    const state = sampleState();
    service.set(state);
    expect(service.get()).toBe(state);
  });

  it('set is idempotent on reassignment (last write wins)', () => {
    const first = sampleState(1);
    const second = sampleState(2);
    service.set(first);
    service.set(second);
    expect(service.get()).toBe(second);
  });

  it('clear resets the holder to null', () => {
    service.set(sampleState());
    expect(service.get()).not.toBeNull();
    service.clear();
    expect(service.get()).toBeNull();
  });
});
