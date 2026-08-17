import { type DeviceSecretAadFields, derivePublicKey, deviceSecretAad, seal } from '@repo/crypto';
import { Buffer } from 'node:buffer';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { deviceSecret as deviceSecretKey } from '../../common/redis/redis-keys';
import type { AtomCache, EnqueueRenderRequest } from '../../device-record/atom/atom-fetcher';
import { DeviceSecretAtomFetcher } from '../device-secret-atom.service';
import { clearActiveZoneCryptoSnapshot, setActiveZoneCryptoSnapshot } from '../zone-crypto.service';

function genPriv(): Buffer {
  return Buffer.from(generateKeyPairSync('x25519').privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32));
}

const hubPriv = genPriv();
const hubPub = derivePublicKey(hubPriv);
const zonePriv = genPriv();
const zonePub = derivePublicKey(zonePriv);

const DEVICE_ID = '00000000-0000-0000-0000-0000000000aa';
const BRIDGE_ID = 'bridge-1';
const FIELDS: DeviceSecretAadFields = {
  zoneId: '00000000-0000-0000-0000-000000000001',
  zoneKeyId: '00000000-0000-0000-0000-0000000000e1',
  deviceId: DEVICE_ID,
  purpose: 'BMC',
  kind: 'USER',
  keyGen: 1,
};

function sealedAtomEnvelope(): string {
  const sealed = seal(
    hubPriv,
    zonePub,
    Buffer.from(JSON.stringify({ user: 'admin', pass: 's3cr3t' }), 'utf8'),
    deviceSecretAad(FIELDS),
  );
  return JSON.stringify({
    status: 'ok',
    written_at: 1_730_000_000_000,
    request_id: null,
    value: {
      zoneId: FIELDS.zoneId,
      zoneKeyId: FIELDS.zoneKeyId,
      deviceId: FIELDS.deviceId,
      purpose: FIELDS.purpose,
      kind: FIELDS.kind,
      keyGen: FIELDS.keyGen,
      ephPub: sealed.ephPub.toString('base64'),
      ciphertext: sealed.ciphertext.toString('base64'),
      tag: sealed.tag.toString('base64'),
    },
  });
}

function cacheReturning(raw: string | null): AtomCache {
  return {
    get: vi.fn(async () => raw),
    delete: vi.fn(async () => 1),
  };
}

describe('DeviceSecretAtomFetcher.getBmcSecret', () => {
  beforeEach(() => {
    setActiveZoneCryptoSnapshot({ zonePriv, zonePub, hubPub, enrolledAt: 1_730_000_000_000 });
  });
  afterEach(() => {
    clearActiveZoneCryptoSnapshot();
  });

  it('end-to-end: fetches the sealed atom and opens it to {username,password}', async () => {
    const cache = cacheReturning(sealedAtomEnvelope());
    const enqueue: EnqueueRenderRequest = vi.fn(async () => true);
    const fetcher = new DeviceSecretAtomFetcher(cache, enqueue, BRIDGE_ID);

    const result = await fetcher.getBmcSecret(DEVICE_ID, 'BMC', 'USER', { jobId: 'job-1' });

    expect(result).toEqual({ username: 'admin', password: 's3cr3t' });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('addresses the byte-matched atom key (purpose/kind lowercased)', async () => {
    const cache = cacheReturning(null);
    const enqueue: EnqueueRenderRequest = vi.fn(async () => false);
    const fetcher = new DeviceSecretAtomFetcher(cache, enqueue, BRIDGE_ID);

    await fetcher.getBmcSecret(DEVICE_ID, 'BMC', 'USER');

    const getMock = cache.get as ReturnType<typeof vi.fn>;
    expect(getMock.mock.calls[0][0]).toBe(`device:${DEVICE_ID}:secrets:bmc:user`);
    expect(getMock.mock.calls[0][0]).toBe(deviceSecretKey(DEVICE_ID, 'BMC', 'USER'));
  });

  it('enqueues a device_secret render request with {purpose,kind} params on a miss', async () => {
    const cache = cacheReturning(null);
    const enqueue: EnqueueRenderRequest = vi.fn(async () => false);
    const fetcher = new DeviceSecretAtomFetcher(cache, enqueue, BRIDGE_ID);

    const result = await fetcher.getBmcSecret(DEVICE_ID, 'BMC', 'USER');

    expect(result).toBeNull();
    const enqueueMock = enqueue as ReturnType<typeof vi.fn>;
    expect(enqueueMock).toHaveBeenCalledTimes(1);
    const arg = enqueueMock.mock.calls[0][0];
    expect(arg.domain).toBe('device_secret');
    expect(arg.entityId).toBe(DEVICE_ID);
    expect(arg.bridgeId).toBe(BRIDGE_ID);
    expect(arg.params).toEqual({ purpose: 'BMC', kind: 'USER' });
    expect(arg.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('returns null and keeps the atom cached when zone crypto is not loaded', async () => {
    clearActiveZoneCryptoSnapshot();
    const cache = cacheReturning(sealedAtomEnvelope());
    const enqueue: EnqueueRenderRequest = vi.fn(async () => true);
    const logger = { debug: vi.fn(), warn: vi.fn() };
    const fetcher = new DeviceSecretAtomFetcher(cache, enqueue, BRIDGE_ID, logger);

    const result = await fetcher.getBmcSecret(DEVICE_ID, 'BMC', 'USER');

    expect(result).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/zone crypto not loaded; keeping cached/), '');
    expect(cache.delete).not.toHaveBeenCalled();
  });

  it('returns null and deletes the atom (force re-render) when a present blob is tampered', async () => {
    const tampered = JSON.parse(sealedAtomEnvelope());
    tampered.value.ciphertext = Buffer.from('garbage-ciphertext-bytes').toString('base64');
    const cache = cacheReturning(JSON.stringify(tampered));
    const enqueue: EnqueueRenderRequest = vi.fn(async () => true);
    const logger = { debug: vi.fn(), warn: vi.fn() };
    const fetcher = new DeviceSecretAtomFetcher(cache, enqueue, BRIDGE_ID, logger);

    const result = await fetcher.getBmcSecret(DEVICE_ID, 'BMC', 'USER');

    expect(result).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/deleting to force re-render/), '');
    expect(cache.delete).toHaveBeenCalledWith(deviceSecretKey(DEVICE_ID, 'BMC', 'USER'), '');
  });

  it('still returns null (not throw) when the re-render delete itself fails', async () => {
    const tampered = JSON.parse(sealedAtomEnvelope());
    tampered.value.ciphertext = Buffer.from('garbage-ciphertext-bytes').toString('base64');
    const cache: AtomCache = {
      get: vi.fn(async () => JSON.stringify(tampered)),
      delete: vi.fn(async () => {
        throw new Error('redis connection reset');
      }),
    };
    const enqueue: EnqueueRenderRequest = vi.fn(async () => true);
    const logger = { debug: vi.fn(), warn: vi.fn() };
    const fetcher = new DeviceSecretAtomFetcher(cache, enqueue, BRIDGE_ID, logger);

    const result = await fetcher.getBmcSecret(DEVICE_ID, 'BMC', 'USER');

    expect(result).toBeNull();
    expect(cache.delete).toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/re-render delete failed/), '');
  });

  it('degrades without crashing when constructed with no injected logger (prod path)', async () => {
    const tampered = JSON.parse(sealedAtomEnvelope());
    tampered.value.ciphertext = Buffer.from('garbage-ciphertext-bytes').toString('base64');
    const cache = cacheReturning(JSON.stringify(tampered));
    const fetcher = new DeviceSecretAtomFetcher(
      cache,
      vi.fn(async () => true),
      BRIDGE_ID,
    );

    await expect(fetcher.getBmcSecret(DEVICE_ID, 'BMC', 'USER')).resolves.toBeNull();
    expect(cache.delete).toHaveBeenCalledWith(deviceSecretKey(DEVICE_ID, 'BMC', 'USER'), '');
  });

  it('uses randomUUID requestIds (sanity: distinct across instances)', () => {
    expect(randomUUID()).not.toBe(randomUUID());
  });
});
