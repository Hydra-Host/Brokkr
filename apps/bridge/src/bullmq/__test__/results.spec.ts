import {
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  type KeyObject,
} from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { canonicalizeAad } from '@repo/crypto';
import type { ZoneCryptoSnapshot } from '../../zone-crypto/zone-crypto.service.js';
import { resetBullmqConfigForTests } from '../bullmq.config.js';
import {
  ResultsService,
  type OutboundPayload,
  type ResultsLogger,
  type ResultsQueue,
  type ResultsQueueAddOptions,
  type ResultsQueueProvider,
  type ResultsRedisClient,
  type ResultsRedisProvider,
  type ZoneCryptoProvider,
  type ZoneIdProvider,
} from '../results.service.js';

import { type SealedEnvelope } from '../seal-outbound-payload.js';

const ZONE_ID = '00000000-0000-4000-8000-000000000001';
const RESULTS_QUEUE_NAME = 'inbox';

interface AddCall {
  name: string;
  data: OutboundPayload;
  opts: ResultsQueueAddOptions;
}

class FakeResultsQueue implements ResultsQueue {
  readonly name = RESULTS_QUEUE_NAME;
  readonly added: AddCall[] = [];

  constructor(private readonly onAdd?: () => void) {}

  async add(name: string, data: OutboundPayload, opts: ResultsQueueAddOptions): Promise<unknown> {
    this.added.push({ name, data, opts });
    if (this.onAdd) this.onAdd();
    return {};
  }
}

function makeQueueProvider(queue: ResultsQueue | null): ResultsQueueProvider {
  return {
    getResultsQueue: async () => queue,
    resetSharedOpsStateOnConnectionError: async () => true,
  };
}

function makeRedisProvider(client: ResultsRedisClient | null): ResultsRedisProvider {
  return {
    getResultsRedis: async () => client,
    resetSharedOpsStateOnConnectionError: async () => true,
  };
}

const NULL_ZONE_CRYPTO: ZoneCryptoProvider = { get: () => null };
const ZONE_ID_PROVIDER: ZoneIdProvider = { getZoneId: () => ZONE_ID };

const SILENT: ResultsLogger = {
  info: async () => {},
  warning: async () => {},
};

class FakeRedis implements ResultsRedisClient {
  readonly sets: Array<[string, string, number]> = [];
  deletes: string[] = [];
  scanResult: string[] = [];
  store = new Map<string, string>();

  constructor(private readonly opts: { setThrows?: boolean } = {}) {}

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async set(key: string, value: string, ttl: number): Promise<unknown> {
    if (this.opts.setThrows) throw new Error('Redis down');
    this.sets.push([key, value, ttl]);
    this.store.set(key, value);
    return 'OK';
  }

  async delete(keys: string[]): Promise<unknown> {
    this.deletes.push(...keys);
    return keys.length;
  }

  async scan(_pattern: string): Promise<string[]> {
    return this.scanResult;
  }
}

function rawToX25519Priv(raw: Buffer): KeyObject {
  return createPrivateKey({
    key: Buffer.concat([Buffer.from('302e020100300506032b656e04220420', 'hex'), raw]),
    format: 'der',
    type: 'pkcs8',
  });
}

function rawToX25519Pub(raw: Buffer): KeyObject {
  return createPublicKey({
    key: Buffer.concat([Buffer.from('302a300506032b656e032100', 'hex'), raw]),
    format: 'der',
    type: 'spki',
  });
}

function genKeypair(): { priv: Buffer; pub: Buffer } {
  const { privateKey, publicKey } = generateKeyPairSync('x25519');
  const pkcs8 = privateKey.export({ format: 'der', type: 'pkcs8' });
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  return {
    priv: Buffer.from(pkcs8.subarray(pkcs8.length - 32)),
    pub: Buffer.from(spki.subarray(spki.length - 32)),
  };
}

function openSealedEnvelope(envelope: SealedEnvelope, hubPriv: Buffer, zonePub: Buffer): Record<string, unknown> {
  const aadBytes = canonicalizeAad(envelope.aad);
  const ephPub = Buffer.from(envelope.eph_pub, 'base64');
  const ciphertext = Buffer.from(envelope.ciphertext, 'base64');
  const tag = Buffer.from(envelope.tag, 'base64');

  const hubPrivKey = rawToX25519Priv(hubPriv);
  const sharedE = diffieHellman({ privateKey: hubPrivKey, publicKey: rawToX25519Pub(ephPub) });
  const sharedS = diffieHellman({ privateKey: hubPrivKey, publicKey: rawToX25519Pub(zonePub) });
  const ikm = Buffer.concat([sharedE, sharedS]);

  const salt = createHash('sha256').update(aadBytes).digest();
  const aesKey = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('brokkr-auth-dh-v1', 'utf-8'), 32));
  const nonce = createHash('sha256').update(ephPub).digest().subarray(0, 12);

  const decipher = createDecipheriv('aes-256-gcm', aesKey, nonce);
  decipher.setAAD(aadBytes);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(plaintext.toString('utf-8')) as Record<string, unknown>;
}

function isSealed(data: OutboundPayload): data is SealedEnvelope {
  return 'envelope_v' in data;
}

function plain(data: OutboundPayload): Record<string, unknown> {
  expect(isSealed(data)).toBe(false);
  if (isSealed(data)) throw new Error('expected plaintext payload');
  return data;
}

beforeEach(() => {
  resetBullmqConfigForTests();
});

afterEach(() => {
  resetBullmqConfigForTests();
});

function makeService(opts: {
  queue?: ResultsQueue | null;
  redis?: ResultsRedisClient | null;
  zoneCrypto?: ZoneCryptoProvider;
}): ResultsService {
  return new ResultsService(
    makeQueueProvider(opts.queue ?? null),
    makeRedisProvider(opts.redis ?? null),
    opts.zoneCrypto ?? NULL_ZONE_CRYPTO,
    ZONE_ID_PROVIDER,
    SILENT,
  );
}

describe('enqueueResult', () => {
  it('calls queue.add with the job.result name + stringified device id', async () => {
    const queue = new FakeResultsQueue();
    const service = makeService({ queue });

    const sent = await service.enqueueResult({
      planId: 'plan-1',
      stepName: 'deploy_os',
      status: 'completed',
      deviceId: 42,
      eventType: 'stage_changed',
      actionType: 'provision',
      result: { ok: true },
    });

    expect(sent).toBe(true);
    expect(queue.added).toHaveLength(1);
    const [call] = queue.added;
    expect(call.name).toBe('job.result');
    const data = plain(call.data);
    expect(data.plan_id).toBe('plan-1');
    expect(data.step_name).toBe('deploy_os');
    expect(data.status).toBe('completed');
    expect(data.device_id).toBe('42');
  });

  it('returns false when the queue is unavailable', async () => {
    const service = makeService({ queue: null });
    const sent = await service.enqueueResult({
      planId: 'plan-1',
      stepName: 'deploy_os',
      status: 'completed',
      deviceId: 42,
    });
    expect(sent).toBe(false);
  });

  it('returns false when queue.add throws', async () => {
    const queue = new FakeResultsQueue(() => {
      throw new Error('Redis down');
    });
    const service = makeService({ queue });
    const sent = await service.enqueueResult({
      planId: 'plan-1',
      stepName: 'deploy_os',
      status: 'failed',
      deviceId: 42,
      error: 'disk full',
    });
    expect(sent).toBe(false);
  });

  it('formats error as a {message} dict', async () => {
    const queue = new FakeResultsQueue();
    const service = makeService({ queue });
    await service.enqueueResult({
      planId: 'plan-1',
      stepName: 'wipe_disks',
      status: 'failed',
      deviceId: 42,
      error: 'timeout exceeded',
    });
    expect(plain(queue.added[0].data).error).toEqual({ message: 'timeout exceeded' });
  });

  it('emits null error when none is provided', async () => {
    const queue = new FakeResultsQueue();
    const service = makeService({ queue });
    await service.enqueueResult({
      planId: 'plan-1',
      stepName: 'deploy_os',
      status: 'completed',
      deviceId: 42,
    });
    expect(plain(queue.added[0].data).error).toBeNull();
  });
});

describe('enqueueJobCompleted', () => {
  it('calls queue.add with the job.completed name + fields', async () => {
    const queue = new FakeResultsQueue();
    const service = makeService({ queue });

    const sent = await service.enqueueJobCompleted({
      planId: 'plan-done',
      deviceId: 42,
      sagaName: 'provision',
      status: 'completed',
      durationSeconds: 123.4,
    });

    expect(sent).toBe(true);
    const [call] = queue.added;
    expect(call.name).toBe('job.completed');
    const data = plain(call.data);
    expect(data.plan_id).toBe('plan-done');
    expect(data.saga_name).toBe('provision');
    expect(data.duration_seconds).toBe(123.4);
  });

  it('returns false when the queue is unavailable', async () => {
    const service = makeService({ queue: null });
    const sent = await service.enqueueJobCompleted({
      planId: 'plan-done',
      deviceId: 42,
      sagaName: 'provision',
      status: 'completed',
    });
    expect(sent).toBe(false);
  });
});

describe('enqueuePhoneHome', () => {
  it('calls queue.add with the device.phone_home name + device/zone/boot fields', async () => {
    const queue = new FakeResultsQueue();
    const service = makeService({ queue });

    const sent = await service.enqueuePhoneHome({ deviceId: 'dev-1', bootId: 'boot-xyz' });

    expect(sent).toBe(true);
    expect(queue.added).toHaveLength(1);
    const [call] = queue.added;
    expect(call.name).toBe('device.phone_home');
    const data = plain(call.data);
    expect(data.device_id).toBe('dev-1');
    expect(typeof data.zone_prefix).toBe('string');
    expect(data.boot_id).toBe('boot-xyz');
    expect(typeof data.timestamp).toBe('number');
  });

  it('returns false when the queue is unavailable', async () => {
    const service = makeService({ queue: null });
    const sent = await service.enqueuePhoneHome({ deviceId: 'dev-1', bootId: 'boot-xyz' });
    expect(sent).toBe(false);
  });

  it('returns false when queue.add throws', async () => {
    const queue = new FakeResultsQueue(() => {
      throw new Error('Redis down');
    });
    const service = makeService({ queue });
    const sent = await service.enqueuePhoneHome({ deviceId: 'dev-1', bootId: 'boot-xyz' });
    expect(sent).toBe(false);
  });
});

describe('writeCollectorToResultsCache', () => {
  it('splits a dict into one per-field key', async () => {
    const redis = new FakeRedis();
    const service = makeService({ redis });

    const [ok, kept] = await service.writeCollectorToResultsCache({
      deviceId: '42',
      collector: 'is_virtual',
      data: { is_virtual: true, virt_type: 'none' },
    });

    expect([ok, kept]).toEqual([true, 2]);
    expect(redis.sets).toHaveLength(2);
    const entries = Object.fromEntries(redis.sets.map(([k, v]) => [k, v]));
    expect(JSON.parse(entries['device:42:discovery:is_virtual'])).toBe(true);
    expect(JSON.parse(entries['device:42:discovery:virt_type'])).toBe('none');
    expect(redis.sets[0][2]).toBe(600);
  });

  it('stores non-dict data under the collector name verbatim', async () => {
    const redis = new FakeRedis();
    const service = makeService({ redis });

    const [ok, kept] = await service.writeCollectorToResultsCache({
      deviceId: '42',
      collector: 'version',
      data: '1.2.3',
    });

    expect([ok, kept]).toEqual([true, 1]);
    expect(redis.sets).toHaveLength(1);
    expect(redis.sets[0][0]).toBe('device:42:discovery:version');
  });

  it('returns [false, 0] without a redis client', async () => {
    const service = makeService({ redis: null });
    const [ok, kept] = await service.writeCollectorToResultsCache({
      deviceId: '42',
      collector: 'lscpu',
      data: { cores: 16 },
    });
    expect([ok, kept]).toEqual([false, 0]);
  });

  it('drops every field over the cap: no set, returns [true, 0]', async () => {
    const redis = new FakeRedis();
    const service = makeService({ redis });
    const oversized = 'x'.repeat(200);

    const [ok, kept] = await service.writeCollectorToResultsCache({
      deviceId: '42',
      collector: 'bloated',
      data: { huge_a: oversized, huge_b: oversized },
      maxPayloadBytes: 100,
    });

    expect([ok, kept]).toEqual([true, 0]);
    expect(redis.sets).toHaveLength(0);
  });

  it('keeps only the under-cap field on a partial drop', async () => {
    const redis = new FakeRedis();
    const service = makeService({ redis });
    const oversized = 'x'.repeat(200);

    const [ok, kept] = await service.writeCollectorToResultsCache({
      deviceId: '42',
      collector: 'mixed',
      data: { small: 'ok', giant: oversized },
      maxPayloadBytes: 100,
    });

    expect([ok, kept]).toEqual([true, 1]);
    expect(redis.sets).toHaveLength(1);
    expect(redis.sets[0][0]).toBe('device:42:discovery:small');
  });

  it('returns [false, 0] when set throws', async () => {
    const redis = new FakeRedis({ setThrows: true });
    const service = makeService({ redis });
    const [ok, kept] = await service.writeCollectorToResultsCache({
      deviceId: '42',
      collector: 'lscpu',
      data: { cores: 16 },
    });
    expect([ok, kept]).toEqual([false, 0]);
  });
});

describe('clearCollectionData', () => {
  it('deletes per-field keys tracked in memory', async () => {
    const redis = new FakeRedis();
    const service = makeService({ redis });
    await service.writeCollectorToResultsCache({
      deviceId: '3259',
      collector: 'lscpu',
      data: { cores: 16, threads: 32 },
    });
    redis.deletes = [];

    const ok = await service.clearCollectionData('3259');
    expect(ok).toBe(true);
    expect(redis.deletes.sort()).toEqual(['device:3259:discovery:cores', 'device:3259:discovery:threads']);
  });

  it('falls back to SCAN when no fields are tracked in memory', async () => {
    const redis = new FakeRedis();
    redis.scanResult = ['device:9000:discovery:orphan_a', 'device:9000:discovery:orphan_b'];
    const service = makeService({ redis });

    const ok = await service.clearCollectionData('9000');
    expect(ok).toBe(true);
    expect(redis.deletes).toEqual(['device:9000:discovery:orphan_a', 'device:9000:discovery:orphan_b']);
  });

  it('returns false without a redis client', async () => {
    const service = makeService({ redis: null });
    expect(await service.clearCollectionData('3259')).toBe(false);
  });
});

describe('getCollectionFieldCount', () => {
  it('returns the size of the tracked field set', async () => {
    const redis = new FakeRedis();
    const service = makeService({ redis });
    await service.writeCollectorToResultsCache({
      deviceId: '42',
      collector: 'lscpu',
      data: { cores: 16, threads: 32, sockets: 1 },
    });
    expect(service.getCollectionFieldCount('42')).toBe(3);
  });

  it('returns null when no fields are tracked for the device', async () => {
    const service = makeService({ redis: null });
    expect(service.getCollectionFieldCount('42')).toBeNull();
  });
});

describe('enqueueDiscoveryComplete', () => {
  it('calls queue.add with the discovery.complete name + tracked fields list', async () => {
    const redis = new FakeRedis();
    const queue = new FakeResultsQueue();
    const service = makeService({ queue, redis });

    await service.writeCollectorToResultsCache({
      deviceId: '42',
      collector: 'lscpu',
      data: { cores: 16, threads: 32 },
    });

    const sent = await service.enqueueDiscoveryComplete({ deviceId: '42', jobId: 'test-job' });

    expect(sent).toBe(true);
    const [call] = queue.added;
    expect(call.name).toBe('discovery.complete');
    const data = plain(call.data);
    expect(data.device_id).toBe('42');
    expect((data.fields as string[]).sort()).toEqual(['cores', 'threads']);
  });

  it('emits an empty fields list when no collectors wrote', async () => {
    const queue = new FakeResultsQueue();
    const service = makeService({ queue });
    const sent = await service.enqueueDiscoveryComplete({ deviceId: '42', jobId: 'test-job' });
    expect(sent).toBe(true);
    const data = plain(queue.added[0].data);
    expect(data.fields).toEqual([]);
  });

  it('returns false when the queue is unavailable', async () => {
    const service = makeService({ queue: null });
    const sent = await service.enqueueDiscoveryComplete({ deviceId: '42' });
    expect(sent).toBe(false);
  });

  it('drops the in-memory tracker after enqueue', async () => {
    const redis = new FakeRedis();
    const queue = new FakeResultsQueue();
    const service = makeService({ queue, redis });
    await service.writeCollectorToResultsCache({
      deviceId: '42',
      collector: 'lscpu',
      data: { cores: 16 },
    });
    expect(service.getCollectionFieldCount('42')).toBe(1);
    await service.enqueueDiscoveryComplete({ deviceId: '42' });
    expect(service.getCollectionFieldCount('42')).toBeNull();
  });
});

function activatedCrypto(zonePriv: Buffer, zonePub: Buffer, hubPub: Buffer): ZoneCryptoProvider {
  const snapshot: ZoneCryptoSnapshot = {
    zonePriv,
    zonePub,
    hubPub,
    enrolledAt: 1_730_000_000_000,
  };
  return { get: () => snapshot };
}

describe('outbound sealing', () => {
  it('seals enqueueResult post-activation and the hub can decrypt it', async () => {
    const hub = genKeypair();
    const zone = genKeypair();
    const queue = new FakeResultsQueue();
    const service = makeService({
      queue,
      zoneCrypto: activatedCrypto(zone.priv, zone.pub, hub.pub),
    });

    const sent = await service.enqueueResult({
      planId: 'plan-sealed',
      stepName: 'deploy_os',
      status: 'completed',
      deviceId: 42,
    });

    expect(sent).toBe(true);
    const { name, data } = queue.added[0];
    expect(name).toBe('job.result');
    expect(isSealed(data)).toBe(true);
    if (!isSealed(data)) return;
    expect(data.envelope_v).toBe(1);
    expect(data.aad.aad_v).toBe(1);
    expect(data.aad.zone_id).toBe(ZONE_ID);
    expect(data.aad.queue_name).toBe(RESULTS_QUEUE_NAME);
    expect(data.aad.direction).toBe('bridge_to_hub');
    expect(data.aad.job_id).toBe('plan-sealed');
    expect(Number.isInteger(data.aad.created_at)).toBe(true);

    const payload = openSealedEnvelope(data, hub.priv, zone.pub);
    expect(payload.plan_id).toBe('plan-sealed');
    expect(payload.step_name).toBe('deploy_os');
    expect(payload.status).toBe('completed');
    expect(payload.device_id).toBe('42');
  });

  it('seals enqueueJobCompleted post-activation', async () => {
    const hub = genKeypair();
    const zone = genKeypair();
    const queue = new FakeResultsQueue();
    const service = makeService({
      queue,
      zoneCrypto: activatedCrypto(zone.priv, zone.pub, hub.pub),
    });

    await service.enqueueJobCompleted({
      planId: 'plan-done',
      deviceId: 42,
      sagaName: 'provision',
      status: 'completed',
      durationSeconds: 12.3,
    });

    const { name, data } = queue.added[0];
    expect(name).toBe('job.completed');
    expect(isSealed(data)).toBe(true);
    if (!isSealed(data)) return;
    const payload = openSealedEnvelope(data, hub.priv, zone.pub);
    expect(payload.plan_id).toBe('plan-done');
    expect(payload.saga_name).toBe('provision');
    expect(payload.duration_seconds).toBe(12.3);
  });

  it('seals enqueueDiscoveryComplete with the function-level job_id in the AAD', async () => {
    const hub = genKeypair();
    const zone = genKeypair();
    const queue = new FakeResultsQueue();
    const service = makeService({
      queue,
      zoneCrypto: activatedCrypto(zone.priv, zone.pub, hub.pub),
    });

    await service.enqueueDiscoveryComplete({ deviceId: '42', jobId: 'disco-1' });

    const { name, data } = queue.added[0];
    expect(name).toBe('discovery.complete');
    expect(isSealed(data)).toBe(true);
    if (!isSealed(data)) return;
    expect(data.aad.job_id).toBe('disco-1');
    const payload = openSealedEnvelope(data, hub.priv, zone.pub);
    expect(payload.device_id).toBe('42');
    expect(payload.fields).toEqual([]);
  });

  it('leaves the payload as a plaintext dict pre-activation', async () => {
    const queue = new FakeResultsQueue();
    const service = makeService({ queue });

    await service.enqueueResult({
      planId: 'plan-pt',
      stepName: 's',
      status: 'completed',
      deviceId: 1,
    });

    const data = plain(queue.added[0].data);
    expect(data.plan_id).toBe('plan-pt');
  });
});
