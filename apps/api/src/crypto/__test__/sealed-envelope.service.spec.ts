import { Test, TestingModule } from '@nestjs/testing';
import { type Aad, canonicalizeAad, derivePublicKey, open, seal } from '@repo/crypto';
import { Buffer } from 'node:buffer';
import { generateKeyPairSync } from 'node:crypto';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';

import { ZoneCryptoConfig } from '../../zone-crypto/zone-crypto.config';
import { ZoneCryptoRepository } from '../../zone-crypto/zone-crypto.repository';
import { SealedEnvelopeService } from '../sealed-envelope.service';
import { SealKeyUnknownError, SealOpenError } from '../sealed-envelope.types';

const ZONE_ID = '00000000-0000-4000-8000-000000000001';

function rawPriv(): Buffer {
  const { privateKey } = generateKeyPairSync('x25519');
  return Buffer.from(privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32));
}

const HUB_PRIV = rawPriv();
const HUB_PUB = derivePublicKey(HUB_PRIV);
const ZONE_PRIV = rawPriv();
const ZONE_PUB = derivePublicKey(ZONE_PRIV);

function hubToBridgeAad(overrides: Partial<Aad> = {}): Aad {
  return {
    aad_v: 1,
    zone_id: ZONE_ID,
    queue_name: 'lifecycle',
    direction: 'hub_to_bridge',
    job_id: 'plan-123',
    created_at: Date.now(),
    ...overrides,
  };
}

function makeBridgeToHubEnvelope(plaintext: Buffer, aadOverrides: Partial<Aad> = {}) {
  const aad: Aad = {
    aad_v: 1,
    zone_id: ZONE_ID,
    queue_name: 'inbox',
    direction: 'bridge_to_hub',
    job_id: 'result-1',
    created_at: Date.now(),
    ...aadOverrides,
  };
  const sealed = seal(ZONE_PRIV, HUB_PUB, plaintext, canonicalizeAad(aad));
  return {
    envelope_v: 1,
    aad,
    eph_pub: sealed.ephPub.toString('base64'),
    ciphertext: sealed.ciphertext.toString('base64'),
    tag: sealed.tag.toString('base64'),
  };
}

describe('SealedEnvelopeService', () => {
  let service: SealedEnvelopeService;
  let mockConfig: { isAvailable: boolean; privateKey: Buffer | null; publicKey: Buffer | null };
  let mockRepo: { findEnrollmentByZoneId: Mock };

  beforeEach(async () => {
    mockConfig = { isAvailable: true, privateKey: HUB_PRIV, publicKey: HUB_PUB };
    mockRepo = { findEnrollmentByZoneId: vi.fn().mockResolvedValue({ zoneId: ZONE_ID, zonePub: ZONE_PUB }) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SealedEnvelopeService,
        { provide: ZoneCryptoConfig, useValue: mockConfig },
        { provide: ZoneCryptoRepository, useValue: mockRepo },
        {
          provide: `LoggerService${SealedEnvelopeService.name}`,
          useValue: { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        },
      ],
    }).compile();

    service = module.get(SealedEnvelopeService);
  });

  describe('sealHubToBridge → opened by the bridge wire (cross-impl parity)', () => {
    it('produces an envelope the bridge opens to byte-identical plaintext', async () => {
      const plaintext = Buffer.from(
        JSON.stringify({ plan_id: 'p', payload: { username: 'admin', password: 's3cret' } }),
      );
      const aad = hubToBridgeAad();

      const env = await service.sealHubToBridge(ZONE_ID, plaintext, aad);

      expect(env.envelope_v).toBe(1);
      expect(env.aad).toEqual(aad);
      const opened = open(
        ZONE_PRIV,
        HUB_PUB,
        Buffer.from(env.eph_pub, 'base64'),
        Buffer.from(env.ciphertext, 'base64'),
        Buffer.from(env.tag, 'base64'),
        canonicalizeAad(env.aad),
      );
      expect(opened.equals(plaintext)).toBe(true);
    });

    it('keeps BMC credentials opaque on the wire (F5)', async () => {
      const plaintext = Buffer.from(JSON.stringify({ payload: { password: 'TOP-SECRET-BMC' } }));
      const env = await service.sealHubToBridge(ZONE_ID, plaintext, hubToBridgeAad());
      const wire = JSON.stringify(env);
      expect(wire).not.toContain('TOP-SECRET-BMC');
    });

    it('rejects a non hub_to_bridge direction (routing_mismatch)', async () => {
      await expect(
        service.sealHubToBridge(ZONE_ID, Buffer.from('x'), hubToBridgeAad({ direction: 'bridge_to_hub' })),
      ).rejects.toMatchObject({ reason: 'routing_mismatch' });
    });

    it('throws SealKeyUnknownError when the zone is not enrolled', async () => {
      mockRepo.findEnrollmentByZoneId.mockResolvedValue(null);
      await expect(service.sealHubToBridge(ZONE_ID, Buffer.from('x'), hubToBridgeAad())).rejects.toBeInstanceOf(
        SealKeyUnknownError,
      );
    });

    it('throws SealKeyUnknownError when hub crypto is dormant', async () => {
      mockConfig.privateKey = null;
      await expect(service.sealHubToBridge(ZONE_ID, Buffer.from('x'), hubToBridgeAad())).rejects.toBeInstanceOf(
        SealKeyUnknownError,
      );
    });
  });

  describe('openBridgeToHub', () => {
    it('round-trips a genuine bridge-sealed result', async () => {
      const plaintext = Buffer.from(JSON.stringify({ zone_prefix: ZONE_ID, status: 'completed' }));
      const env = makeBridgeToHubEnvelope(plaintext);
      const opened = await service.openBridgeToHub(env, { queueName: 'inbox' });
      expect(opened.plaintext.equals(plaintext)).toBe(true);
      expect(opened.zoneId).toBe(ZONE_ID);
    });

    it('rejects a tampered ciphertext (tamper)', async () => {
      const env = makeBridgeToHubEnvelope(Buffer.from('hello'));
      const bytes = Buffer.from(env.ciphertext, 'base64');
      bytes[0] ^= 0xff;
      env.ciphertext = bytes.toString('base64');
      await expect(service.openBridgeToHub(env, { queueName: 'inbox' })).rejects.toMatchObject({ reason: 'tamper' });
    });

    it('rejects a queue_name mismatch (routing_mismatch)', async () => {
      const env = makeBridgeToHubEnvelope(Buffer.from('x'));
      await expect(service.openBridgeToHub(env, { queueName: 'lifecycle' })).rejects.toMatchObject({
        reason: 'routing_mismatch',
      });
    });

    it('rejects a direction mismatch (routing_mismatch)', async () => {
      const env = makeBridgeToHubEnvelope(Buffer.from('x'), { direction: 'hub_to_bridge' });
      await expect(service.openBridgeToHub(env, { queueName: 'inbox' })).rejects.toMatchObject({
        reason: 'routing_mismatch',
      });
    });

    it('rejects a malformed envelope (bad version)', async () => {
      const env = { ...makeBridgeToHubEnvelope(Buffer.from('x')), envelope_v: 2 };
      await expect(service.openBridgeToHub(env, { queueName: 'inbox' })).rejects.toMatchObject({
        reason: 'malformed_envelope',
      });
    });

    it('rejects non-base64 fields (malformed_envelope)', async () => {
      const env = { ...makeBridgeToHubEnvelope(Buffer.from('x')), eph_pub: 'not base64!!!' };
      await expect(service.openBridgeToHub(env, { queueName: 'inbox' })).rejects.toMatchObject({
        reason: 'malformed_envelope',
      });
    });

    it('rejects a non-string zone_id (malformed_envelope, not key_unknown)', async () => {
      const base = makeBridgeToHubEnvelope(Buffer.from('x'));
      const env = { ...base, aad: { ...base.aad, zone_id: 12345 } };
      const error = await service.openBridgeToHub(env, { queueName: 'inbox' }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(SealOpenError);
      expect(error).not.toBeInstanceOf(SealKeyUnknownError);
      expect(error).toMatchObject({ reason: 'malformed_envelope' });
    });

    it('throws SealKeyUnknownError when the sending zone is not enrolled', async () => {
      const env = makeBridgeToHubEnvelope(Buffer.from('x'));
      mockRepo.findEnrollmentByZoneId.mockResolvedValue(null);
      await expect(service.openBridgeToHub(env, { queueName: 'inbox' })).rejects.toBeInstanceOf(SealKeyUnknownError);
    });

    it('throws SealKeyUnknownError when hub crypto is dormant', async () => {
      const env = makeBridgeToHubEnvelope(Buffer.from('x'));
      mockConfig.privateKey = null;
      await expect(service.openBridgeToHub(env, { queueName: 'inbox' })).rejects.toBeInstanceOf(SealKeyUnknownError);
    });

    it('processes a STALE result (freshness is advisory, not enforced)', async () => {
      const plaintext = Buffer.from(JSON.stringify({ ok: true }));
      const env = makeBridgeToHubEnvelope(plaintext, { created_at: Date.now() - 10 * 60_000 });
      const opened = await service.openBridgeToHub(env, { queueName: 'inbox' });
      expect(opened.plaintext.equals(plaintext)).toBe(true);
    });

    it('processes a FUTURE-SKEWED result (freshness advisory, future branch)', async () => {
      const plaintext = Buffer.from(JSON.stringify({ ok: true }));
      const env = makeBridgeToHubEnvelope(plaintext, { created_at: Date.now() + 10 * 60_000 });
      const opened = await service.openBridgeToHub(env, { queueName: 'inbox' });
      expect(opened.plaintext.equals(plaintext)).toBe(true);
    });

    it('rejects when the AAD zone_id resolves to a DIFFERENT (validly enrolled) zone — wrong zonePub ⇒ GCM fail (tamper)', async () => {
      const OTHER_ZONE = '00000000-0000-4000-8000-0000000000ff';
      const OTHER_PUB = derivePublicKey(rawPriv());
      mockRepo.findEnrollmentByZoneId.mockResolvedValue({ zoneId: OTHER_ZONE, zonePub: OTHER_PUB });
      const env = makeBridgeToHubEnvelope(Buffer.from('x'), { zone_id: OTHER_ZONE });
      await expect(service.openBridgeToHub(env, { queueName: 'inbox' })).rejects.toMatchObject({ reason: 'tamper' });
    });
  });

  describe('isZoneEnrolled (activation gate)', () => {
    it('true when the zone is enrolled', async () => {
      await expect(service.isZoneEnrolled(ZONE_ID)).resolves.toBe(true);
    });

    it('true when enrolled EVEN IF hub crypto is dormant — fail-closed is enforced at seal, not the gate', async () => {
      mockConfig.isAvailable = false;
      await expect(service.isZoneEnrolled(ZONE_ID)).resolves.toBe(true);
    });

    it('false when zone not enrolled', async () => {
      mockRepo.findEnrollmentByZoneId.mockResolvedValue(null);
      await expect(service.isZoneEnrolled(ZONE_ID)).resolves.toBe(false);
    });

    it('does NOT cache a miss — flips to enrolled on the very next call once enrolled', async () => {
      mockRepo.findEnrollmentByZoneId.mockResolvedValueOnce(null);
      await expect(service.isZoneEnrolled(ZONE_ID)).resolves.toBe(false);
      await expect(service.isZoneEnrolled(ZONE_ID)).resolves.toBe(true);
      expect(mockRepo.findEnrollmentByZoneId).toHaveBeenCalledTimes(2);
    });

    it('caches a positive — a populated zonePub is not re-queried within TTL', async () => {
      await expect(service.isZoneEnrolled(ZONE_ID)).resolves.toBe(true);
      await expect(service.isZoneEnrolled(ZONE_ID)).resolves.toBe(true);
      expect(mockRepo.findEnrollmentByZoneId).toHaveBeenCalledTimes(1);
    });
  });

  it('exposes hub-local SealOpenError with a reason taxonomy', () => {
    const err = new SealOpenError('x', { reason: 'tamper' });
    expect(err.reason).toBe('tamper');
  });
});
