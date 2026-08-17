import { Injectable } from '@nestjs/common';
import { type Aad, SealOpenError as CryptoSealOpenError, canonicalizeAad, open, seal } from '@repo/crypto';
import { Buffer } from 'node:buffer';
import { Logger } from 'src/common/decorators/logger.decorator';
import { getErrorMessage } from 'src/common/error-utils';
import { LoggerService } from 'src/logger/logger.service';
import { z } from 'zod';
import { ZoneCryptoConfig } from '../zone-crypto/zone-crypto.config';
import { ZoneCryptoRepository } from '../zone-crypto/zone-crypto.repository';
import { SealKeyUnknownError, SealOpenError } from './sealed-envelope.types';

// Replay windows: created_at is AAD-bound; advisory on bridge→hub (see warnIfStale), strict on the hub→bridge command path (enforced bridge-side).
const FRESHNESS_WINDOW_MS = 300_000;
const SKEW_TOLERANCE_MS = 60_000;

const CURRENT_ENVELOPE_VERSION = 1;

const ZONE_PUB_CACHE_TTL_MS = 30_000;

const base64String = z.string();

const envelopeSchema = z.object({
  envelope_v: z.literal(CURRENT_ENVELOPE_VERSION),
  aad: z.record(z.unknown()),
  eph_pub: base64String,
  ciphertext: base64String,
  tag: base64String,
});

export type EnvelopeJson = {
  envelope_v: typeof CURRENT_ENVELOPE_VERSION;
  aad: Aad;
  eph_pub: string;
  ciphertext: string;
  tag: string;
};

export interface OpenedBridgeEnvelope {
  plaintext: Buffer;
  zoneId: string;
}

type ZonePubCacheEntry = { zonePub: Buffer; expiresAt: number };

@Injectable()
export class SealedEnvelopeService {
  private readonly zonePubCache = new Map<string, ZonePubCacheEntry>();

  constructor(
    private readonly config: ZoneCryptoConfig,
    private readonly repository: ZoneCryptoRepository,
    @Logger(SealedEnvelopeService.name) private readonly logger: LoggerService,
  ) {}

  async sealHubToBridge(zoneId: string, plaintext: Buffer, aadFields: Aad): Promise<EnvelopeJson> {
    if (aadFields.direction !== 'hub_to_bridge') {
      throw new SealOpenError(`sealHubToBridge requires direction hub_to_bridge, got ${aadFields.direction}`, {
        zoneId,
        direction: aadFields.direction,
        reason: 'routing_mismatch',
      });
    }

    const hubPriv = this.config.privateKey;
    const zonePub = await this.lookupZonePub(zoneId);
    if (hubPriv === null || zonePub === null) {
      throw new SealKeyUnknownError('no enrollment or hub crypto dormant; cannot seal hub_to_bridge', {
        zoneId,
        jobId: aadFields.job_id,
        direction: 'hub_to_bridge',
      });
    }

    const aadBytes = canonicalizeAad(aadFields);
    const sealed = seal(hubPriv, zonePub, plaintext, aadBytes);

    return {
      envelope_v: CURRENT_ENVELOPE_VERSION,
      aad: aadFields,
      eph_pub: sealed.ephPub.toString('base64'),
      ciphertext: sealed.ciphertext.toString('base64'),
      tag: sealed.tag.toString('base64'),
    };
  }

  async openBridgeToHub(envelope: unknown, expectedRouting: { queueName: string }): Promise<OpenedBridgeEnvelope> {
    const parsed = envelopeSchema.safeParse(envelope);
    if (!parsed.success) {
      throw new SealOpenError(`malformed envelope: ${parsed.error.message}`, { reason: 'malformed_envelope' });
    }
    const { aad } = parsed.data;

    this.validateRouting(aad, expectedRouting.queueName);
    this.warnIfStale(aad);

    if (typeof aad.zone_id !== 'string') {
      throw new SealOpenError(`AAD zone_id is missing or not a string`, { reason: 'malformed_envelope' });
    }
    const zoneId = aad.zone_id;
    const jobId = typeof aad.job_id === 'string' ? aad.job_id : undefined;

    const hubPriv = this.config.privateKey;
    const zonePub = await this.lookupZonePub(zoneId);
    if (hubPriv === null || zonePub === null) {
      throw new SealKeyUnknownError('no enrollment or hub crypto dormant; cannot open bridge_to_hub', {
        zoneId,
        jobId,
        direction: 'bridge_to_hub',
      });
    }

    let aadBytes: Buffer;
    try {
      aadBytes = canonicalizeAad(aad);
    } catch (error) {
      throw new SealOpenError(
        `envelope AAD failed canonicalization: ${getErrorMessage(error)}`,
        { zoneId, jobId, direction: 'bridge_to_hub', reason: 'malformed_envelope' },
        { cause: error },
      );
    }

    const ephPub = decodeBase64(parsed.data.eph_pub, 'eph_pub');
    const ciphertext = decodeBase64(parsed.data.ciphertext, 'ciphertext');
    const tag = decodeBase64(parsed.data.tag, 'tag');

    try {
      return { plaintext: open(hubPriv, zonePub, ephPub, ciphertext, tag, aadBytes), zoneId };
    } catch (error) {
      if (error instanceof CryptoSealOpenError) {
        throw new SealOpenError(
          error.message,
          { zoneId, jobId, direction: 'bridge_to_hub', reason: 'tamper' },
          { cause: error },
        );
      }
      throw new SealOpenError(
        `cryptographic open failed: ${getErrorMessage(error)}`,
        { zoneId, jobId, direction: 'bridge_to_hub', reason: 'tamper' },
        { cause: error },
      );
    }
  }

  // Deliberately does NOT check hub-key availability — folding that in caused a fail-OPEN (dormant key downgraded outbound BMC creds to plaintext); seal()/open() enforce it fail-closed.
  async isZoneEnrolled(zoneId: string): Promise<boolean> {
    return (await this.lookupZonePub(zoneId)) !== null;
  }

  private async lookupZonePub(zoneId: string): Promise<Buffer | null> {
    const now = Date.now();
    const cached = this.zonePubCache.get(zoneId);
    if (cached && cached.expiresAt > now) {
      return cached.zonePub;
    }

    const enrollment = await this.repository.findEnrollmentByZoneId(zoneId);
    if (!enrollment) return null;
    const zonePub = Buffer.from(enrollment.zonePub);
    this.zonePubCache.set(zoneId, { zonePub, expiresAt: now + ZONE_PUB_CACHE_TTL_MS });
    return zonePub;
  }

  private validateRouting(aad: Record<string, unknown>, expectedQueueName: string): void {
    if (aad.direction !== 'bridge_to_hub') {
      throw new SealOpenError(`AAD direction mismatch: expected bridge_to_hub, got ${stringify(aad.direction)}`, {
        zoneId: typeof aad.zone_id === 'string' ? aad.zone_id : undefined,
        reason: 'routing_mismatch',
      });
    }
    if (aad.queue_name !== expectedQueueName) {
      throw new SealOpenError(
        `AAD queue_name mismatch: expected ${expectedQueueName}, got ${stringify(aad.queue_name)}`,
        {
          zoneId: typeof aad.zone_id === 'string' ? aad.zone_id : undefined,
          direction: 'bridge_to_hub',
          reason: 'routing_mismatch',
        },
      );
    }
  }

  private warnIfStale(aad: Record<string, unknown>): void {
    const createdAt = aad.created_at;
    if (typeof createdAt !== 'number' || !Number.isInteger(createdAt)) return;

    const zoneId = typeof aad.zone_id === 'string' ? aad.zone_id : 'unknown';
    const jobId = typeof aad.job_id === 'string' ? aad.job_id : 'unknown';
    const ageMs = Date.now() - createdAt;
    if (ageMs > FRESHNESS_WINDOW_MS) {
      this.logger.warn(
        `zone-crypto: processing STALE bridge→hub result (reason=stale) age=${ageMs}ms exceeds window ${FRESHNESS_WINDOW_MS}ms zone=${zoneId} job=${jobId}`,
      );
    } else if (ageMs < -SKEW_TOLERANCE_MS) {
      this.logger.warn(
        `zone-crypto: processing FUTURE-SKEWED bridge→hub result (reason=future_skew) skew=${-ageMs}ms exceeds tolerance ${SKEW_TOLERANCE_MS}ms zone=${zoneId} job=${jobId}`,
      );
    }
  }
}

function decodeBase64(value: string, field: string): Buffer {
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64').replace(/=+$/, '') !== value.replace(/=+$/, '')) {
    throw new SealOpenError(`envelope.${field} is not valid base64`, { reason: 'malformed_envelope' });
  }
  return decoded;
}

function stringify(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}
