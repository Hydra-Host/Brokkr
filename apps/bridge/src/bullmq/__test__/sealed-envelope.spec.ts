import { createPublicKey, generateKeyPairSync } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { canonicalizeAad, seal as cryptoSeal } from '@repo/crypto';

import { SealKeyUnknownError, SealOpenError } from '../../zone-crypto/auth-dh.types.js';
import { ZoneCryptoService, type ZoneCryptoSnapshot } from '../../zone-crypto/zone-crypto.service.js';
import {
  CURRENT_AAD_VERSION,
  CURRENT_ENVELOPE_VERSION,
  DIRECTION_BRIDGE_TO_HUB,
  DIRECTION_HUB_TO_BRIDGE,
  FRESHNESS_WINDOW_MS,
  REASON_FUTURE_SKEW,
  REASON_KEY_UNKNOWN,
  REASON_MALFORMED_ENVELOPE,
  REASON_ROUTING_MISMATCH,
  REASON_SEAL_FAILED,
  REASON_STALE,
  REASON_TAMPER,
  SealedEnvelopeService,
  SKEW_TOLERANCE_MS,
  type Envelope,
  type ExpectedRouting,
} from '../sealed-envelope.js';

const KEY_SIZE = 32;
const ZONE_ID = '00000000-0000-4000-8000-000000000001';
const QUEUE_NAME = 'lifecycle';
const EXPECTED_ROUTING: ExpectedRouting = { zoneId: ZONE_ID, queueName: QUEUE_NAME };

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

function makeAad(
  overrides: Partial<{
    zoneId: string;
    queueName: string;
    direction: string;
    jobId: string;
    createdAt: number;
  }> = {},
): Record<string, unknown> {
  return {
    aad_v: CURRENT_AAD_VERSION,
    zone_id: overrides.zoneId ?? ZONE_ID,
    queue_name: overrides.queueName ?? QUEUE_NAME,
    direction: overrides.direction ?? DIRECTION_HUB_TO_BRIDGE,
    job_id: overrides.jobId ?? 'plan-abc123',
    created_at: overrides.createdAt ?? Date.now(),
  };
}

function buildHubToBridgeEnvelope(
  hub: Keypair,
  zone: Keypair,
  plaintext: Buffer,
  aadFields: Record<string, unknown>,
): Envelope {
  const aadBytes = canonicalizeAad(aadFields);
  const sealed = cryptoSeal(hub.priv, zone.pub, plaintext, aadBytes);
  return {
    envelope_v: CURRENT_ENVELOPE_VERSION,
    aad: { ...aadFields },
    eph_pub: sealed.ephPub.toString('base64'),
    ciphertext: sealed.ciphertext.toString('base64'),
    tag: sealed.tag.toString('base64'),
  };
}

interface Fixtures {
  hub: Keypair;
  zone: Keypair;
  zoneCrypto: ZoneCryptoService;
  service: SealedEnvelopeService;
}

function setupActivated(): Fixtures {
  const hub = genKeypair();
  const zone = genKeypair();
  const snapshot: ZoneCryptoSnapshot = {
    zonePriv: zone.priv,
    zonePub: zone.pub,
    hubPub: hub.pub,
    enrolledAt: 1_730_000_000_000,
  };
  const zoneCrypto = new ZoneCryptoService();
  zoneCrypto.set(snapshot);
  const service = new SealedEnvelopeService(zoneCrypto);
  return { hub, zone, zoneCrypto, service };
}

describe('bullmq/sealed-envelope re-export surface', () => {
  it('exposes constants from the zone-crypto module', () => {
    expect(CURRENT_AAD_VERSION).toBe(1);
    expect(CURRENT_ENVELOPE_VERSION).toBe(1);
    expect(DIRECTION_BRIDGE_TO_HUB).toBe('bridge_to_hub');
    expect(DIRECTION_HUB_TO_BRIDGE).toBe('hub_to_bridge');
    expect(typeof FRESHNESS_WINDOW_MS).toBe('number');
    expect(typeof SKEW_TOLERANCE_MS).toBe('number');
  });

  it('exposes the service class', () => {
    const zoneCrypto = new ZoneCryptoService();
    const service = new SealedEnvelopeService(zoneCrypto);
    expect(service.openHubToBridge).toBeTypeOf('function');
    expect(service.sealBridgeToHub).toBeTypeOf('function');
  });
});

describe('sealBridgeToHub via SealedEnvelopeService', () => {
  let fx: Fixtures;
  beforeEach(() => {
    fx = setupActivated();
  });
  afterEach(() => {
    fx.zoneCrypto.clear();
  });

  it('returns a well-formed envelope', () => {
    const aad = makeAad({ direction: DIRECTION_BRIDGE_TO_HUB });
    const env = fx.service.sealBridgeToHub(Buffer.from('{"hello":"world"}', 'utf-8'), aad);
    expect(env.envelope_v).toBe(1);
    expect(env.aad).toEqual(aad);
    for (const field of ['eph_pub', 'ciphertext', 'tag'] as const) {
      expect(typeof env[field]).toBe('string');
      expect(Buffer.from(env[field], 'base64').length).toBeGreaterThanOrEqual(0);
    }
  });

  it('each call produces a fresh ephemeral', () => {
    const aad = makeAad({ direction: DIRECTION_BRIDGE_TO_HUB });
    const payload = Buffer.from('fresh-ephemeral-test-plaintext', 'utf-8');
    const e1 = fx.service.sealBridgeToHub(payload, aad);
    const e2 = fx.service.sealBridgeToHub(payload, aad);
    expect(e1.eph_pub).not.toBe(e2.eph_pub);
    expect(e1.ciphertext).not.toBe(e2.ciphertext);
    expect(e1.tag).not.toBe(e2.tag);
  });

  it('aad is defensively copied', () => {
    const aad = makeAad({ direction: DIRECTION_BRIDGE_TO_HUB });
    const env = fx.service.sealBridgeToHub(Buffer.from('payload', 'utf-8'), aad);
    const originalZone = aad.zone_id;
    aad.zone_id = 'TAMPERED';
    expect(env.aad.zone_id).toBe(originalZone);
  });

  it('raises SealKeyUnknownError when holder cleared', () => {
    fx.zoneCrypto.clear();
    expect(() =>
      fx.service.sealBridgeToHub(Buffer.from('payload', 'utf-8'), makeAad({ direction: DIRECTION_BRIDGE_TO_HUB })),
    ).toThrow(SealKeyUnknownError);
  });

  it('propagates errors for invalid AAD direction', () => {
    expect(() =>
      fx.service.sealBridgeToHub(Buffer.from('payload', 'utf-8'), makeAad({ direction: 'sideways' })),
    ).toThrow();
  });

  it('re-wraps a crypto seal failure into the bridge SealOpenError with seal labels', () => {
    const zoneCrypto = new ZoneCryptoService();
    zoneCrypto.set({
      zonePriv: fx.zone.priv,
      zonePub: fx.zone.pub,
      hubPub: fx.hub.pub.subarray(0, 16),
      enrolledAt: 1_730_000_000_000,
    });
    const service = new SealedEnvelopeService(zoneCrypto);
    const aad = makeAad({ direction: DIRECTION_BRIDGE_TO_HUB });
    try {
      service.sealBridgeToHub(Buffer.from('payload', 'utf-8'), aad);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(SealOpenError);
      expect((err as SealOpenError).reason).toBe(REASON_SEAL_FAILED);
      expect((err as SealOpenError).direction).toBe(DIRECTION_BRIDGE_TO_HUB);
      expect((err as SealOpenError).zoneId).toBe(ZONE_ID);
    } finally {
      zoneCrypto.clear();
    }
  });
});

describe('openHubToBridge via SealedEnvelopeService', () => {
  let fx: Fixtures;
  beforeEach(() => {
    fx = setupActivated();
  });
  afterEach(() => {
    fx.zoneCrypto.clear();
  });

  it('round trip succeeds', () => {
    const plaintext = Buffer.from('{"saga_name":"provision"}', 'utf-8');
    const env = buildHubToBridgeEnvelope(fx.hub, fx.zone, plaintext, makeAad());
    const recovered = fx.service.openHubToBridge(env, EXPECTED_ROUTING);
    expect(recovered.equals(plaintext)).toBe(true);
  });

  it('rejects zone_id mismatch', () => {
    const env = buildHubToBridgeEnvelope(
      fx.hub,
      fx.zone,
      Buffer.from('x'),
      makeAad({ zoneId: '00000000-0000-4000-8000-000000000099' }),
    );
    try {
      fx.service.openHubToBridge(env, EXPECTED_ROUTING);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(SealOpenError);
      expect((err as SealOpenError).reason).toBe(REASON_ROUTING_MISMATCH);
    }
  });

  it('rejects queue_name mismatch', () => {
    const env = buildHubToBridgeEnvelope(fx.hub, fx.zone, Buffer.from('x'), makeAad({ queueName: 'collection' }));
    try {
      fx.service.openHubToBridge(env, EXPECTED_ROUTING);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(SealOpenError);
      expect((err as SealOpenError).reason).toBe(REASON_ROUTING_MISMATCH);
    }
  });

  it('rejects direction mismatch (bridge_to_hub delivered to inbound)', () => {
    const env = buildHubToBridgeEnvelope(
      fx.hub,
      fx.zone,
      Buffer.from('x'),
      makeAad({ direction: DIRECTION_BRIDGE_TO_HUB }),
    );
    try {
      fx.service.openHubToBridge(env, EXPECTED_ROUTING);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(SealOpenError);
      expect((err as SealOpenError).reason).toBe(REASON_ROUTING_MISMATCH);
    }
  });

  it('rejects stale envelopes', () => {
    const env = buildHubToBridgeEnvelope(fx.hub, fx.zone, Buffer.from('x'), makeAad({ createdAt: 1_000_000 }));
    try {
      fx.service.openHubToBridge(env, EXPECTED_ROUTING, {
        nowMs: 1_000_000 + FRESHNESS_WINDOW_MS + 1,
      });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(SealOpenError);
      expect((err as SealOpenError).reason).toBe(REASON_STALE);
    }
  });

  it('rejects future-skew envelopes', () => {
    const env = buildHubToBridgeEnvelope(fx.hub, fx.zone, Buffer.from('x'), makeAad({ createdAt: 2_000_000 }));
    try {
      fx.service.openHubToBridge(env, EXPECTED_ROUTING, {
        nowMs: 2_000_000 - SKEW_TOLERANCE_MS - 1,
      });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(SealOpenError);
      expect((err as SealOpenError).reason).toBe(REASON_FUTURE_SKEW);
    }
  });

  it('accepts at the lookback boundary', () => {
    const env = buildHubToBridgeEnvelope(fx.hub, fx.zone, Buffer.from('x'), makeAad({ createdAt: 1_000_000 }));
    const recovered = fx.service.openHubToBridge(env, EXPECTED_ROUTING, {
      nowMs: 1_000_000 + FRESHNESS_WINDOW_MS,
    });
    expect(recovered.equals(Buffer.from('x'))).toBe(true);
  });

  it('accepts at the skew boundary', () => {
    const env = buildHubToBridgeEnvelope(fx.hub, fx.zone, Buffer.from('x'), makeAad({ createdAt: 2_000_000 }));
    const recovered = fx.service.openHubToBridge(env, EXPECTED_ROUTING, {
      nowMs: 2_000_000 - SKEW_TOLERANCE_MS,
    });
    expect(recovered.equals(Buffer.from('x'))).toBe(true);
  });

  it('detects AAD tamper via the GCM tag', () => {
    const env = buildHubToBridgeEnvelope(fx.hub, fx.zone, Buffer.from('x'), makeAad());
    (env.aad as Record<string, unknown>).job_id = 'different-job';
    try {
      fx.service.openHubToBridge(env, EXPECTED_ROUTING);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(SealOpenError);
      expect((err as SealOpenError).reason).toBe(REASON_TAMPER);
    }
  });

  it('raises SealKeyUnknownError when holder is cleared', () => {
    const env = buildHubToBridgeEnvelope(fx.hub, fx.zone, Buffer.from('x'), makeAad());
    fx.zoneCrypto.clear();
    try {
      fx.service.openHubToBridge(env, EXPECTED_ROUTING);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(SealKeyUnknownError);
      expect((err as SealKeyUnknownError).reason).toBe(REASON_KEY_UNKNOWN);
    }
  });

  it('rejects unsupported envelope_v as malformed_envelope', () => {
    const bad: Record<string, unknown> = {
      envelope_v: 2,
      aad: makeAad(),
      eph_pub: 'AA',
      ciphertext: 'AA',
      tag: 'AA',
    };
    try {
      fx.service.openHubToBridge(bad, EXPECTED_ROUTING);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(SealOpenError);
      expect((err as SealOpenError).reason).toBe(REASON_MALFORMED_ENVELOPE);
    }
  });

  it('rejects missing fields as malformed_envelope', () => {
    const bad: Record<string, unknown> = {
      envelope_v: 1,
      aad: makeAad(),
      eph_pub: 'AA',
      tag: 'AA',
    };
    try {
      fx.service.openHubToBridge(bad, EXPECTED_ROUTING);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(SealOpenError);
      expect((err as SealOpenError).reason).toBe(REASON_MALFORMED_ENVELOPE);
    }
  });

  it('rejects non-dict aad as malformed_envelope', () => {
    const bad: Record<string, unknown> = {
      envelope_v: 1,
      aad: 'not a dict',
      eph_pub: 'AA',
      ciphertext: 'AA',
      tag: 'AA',
    };
    try {
      fx.service.openHubToBridge(bad, EXPECTED_ROUTING);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(SealOpenError);
      expect((err as SealOpenError).reason).toBe(REASON_MALFORMED_ENVELOPE);
    }
  });

  it('rejects non-dict envelope as malformed_envelope', () => {
    try {
      fx.service.openHubToBridge('not a dict', EXPECTED_ROUTING);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(SealOpenError);
      expect((err as SealOpenError).reason).toBe(REASON_MALFORMED_ENVELOPE);
    }
  });

  it('rejects bad base64 as malformed_envelope', () => {
    const env = buildHubToBridgeEnvelope(fx.hub, fx.zone, Buffer.from('x'), makeAad());
    env.eph_pub = 'not!!!base64';
    try {
      fx.service.openHubToBridge(env, EXPECTED_ROUTING);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(SealOpenError);
      expect((err as SealOpenError).reason).toBe(REASON_MALFORMED_ENVELOPE);
    }
  });

  it('rejects extra aad fields via canonicalisation failure', () => {
    const env = buildHubToBridgeEnvelope(fx.hub, fx.zone, Buffer.from('x'), makeAad());
    (env.aad as Record<string, unknown>).evil = 'extra';
    try {
      fx.service.openHubToBridge(env, EXPECTED_ROUTING);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(SealOpenError);
      expect((err as SealOpenError).reason).toBe(REASON_MALFORMED_ENVELOPE);
    }
  });

  it('rejects missing aad.created_at as malformed_envelope', () => {
    const env = buildHubToBridgeEnvelope(fx.hub, fx.zone, Buffer.from('x'), makeAad());
    delete (env.aad as Record<string, unknown>).created_at;
    try {
      fx.service.openHubToBridge(env, EXPECTED_ROUTING);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(SealOpenError);
      expect((err as SealOpenError).reason).toBe(REASON_MALFORMED_ENVELOPE);
    }
  });
});

describe('envelope shape parity gates', () => {
  let fx: Fixtures;
  beforeEach(() => {
    fx = setupActivated();
  });
  afterEach(() => {
    fx.zoneCrypto.clear();
  });

  const REQUIRED_TOP_LEVEL_KEYS = new Set(['envelope_v', 'aad', 'eph_pub', 'ciphertext', 'tag']);
  const REQUIRED_AAD_KEYS = new Set(['aad_v', 'zone_id', 'queue_name', 'direction', 'job_id', 'created_at']);

  it('sealed output has exactly the required top-level keys', () => {
    const env = fx.service.sealBridgeToHub(
      Buffer.from('{"hello":"world"}', 'utf-8'),
      makeAad({ direction: DIRECTION_BRIDGE_TO_HUB }),
    );
    expect(new Set(Object.keys(env))).toEqual(REQUIRED_TOP_LEVEL_KEYS);
  });

  it('sealed output aad has exactly the required fields', () => {
    const env = fx.service.sealBridgeToHub(Buffer.from('x'), makeAad({ direction: DIRECTION_BRIDGE_TO_HUB }));
    expect(new Set(Object.keys(env.aad))).toEqual(REQUIRED_AAD_KEYS);
  });

  it('sealed output byte lengths are correct', () => {
    const plaintext = Buffer.alloc(137, 'a'.charCodeAt(0));
    const env = fx.service.sealBridgeToHub(plaintext, makeAad({ direction: DIRECTION_BRIDGE_TO_HUB }));
    expect(Buffer.from(env.eph_pub, 'base64').length).toBe(32);
    expect(Buffer.from(env.tag, 'base64').length).toBe(16);
    expect(Buffer.from(env.ciphertext, 'base64').length).toBe(plaintext.length);
  });

  it('empty plaintext yields empty ciphertext + 16-byte tag', () => {
    const env = fx.service.sealBridgeToHub(Buffer.alloc(0), makeAad({ direction: DIRECTION_BRIDGE_TO_HUB }));
    expect(Buffer.from(env.ciphertext, 'base64').length).toBe(0);
    expect(Buffer.from(env.tag, 'base64').length).toBe(16);
  });

  it('envelope_v is pinned to 1', () => {
    const env = fx.service.sealBridgeToHub(Buffer.from('x'), makeAad({ direction: DIRECTION_BRIDGE_TO_HUB }));
    expect(env.envelope_v).toBe(1);
  });

  it('aad.aad_v is pinned to 1', () => {
    const env = fx.service.sealBridgeToHub(Buffer.from('x'), makeAad({ direction: DIRECTION_BRIDGE_TO_HUB }));
    expect(env.aad.aad_v).toBe(1);
  });
});
