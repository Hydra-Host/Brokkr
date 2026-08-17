import { Injectable } from '@nestjs/common';
import {
  canonicalizeAad,
  open as cryptoOpen,
  seal as cryptoSeal,
  SealOpenError as CryptoSealOpenError,
  TAG_SIZE,
  type SealedEnvelope,
} from '@repo/crypto';
import { isRecord } from '@repo/utils';

import { SealKeyUnknownError, SealOpenError } from './auth-dh.types';
import {
  CURRENT_ENVELOPE_VERSION,
  DIRECTION_BRIDGE_TO_HUB,
  DIRECTION_HUB_TO_BRIDGE,
  Envelope,
  ExpectedRouting,
  FRESHNESS_WINDOW_MS,
  REASON_FUTURE_SKEW,
  REASON_KEY_UNKNOWN,
  REASON_MALFORMED_ENVELOPE,
  REASON_ROUTING_MISMATCH,
  REASON_SEAL_FAILED,
  REASON_STALE,
  REASON_TAMPER,
  SKEW_TOLERANCE_MS,
} from './sealed-envelope.types';
import { ZoneCryptoService } from './zone-crypto.service';

function isSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

function safeStr(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

interface WrapCryptoErrorInit {
  reason: string;
  zoneId?: string | null;
  jobId?: string | null;
  direction: string;
}

function wrapCryptoError(error: unknown, init: WrapCryptoErrorInit): never {
  if (error instanceof CryptoSealOpenError) {
    throw new SealOpenError(error.message, {
      reason: init.reason,
      zoneId: init.zoneId ?? null,
      jobId: init.jobId ?? null,
      direction: init.direction,
    });
  }
  throw error;
}

function isBase64(value: string): boolean {
  if (value.length === 0) return true;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  if (value.length % 4 !== 0) return false;
  return true;
}

function b64DecodeField(envelope: Record<string, unknown>, field: string): Buffer {
  const value = envelope[field];
  if (typeof value !== 'string') {
    throw new SealOpenError(`envelope.${field} must be base64 str, got ${typeof value}`, {
      reason: REASON_MALFORMED_ENVELOPE,
    });
  }
  if (!isBase64(value)) {
    throw new SealOpenError(`envelope.${field} is not valid base64`, {
      reason: REASON_MALFORMED_ENVELOPE,
    });
  }
  return Buffer.from(value, 'base64');
}

function validateEnvelopeShape(envelope: unknown): Record<string, unknown> {
  if (!isRecord(envelope)) {
    const typeName = Array.isArray(envelope) ? 'array' : envelope === null ? 'null' : typeof envelope;
    throw new SealOpenError(`envelope must be a plain object, got ${typeName}`, {
      reason: REASON_MALFORMED_ENVELOPE,
    });
  }
  const envelopeV = envelope.envelope_v;
  const envelopeVNumeric = typeof envelopeV === 'boolean' ? Number(envelopeV) : envelopeV;
  if (envelopeVNumeric !== CURRENT_ENVELOPE_VERSION) {
    throw new SealOpenError(
      `unsupported envelope_v: ${JSON.stringify(envelopeV)} (expected ${CURRENT_ENVELOPE_VERSION})`,
      { reason: REASON_MALFORMED_ENVELOPE },
    );
  }
  for (const field of ['aad', 'eph_pub', 'ciphertext', 'tag']) {
    if (!(field in envelope)) {
      throw new SealOpenError(`envelope missing required field: ${field}`, {
        reason: REASON_MALFORMED_ENVELOPE,
      });
    }
  }
  const aadFields = envelope.aad;
  if (!isRecord(aadFields)) {
    const typeName = Array.isArray(aadFields) ? 'array' : aadFields === null ? 'null' : typeof aadFields;
    throw new SealOpenError(`envelope.aad must be a plain object, got ${typeName}`, {
      reason: REASON_MALFORMED_ENVELOPE,
    });
  }
  return aadFields;
}

interface ValidateRoutingArgs {
  expectedZoneId: string;
  expectedQueueName: string;
  expectedDirection: string;
}

function validateRouting(aadFields: Record<string, unknown>, args: ValidateRoutingArgs): void {
  const actualZoneId = aadFields.zone_id;
  if (actualZoneId !== args.expectedZoneId) {
    throw new SealOpenError(
      `AAD zone_id mismatch: expected '${args.expectedZoneId}', got ${JSON.stringify(actualZoneId)}`,
      { zoneId: safeStr(actualZoneId), reason: REASON_ROUTING_MISMATCH },
    );
  }
  const actualQueueName = aadFields.queue_name;
  if (actualQueueName !== args.expectedQueueName) {
    throw new SealOpenError(
      `AAD queue_name mismatch: expected '${args.expectedQueueName}', got ${JSON.stringify(actualQueueName)}`,
      { zoneId: args.expectedZoneId, reason: REASON_ROUTING_MISMATCH },
    );
  }
  const actualDirection = aadFields.direction;
  if (actualDirection !== args.expectedDirection) {
    throw new SealOpenError(
      `AAD direction mismatch: expected '${args.expectedDirection}', got ${JSON.stringify(actualDirection)}`,
      {
        zoneId: args.expectedZoneId,
        direction: safeStr(actualDirection),
        reason: REASON_ROUTING_MISMATCH,
      },
    );
  }
}

function validateFreshness(aadFields: Record<string, unknown>, nowMs: number): void {
  const createdAt = aadFields.created_at;
  if (typeof createdAt === 'boolean' || !isSafeInteger(createdAt)) {
    const typeName = createdAt === null ? 'null' : typeof createdAt;
    throw new SealOpenError(`AAD created_at must be int (Unix millis), got ${typeName}`, {
      zoneId: safeStr(aadFields.zone_id),
      reason: REASON_MALFORMED_ENVELOPE,
    });
  }
  const ageMs = nowMs - createdAt;
  if (ageMs > FRESHNESS_WINDOW_MS) {
    throw new SealOpenError(`envelope is stale: age=${ageMs}ms exceeds freshness window ${FRESHNESS_WINDOW_MS}ms`, {
      zoneId: safeStr(aadFields.zone_id),
      jobId: safeStr(aadFields.job_id),
      reason: REASON_STALE,
    });
  }
  if (ageMs < -SKEW_TOLERANCE_MS) {
    throw new SealOpenError(`envelope is from the future: skew=${-ageMs}ms exceeds tolerance ${SKEW_TOLERANCE_MS}ms`, {
      zoneId: safeStr(aadFields.zone_id),
      jobId: safeStr(aadFields.job_id),
      reason: REASON_FUTURE_SKEW,
    });
  }
}

export interface OpenHubToBridgeOptions {
  nowMs?: number;
}

@Injectable()
export class SealedEnvelopeService {
  constructor(private readonly zoneCrypto: ZoneCryptoService) {}

  sealBridgeToHub(plaintext: Buffer, aadFields: Record<string, unknown>): Envelope {
    const state = this.zoneCrypto.get();
    if (state === null) {
      throw new SealKeyUnknownError('zone_crypto not loaded; cannot seal bridge_to_hub envelope', {
        direction: DIRECTION_BRIDGE_TO_HUB,
        reason: REASON_KEY_UNKNOWN,
      });
    }
    const aadBytes = canonicalizeAad(aadFields);
    let sealed: SealedEnvelope;
    try {
      sealed = cryptoSeal(state.zonePriv, state.hubPub, plaintext, aadBytes);
    } catch (error) {
      wrapCryptoError(error, {
        reason: REASON_SEAL_FAILED,
        zoneId: safeStr(aadFields.zone_id),
        jobId: safeStr(aadFields.job_id),
        direction: DIRECTION_BRIDGE_TO_HUB,
      });
    }
    return {
      envelope_v: CURRENT_ENVELOPE_VERSION,
      aad: { ...aadFields },
      eph_pub: sealed.ephPub.toString('base64'),
      ciphertext: sealed.ciphertext.toString('base64'),
      tag: sealed.tag.toString('base64'),
    };
  }

  openHubToBridge(envelope: unknown, expectedRouting: ExpectedRouting, options: OpenHubToBridgeOptions = {}): Buffer {
    const state = this.zoneCrypto.get();
    if (state === null) {
      throw new SealKeyUnknownError('zone_crypto not loaded; cannot open hub_to_bridge envelope', {
        direction: DIRECTION_HUB_TO_BRIDGE,
        reason: REASON_KEY_UNKNOWN,
      });
    }
    return openHubToBridgeImpl(envelope, expectedRouting, options, state.zonePriv, state.hubPub);
  }
}

export function openHubToBridgeImpl(
  envelope: unknown,
  expectedRouting: ExpectedRouting,
  options: OpenHubToBridgeOptions,
  recipientPriv: Buffer,
  senderPub: Buffer,
): Buffer {
  const aadFields = validateEnvelopeShape(envelope);
  validateRouting(aadFields, {
    expectedZoneId: expectedRouting.zoneId,
    expectedQueueName: expectedRouting.queueName,
    expectedDirection: DIRECTION_HUB_TO_BRIDGE,
  });
  const nowMs = options.nowMs ?? Date.now();
  validateFreshness(aadFields, nowMs);

  let aadBytes: Buffer;
  try {
    aadBytes = canonicalizeAad(aadFields);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new SealOpenError(`envelope AAD failed canonicalisation: ${message}`, {
      zoneId: safeStr(aadFields.zone_id),
      jobId: safeStr(aadFields.job_id),
      direction: DIRECTION_HUB_TO_BRIDGE,
      reason: REASON_MALFORMED_ENVELOPE,
    });
  }

  const envObj = envelope as Record<string, unknown>;
  const ephPub = b64DecodeField(envObj, 'eph_pub');
  const ciphertext = b64DecodeField(envObj, 'ciphertext');
  const tag = b64DecodeField(envObj, 'tag');

  // Reject bad-length GCM tags here so a malformed tag classifies as MALFORMED_ENVELOPE (not TAMPER) and never reaches the crypto primitive's auth check.
  if (tag.length !== TAG_SIZE) {
    throw new SealOpenError('envelope tag has invalid length', {
      reason: REASON_MALFORMED_ENVELOPE,
      zoneId: safeStr(aadFields.zone_id),
      jobId: safeStr(aadFields.job_id),
      direction: DIRECTION_HUB_TO_BRIDGE,
    });
  }

  try {
    return cryptoOpen(recipientPriv, senderPub, ephPub, ciphertext, tag, aadBytes);
  } catch (error) {
    wrapCryptoError(error, {
      reason: REASON_TAMPER,
      zoneId: safeStr(aadFields.zone_id),
      jobId: safeStr(aadFields.job_id),
      direction: DIRECTION_HUB_TO_BRIDGE,
    });
  }
}
