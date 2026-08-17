import { createPublicKey, generateKeyPairSync } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { SealOpenError } from '../../zone-crypto/auth-dh.types.js';
import { REASON_SEAL_FAILED } from '../../zone-crypto/sealed-envelope.types.js';
import {
  DIRECTION_BRIDGE_TO_HUB,
  sealBridgeToHub,
  sealOutboundPayload,
  type SealedAad,
  type ZoneCryptoState,
} from '../seal-outbound-payload.js';

const KEY_SIZE = 32;
const ZONE_ID = '00000000-0000-4000-8000-000000000001';

interface Keypair {
  priv: Buffer;
  pub: Buffer;
}

function genKeypair(): Keypair {
  const kp = generateKeyPairSync('x25519');
  const pkcs8 = kp.privateKey.export({ format: 'der', type: 'pkcs8' });
  const spki = createPublicKey(kp.privateKey).export({ format: 'der', type: 'spki' });
  return {
    priv: Buffer.from(pkcs8.subarray(pkcs8.length - KEY_SIZE)),
    pub: Buffer.from(spki.subarray(spki.length - KEY_SIZE)),
  };
}

function makeAad(): SealedAad {
  return {
    aad_v: 1,
    zone_id: ZONE_ID,
    queue_name: 'lifecycle',
    direction: DIRECTION_BRIDGE_TO_HUB,
    job_id: 'plan-abc123',
    created_at: Date.now(),
  };
}

describe('seal-outbound-payload sealBridgeToHub', () => {
  it('returns a well-formed envelope on success', () => {
    const hub = genKeypair();
    const zone = genKeypair();
    const state: ZoneCryptoState = { zonePriv: zone.priv, hubPub: hub.pub, zoneId: ZONE_ID };
    const env = sealBridgeToHub(Buffer.from('{"hello":"world"}', 'utf-8'), makeAad(), state);
    expect(env.envelope_v).toBe(1);
    expect(env.aad.direction).toBe(DIRECTION_BRIDGE_TO_HUB);
    for (const field of ['eph_pub', 'ciphertext', 'tag'] as const) {
      expect(typeof env[field]).toBe('string');
    }
  });

  it('re-wraps a crypto seal failure into the bridge SealOpenError with seal labels', () => {
    const hub = genKeypair();
    const zone = genKeypair();
    const aad = makeAad();
    const state: ZoneCryptoState = { zonePriv: zone.priv, hubPub: hub.pub.subarray(0, 16), zoneId: ZONE_ID };
    try {
      sealBridgeToHub(Buffer.from('payload', 'utf-8'), aad, state);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(SealOpenError);
      expect((err as SealOpenError).reason).toBe(REASON_SEAL_FAILED);
      expect((err as SealOpenError).direction).toBe(DIRECTION_BRIDGE_TO_HUB);
      expect((err as SealOpenError).zoneId).toBe(ZONE_ID);
      expect((err as SealOpenError).jobId).toBe('plan-abc123');
    }
  });

  it('propagates the re-wrapped error through sealOutboundPayload', () => {
    const hub = genKeypair();
    const zone = genKeypair();
    const state: ZoneCryptoState = { zonePriv: zone.priv, hubPub: hub.pub.subarray(0, 16), zoneId: ZONE_ID };
    expect(() =>
      sealOutboundPayload(
        { foo: 'bar' },
        { queueName: 'lifecycle', aadJobId: 'plan-abc123', nowMs: Date.now(), zoneCrypto: state },
      ),
    ).toThrow(SealOpenError);
  });

  it('passes through unsealed when zoneCrypto is null', () => {
    const payload = { foo: 'bar' };
    const out = sealOutboundPayload(payload, { queueName: 'lifecycle', aadJobId: 'j', zoneCrypto: null });
    expect(out).toBe(payload);
  });
});
