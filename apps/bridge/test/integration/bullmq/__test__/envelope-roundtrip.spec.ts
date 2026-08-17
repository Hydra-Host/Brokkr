import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { canonicalizeAad, open as cryptoOpen, seal as cryptoSeal } from '@repo/crypto';
import { createPublicKey, generateKeyPairSync } from 'node:crypto';

import { SealKeyUnknownError, SealOpenError } from '../../../../src/zone-crypto/auth-dh.types';
import { SealedEnvelopeService } from '../../../../src/zone-crypto/sealed-envelope.service';
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
  REASON_STALE,
  REASON_TAMPER,
  SKEW_TOLERANCE_MS,
  type Envelope,
  type ExpectedRouting,
} from '../../../../src/zone-crypto/sealed-envelope.types';
import { ZoneCryptoService, type ZoneCryptoSnapshot } from '../../../../src/zone-crypto/zone-crypto.service';

const KEY_SIZE = 32;

const ZONE_ID = '00000000-0000-4000-8000-000000000001';
const ZONE_PREFIX = 'zone-test-1';
const LIFECYCLE_QUEUE_NAME = 'lifecycle';
const RESULTS_QUEUE_NAME = 'inbox';
const RESULTS_PREFIX = 'results';
const LIFECYCLE_WAIT_KEY = `${ZONE_PREFIX}:${LIFECYCLE_QUEUE_NAME}:wait`;
const RESULTS_WAIT_KEY = `${RESULTS_PREFIX}:${RESULTS_QUEUE_NAME}:wait`;

interface Keypair {
  priv: Buffer;
  pub: Buffer;
}

function rawPrivFromKeyObject(priv: ReturnType<typeof generateKeyPairSync>['privateKey']): Buffer {
  const der = priv.export({ format: 'der', type: 'pkcs8' });
  return Buffer.from(der.subarray(der.length - KEY_SIZE));
}

function rawPubFromKeyObject(pub: ReturnType<typeof generateKeyPairSync>['publicKey']): Buffer {
  const der = pub.export({ format: 'der', type: 'spki' });
  return Buffer.from(der.subarray(der.length - KEY_SIZE));
}

function generateKeypair(): Keypair {
  const kp = generateKeyPairSync('x25519');
  const priv = rawPrivFromKeyObject(kp.privateKey);
  const pub = rawPubFromKeyObject(createPublicKey(kp.privateKey));
  return { priv, pub };
}

class FakeRedisLists {
  private readonly store = new Map<string, string[]>();

  async rpush(key: string, value: string): Promise<void> {
    const list = this.store.get(key) ?? [];
    list.push(value);
    this.store.set(key, list);
  }

  async lpop(key: string): Promise<string | null> {
    const list = this.store.get(key);
    if (list === undefined || list.length === 0) return null;
    return list.shift() ?? null;
  }

  async llen(key: string): Promise<number> {
    return this.store.get(key)?.length ?? 0;
  }

  async exists(key: string): Promise<number> {
    const list = this.store.get(key);
    return list !== undefined && list.length > 0 ? 1 : 0;
  }

  async flushall(): Promise<void> {
    this.store.clear();
  }
}

interface HubSealArgs {
  hubPriv: Buffer;
  zonePub: Buffer;
  plaintext: Buffer;
  aadFields: Record<string, unknown>;
}

function hubSealEnvelope({ hubPriv, zonePub, plaintext, aadFields }: HubSealArgs): Envelope {
  const aadBytes = canonicalizeAad(aadFields);
  const sealed = cryptoSeal(hubPriv, zonePub, plaintext, aadBytes);
  return {
    envelope_v: CURRENT_ENVELOPE_VERSION,
    aad: { ...aadFields },
    eph_pub: sealed.ephPub.toString('base64'),
    ciphertext: sealed.ciphertext.toString('base64'),
    tag: sealed.tag.toString('base64'),
  };
}

interface HubOpenArgs {
  hubPriv: Buffer;
  zonePub: Buffer;
  envelope: Record<string, unknown>;
}

function hubOpenEnvelope({ hubPriv, zonePub, envelope }: HubOpenArgs): Buffer {
  const aadBytes = canonicalizeAad(envelope.aad);
  const ephPub = Buffer.from(envelope.eph_pub as string, 'base64');
  const ciphertext = Buffer.from(envelope.ciphertext as string, 'base64');
  const tag = Buffer.from(envelope.tag as string, 'base64');
  return cryptoOpen(hubPriv, zonePub, ephPub, ciphertext, tag, aadBytes);
}

interface AadOverrides {
  jobId: string;
  queueName?: string;
  zoneId?: string;
  createdAt?: number;
}

function makeHubToBridgeAad({
  jobId,
  queueName = LIFECYCLE_QUEUE_NAME,
  zoneId = ZONE_ID,
  createdAt,
}: AadOverrides): Record<string, unknown> {
  return {
    aad_v: CURRENT_AAD_VERSION,
    zone_id: zoneId,
    queue_name: queueName,
    direction: DIRECTION_HUB_TO_BRIDGE,
    job_id: jobId,
    created_at: createdAt ?? Date.now(),
  };
}

function makeBridgeToHubAad({
  jobId,
  queueName = RESULTS_QUEUE_NAME,
  zoneId = ZONE_ID,
  createdAt,
}: AadOverrides): Record<string, unknown> {
  return {
    aad_v: CURRENT_AAD_VERSION,
    zone_id: zoneId,
    queue_name: queueName,
    direction: DIRECTION_BRIDGE_TO_HUB,
    job_id: jobId,
    created_at: createdAt ?? Date.now(),
  };
}

async function hubEnqueue(redis: FakeRedisLists, queueKey: string, envelope: object): Promise<void> {
  await redis.rpush(queueKey, JSON.stringify(envelope));
}

async function hubConsume(redis: FakeRedisLists, queueKey: string): Promise<Record<string, unknown> | null> {
  const raw = await redis.lpop(queueKey);
  return raw === null ? null : JSON.parse(raw);
}

async function bridgeEnqueue(redis: FakeRedisLists, queueKey: string, envelope: object): Promise<void> {
  await redis.rpush(queueKey, JSON.stringify(envelope));
}

async function bridgeConsume(redis: FakeRedisLists, queueKey: string): Promise<Record<string, unknown> | null> {
  const raw = await redis.lpop(queueKey);
  return raw === null ? null : JSON.parse(raw);
}

interface Fixtures {
  redis: FakeRedisLists;
  hub: Keypair;
  zone: Keypair;
  zoneCrypto: ZoneCryptoService;
  service: SealedEnvelopeService;
}

function setupFixtures(): Fixtures {
  const hub = generateKeypair();
  const zone = generateKeypair();
  const snapshot: ZoneCryptoSnapshot = {
    zonePriv: zone.priv,
    zonePub: zone.pub,
    hubPub: hub.pub,
    enrolledAt: 1_730_000_000_000,
  };
  const zoneCrypto = new ZoneCryptoService();
  zoneCrypto.set(snapshot);
  const service = new SealedEnvelopeService(zoneCrypto);
  return { redis: new FakeRedisLists(), hub, zone, zoneCrypto, service };
}

describe('integration/bullmq: envelope round-trip', () => {
  let fx: Fixtures;

  beforeEach(() => {
    fx = setupFixtures();
  });

  afterEach(async () => {
    await fx.redis.flushall();
    fx.zoneCrypto.clear();
  });

  describe('TestEnvelopeRoundTrip', () => {
    it('hub_to_bridge envelope round trips byte identically', async () => {
      const plaintext = Buffer.from('{"saga_name":"provision","payload":{"device_id":42}}', 'utf-8');
      const aadFields = makeHubToBridgeAad({ jobId: 'plan-abc' });

      const envelope = hubSealEnvelope({
        hubPriv: fx.hub.priv,
        zonePub: fx.zone.pub,
        plaintext,
        aadFields,
      });

      await hubEnqueue(fx.redis, LIFECYCLE_WAIT_KEY, envelope);
      const consumed = await bridgeConsume(fx.redis, LIFECYCLE_WAIT_KEY);

      expect(consumed).toEqual(envelope);

      const routing: ExpectedRouting = { zoneId: ZONE_ID, queueName: LIFECYCLE_QUEUE_NAME };
      const recovered = fx.service.openHubToBridge(consumed, routing);
      expect(recovered.equals(plaintext)).toBe(true);
    });

    it('bridge_to_hub envelope round trips byte identically', async () => {
      const plaintextPayload = { plan_id: 'plan-abc', step_name: 'deploy_os', status: 'completed' };
      const aadFields = makeBridgeToHubAad({ jobId: 'plan-abc' });

      const envelope = fx.service.sealBridgeToHub(Buffer.from(JSON.stringify(plaintextPayload), 'utf-8'), aadFields);

      await bridgeEnqueue(fx.redis, RESULTS_WAIT_KEY, envelope);
      const consumed = await hubConsume(fx.redis, RESULTS_WAIT_KEY);

      expect(consumed).toEqual(envelope);

      const recoveredBytes = hubOpenEnvelope({
        hubPriv: fx.hub.priv,
        zonePub: fx.zone.pub,
        envelope: consumed as Record<string, unknown>,
      });
      expect(JSON.parse(recoveredBytes.toString('utf-8'))).toEqual(plaintextPayload);
    });

    it('full loop: hub request, bridge response', async () => {
      const requestPlaintext = Buffer.from(JSON.stringify({ plan_id: 'plan-1', saga_name: 'provision' }), 'utf-8');
      const requestAad = makeHubToBridgeAad({ jobId: 'plan-1' });
      const requestEnvelope = hubSealEnvelope({
        hubPriv: fx.hub.priv,
        zonePub: fx.zone.pub,
        plaintext: requestPlaintext,
        aadFields: requestAad,
      });
      await hubEnqueue(fx.redis, LIFECYCLE_WAIT_KEY, requestEnvelope);

      const consumedRequest = await bridgeConsume(fx.redis, LIFECYCLE_WAIT_KEY);
      expect(consumedRequest).not.toBeNull();
      const routing: ExpectedRouting = { zoneId: ZONE_ID, queueName: LIFECYCLE_QUEUE_NAME };
      const openedRequest = fx.service.openHubToBridge(consumedRequest, routing);
      expect(JSON.parse(openedRequest.toString('utf-8')).plan_id).toBe('plan-1');

      const resultPayload = { plan_id: 'plan-1', step_name: 'deploy_os', status: 'completed' };
      const resultAad = makeBridgeToHubAad({ jobId: 'plan-1' });
      const resultEnvelope = fx.service.sealBridgeToHub(Buffer.from(JSON.stringify(resultPayload), 'utf-8'), resultAad);
      await bridgeEnqueue(fx.redis, RESULTS_WAIT_KEY, resultEnvelope);

      const consumedResult = await hubConsume(fx.redis, RESULTS_WAIT_KEY);
      expect(consumedResult).not.toBeNull();
      const recoveredResult = hubOpenEnvelope({
        hubPriv: fx.hub.priv,
        zonePub: fx.zone.pub,
        envelope: consumedResult as Record<string, unknown>,
      });
      expect(JSON.parse(recoveredResult.toString('utf-8'))).toEqual(resultPayload);
    });
  });

  describe('TestQueueOrderingPreserved', () => {
    it('lifecycle queue preserves order across seal/open', async () => {
      const orderedPlaintexts = Array.from({ length: 5 }, (_, i) =>
        Buffer.from(JSON.stringify({ plan_id: `plan-${i}`, saga_name: 'provision' }), 'utf-8'),
      );

      for (let idx = 0; idx < orderedPlaintexts.length; idx++) {
        const aad = makeHubToBridgeAad({ jobId: `plan-${idx}` });
        const envelope = hubSealEnvelope({
          hubPriv: fx.hub.priv,
          zonePub: fx.zone.pub,
          plaintext: orderedPlaintexts[idx],
          aadFields: aad,
        });
        await hubEnqueue(fx.redis, LIFECYCLE_WAIT_KEY, envelope);
      }

      expect(await fx.redis.llen(LIFECYCLE_WAIT_KEY)).toBe(orderedPlaintexts.length);

      const routing: ExpectedRouting = { zoneId: ZONE_ID, queueName: LIFECYCLE_QUEUE_NAME };
      for (let idx = 0; idx < orderedPlaintexts.length; idx++) {
        const consumed = await bridgeConsume(fx.redis, LIFECYCLE_WAIT_KEY);
        expect(consumed).not.toBeNull();
        expect((consumed as { aad: Record<string, unknown> }).aad.job_id).toBe(`plan-${idx}`);
        const recovered = fx.service.openHubToBridge(consumed, routing);
        expect(recovered.equals(orderedPlaintexts[idx])).toBe(true);
      }

      expect(await fx.redis.llen(LIFECYCLE_WAIT_KEY)).toBe(0);
    });

    it('results queue preserves order across seal/open', async () => {
      const orderedPayloads = Array.from({ length: 5 }, (_, i) => ({
        plan_id: `plan-${i}`,
        step_name: 'deploy_os',
        status: 'completed',
      }));

      for (let idx = 0; idx < orderedPayloads.length; idx++) {
        const aad = makeBridgeToHubAad({ jobId: `plan-${idx}` });
        const envelope = fx.service.sealBridgeToHub(Buffer.from(JSON.stringify(orderedPayloads[idx]), 'utf-8'), aad);
        await bridgeEnqueue(fx.redis, RESULTS_WAIT_KEY, envelope);
      }

      for (let idx = 0; idx < orderedPayloads.length; idx++) {
        const consumed = await hubConsume(fx.redis, RESULTS_WAIT_KEY);
        expect(consumed).not.toBeNull();
        expect((consumed as { aad: Record<string, unknown> }).aad.job_id).toBe(`plan-${idx}`);
        const recoveredBytes = hubOpenEnvelope({
          hubPriv: fx.hub.priv,
          zonePub: fx.zone.pub,
          envelope: consumed as Record<string, unknown>,
        });
        expect(JSON.parse(recoveredBytes.toString('utf-8'))).toEqual(orderedPayloads[idx]);
      }

      expect(await fx.redis.llen(RESULTS_WAIT_KEY)).toBe(0);
    });
  });

  describe('TestResultsZonePrefixRouting', () => {
    it('results land under fixed results prefix', async () => {
      const aad = makeBridgeToHubAad({ jobId: 'plan-routing-1' });
      const envelope = fx.service.sealBridgeToHub(Buffer.from('{"status":"ok"}', 'utf-8'), aad);
      await bridgeEnqueue(fx.redis, RESULTS_WAIT_KEY, envelope);

      expect(await fx.redis.exists(RESULTS_WAIT_KEY)).toBe(1);
      const zoneResultsKey = `${ZONE_PREFIX}:${RESULTS_QUEUE_NAME}:wait`;
      expect(await fx.redis.exists(zoneResultsKey)).toBe(0);
    });

    it('lifecycle queue lives under zone prefix', async () => {
      const aad = makeHubToBridgeAad({ jobId: 'plan-zone-1' });
      const envelope = hubSealEnvelope({
        hubPriv: fx.hub.priv,
        zonePub: fx.zone.pub,
        plaintext: Buffer.from('{"saga_name":"provision"}', 'utf-8'),
        aadFields: aad,
      });
      await hubEnqueue(fx.redis, LIFECYCLE_WAIT_KEY, envelope);

      expect(await fx.redis.exists(LIFECYCLE_WAIT_KEY)).toBe(1);
      const resultsLifecycleKey = `${RESULTS_PREFIX}:${LIFECYCLE_QUEUE_NAME}:wait`;
      expect(await fx.redis.exists(resultsLifecycleKey)).toBe(0);
    });
  });

  describe('TestTamperedEnvelopeRejectTaxonomy', () => {
    const routing: ExpectedRouting = { zoneId: ZONE_ID, queueName: LIFECYCLE_QUEUE_NAME };

    it('aad field tamper surfaces as tamper reason', async () => {
      const aad = makeHubToBridgeAad({ jobId: 'plan-tamper-1' });
      const envelope = hubSealEnvelope({
        hubPriv: fx.hub.priv,
        zonePub: fx.zone.pub,
        plaintext: Buffer.from('{"saga_name":"provision"}', 'utf-8'),
        aadFields: aad,
      });
      await hubEnqueue(fx.redis, LIFECYCLE_WAIT_KEY, envelope);

      const consumed = await bridgeConsume(fx.redis, LIFECYCLE_WAIT_KEY);
      expect(consumed).not.toBeNull();
      (consumed as { aad: Record<string, unknown> }).aad.job_id = 'plan-attacker-controlled';

      try {
        fx.service.openHubToBridge(consumed, routing);
        throw new Error('expected SealOpenError');
      } catch (error) {
        expect(error).toBeInstanceOf(SealOpenError);
        expect((error as SealOpenError).reason).toBe(REASON_TAMPER);
      }
    });

    it('ciphertext tamper surfaces as tamper reason', async () => {
      const aad = makeHubToBridgeAad({ jobId: 'plan-ct-tamper' });
      const envelope = hubSealEnvelope({
        hubPriv: fx.hub.priv,
        zonePub: fx.zone.pub,
        plaintext: Buffer.from('{"saga_name":"provision"}', 'utf-8'),
        aadFields: aad,
      });
      await hubEnqueue(fx.redis, LIFECYCLE_WAIT_KEY, envelope);

      const consumed = await bridgeConsume(fx.redis, LIFECYCLE_WAIT_KEY);
      expect(consumed).not.toBeNull();
      const consumedObj = consumed as { ciphertext: string };
      const original = Buffer.from(consumedObj.ciphertext, 'base64');
      const mangled = Buffer.concat([Buffer.from([original[0] ^ 0x01]), original.subarray(1)]);
      consumedObj.ciphertext = mangled.toString('base64');

      try {
        fx.service.openHubToBridge(consumed, routing);
        throw new Error('expected SealOpenError');
      } catch (error) {
        expect(error).toBeInstanceOf(SealOpenError);
        expect((error as SealOpenError).reason).toBe(REASON_TAMPER);
      }
    });

    it('routing mismatch zone_id surfaces routing_mismatch', async () => {
      const wrongZoneAad = makeHubToBridgeAad({
        jobId: 'plan-wrong-zone',
        zoneId: '00000000-0000-4000-8000-000000000099',
      });
      const envelope = hubSealEnvelope({
        hubPriv: fx.hub.priv,
        zonePub: fx.zone.pub,
        plaintext: Buffer.from('x', 'utf-8'),
        aadFields: wrongZoneAad,
      });
      await hubEnqueue(fx.redis, LIFECYCLE_WAIT_KEY, envelope);

      const consumed = await bridgeConsume(fx.redis, LIFECYCLE_WAIT_KEY);
      try {
        fx.service.openHubToBridge(consumed, routing);
        throw new Error('expected SealOpenError');
      } catch (error) {
        expect(error).toBeInstanceOf(SealOpenError);
        expect((error as SealOpenError).reason).toBe(REASON_ROUTING_MISMATCH);
      }
    });

    it('routing mismatch queue_name surfaces routing_mismatch', async () => {
      const wrongQueueAad = makeHubToBridgeAad({
        jobId: 'plan-wrong-queue',
        queueName: 'collection',
      });
      const envelope = hubSealEnvelope({
        hubPriv: fx.hub.priv,
        zonePub: fx.zone.pub,
        plaintext: Buffer.from('x', 'utf-8'),
        aadFields: wrongQueueAad,
      });
      await hubEnqueue(fx.redis, LIFECYCLE_WAIT_KEY, envelope);

      const consumed = await bridgeConsume(fx.redis, LIFECYCLE_WAIT_KEY);
      try {
        fx.service.openHubToBridge(consumed, routing);
        throw new Error('expected SealOpenError');
      } catch (error) {
        expect(error).toBeInstanceOf(SealOpenError);
        expect((error as SealOpenError).reason).toBe(REASON_ROUTING_MISMATCH);
      }
    });

    it('direction mismatch surfaces routing_mismatch', async () => {
      const wrongDirectionAad = makeBridgeToHubAad({
        jobId: 'plan-wrong-direction',
        queueName: LIFECYCLE_QUEUE_NAME,
      });
      const envelope = hubSealEnvelope({
        hubPriv: fx.hub.priv,
        zonePub: fx.zone.pub,
        plaintext: Buffer.from('x', 'utf-8'),
        aadFields: wrongDirectionAad,
      });
      await hubEnqueue(fx.redis, LIFECYCLE_WAIT_KEY, envelope);

      const consumed = await bridgeConsume(fx.redis, LIFECYCLE_WAIT_KEY);
      try {
        fx.service.openHubToBridge(consumed, routing);
        throw new Error('expected SealOpenError');
      } catch (error) {
        expect(error).toBeInstanceOf(SealOpenError);
        expect((error as SealOpenError).reason).toBe(REASON_ROUTING_MISMATCH);
      }
    });

    it('stale envelope surfaces stale reason', async () => {
      const staleCreatedAt = 1_000_000;
      const aad = makeHubToBridgeAad({ jobId: 'plan-stale', createdAt: staleCreatedAt });
      const envelope = hubSealEnvelope({
        hubPriv: fx.hub.priv,
        zonePub: fx.zone.pub,
        plaintext: Buffer.from('x', 'utf-8'),
        aadFields: aad,
      });
      await hubEnqueue(fx.redis, LIFECYCLE_WAIT_KEY, envelope);

      const consumed = await bridgeConsume(fx.redis, LIFECYCLE_WAIT_KEY);
      try {
        fx.service.openHubToBridge(consumed, routing, { nowMs: staleCreatedAt + FRESHNESS_WINDOW_MS + 1 });
        throw new Error('expected SealOpenError');
      } catch (error) {
        expect(error).toBeInstanceOf(SealOpenError);
        expect((error as SealOpenError).reason).toBe(REASON_STALE);
      }
    });

    it('future skew envelope surfaces future_skew reason', async () => {
      const futureCreatedAt = 2_000_000;
      const aad = makeHubToBridgeAad({ jobId: 'plan-future', createdAt: futureCreatedAt });
      const envelope = hubSealEnvelope({
        hubPriv: fx.hub.priv,
        zonePub: fx.zone.pub,
        plaintext: Buffer.from('x', 'utf-8'),
        aadFields: aad,
      });
      await hubEnqueue(fx.redis, LIFECYCLE_WAIT_KEY, envelope);

      const consumed = await bridgeConsume(fx.redis, LIFECYCLE_WAIT_KEY);
      try {
        fx.service.openHubToBridge(consumed, routing, { nowMs: futureCreatedAt - SKEW_TOLERANCE_MS - 1 });
        throw new Error('expected SealOpenError');
      } catch (error) {
        expect(error).toBeInstanceOf(SealOpenError);
        expect((error as SealOpenError).reason).toBe(REASON_FUTURE_SKEW);
      }
    });

    it('envelope version bump surfaces malformed_envelope', async () => {
      const aad = makeHubToBridgeAad({ jobId: 'plan-bad-version' });
      const envelope = hubSealEnvelope({
        hubPriv: fx.hub.priv,
        zonePub: fx.zone.pub,
        plaintext: Buffer.from('x', 'utf-8'),
        aadFields: aad,
      });
      envelope.envelope_v = 999;
      await hubEnqueue(fx.redis, LIFECYCLE_WAIT_KEY, envelope);

      const consumed = await bridgeConsume(fx.redis, LIFECYCLE_WAIT_KEY);
      try {
        fx.service.openHubToBridge(consumed, routing);
        throw new Error('expected SealOpenError');
      } catch (error) {
        expect(error).toBeInstanceOf(SealOpenError);
        expect((error as SealOpenError).reason).toBe(REASON_MALFORMED_ENVELOPE);
      }
    });

    it('missing envelope field surfaces malformed_envelope', async () => {
      const aad = makeHubToBridgeAad({ jobId: 'plan-truncated' });
      const envelope = hubSealEnvelope({
        hubPriv: fx.hub.priv,
        zonePub: fx.zone.pub,
        plaintext: Buffer.from('x', 'utf-8'),
        aadFields: aad,
      });
      const truncated = envelope;
      delete truncated.tag;
      await hubEnqueue(fx.redis, LIFECYCLE_WAIT_KEY, truncated);

      const consumed = await bridgeConsume(fx.redis, LIFECYCLE_WAIT_KEY);
      try {
        fx.service.openHubToBridge(consumed, routing);
        throw new Error('expected SealOpenError');
      } catch (error) {
        expect(error).toBeInstanceOf(SealOpenError);
        expect((error as SealOpenError).reason).toBe(REASON_MALFORMED_ENVELOPE);
      }
    });

    it.each([4, 8, 12])('truncated %d-byte tag surfaces malformed_envelope', async (tagLen) => {
      const aad = makeHubToBridgeAad({ jobId: `plan-trunc-tag-${tagLen}` });
      const envelope = hubSealEnvelope({
        hubPriv: fx.hub.priv,
        zonePub: fx.zone.pub,
        plaintext: Buffer.from('x', 'utf-8'),
        aadFields: aad,
      });
      const fullTag = Buffer.from(envelope.tag as string, 'base64');
      envelope.tag = fullTag.subarray(0, tagLen).toString('base64');
      await hubEnqueue(fx.redis, LIFECYCLE_WAIT_KEY, envelope);

      const consumed = await bridgeConsume(fx.redis, LIFECYCLE_WAIT_KEY);
      try {
        fx.service.openHubToBridge(consumed, routing);
        throw new Error('expected SealOpenError');
      } catch (error) {
        expect(error).toBeInstanceOf(SealOpenError);
        expect((error as SealOpenError).reason).toBe(REASON_MALFORMED_ENVELOPE);
      }
    });

    it('key_unknown surfaces when holder cleared', async () => {
      const aad = makeHubToBridgeAad({ jobId: 'plan-no-holder' });
      const envelope = hubSealEnvelope({
        hubPriv: fx.hub.priv,
        zonePub: fx.zone.pub,
        plaintext: Buffer.from('x', 'utf-8'),
        aadFields: aad,
      });
      await hubEnqueue(fx.redis, LIFECYCLE_WAIT_KEY, envelope);

      fx.zoneCrypto.clear();

      const consumed = await bridgeConsume(fx.redis, LIFECYCLE_WAIT_KEY);
      try {
        fx.service.openHubToBridge(consumed, routing);
        throw new Error('expected SealKeyUnknownError');
      } catch (error) {
        expect(error).toBeInstanceOf(SealKeyUnknownError);
        expect((error as SealKeyUnknownError).reason).toBe(REASON_KEY_UNKNOWN);
      }
    });
  });

  describe('TestExpectedRoutingHelperType', () => {
    it('expected routing construction', () => {
      const routing: ExpectedRouting = { zoneId: ZONE_ID, queueName: LIFECYCLE_QUEUE_NAME };
      expect(routing.zoneId).toBe(ZONE_ID);
      expect(routing.queueName).toBe(LIFECYCLE_QUEUE_NAME);
    });
  });
});
