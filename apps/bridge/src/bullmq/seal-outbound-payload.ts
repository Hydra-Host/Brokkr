import { canonicalizeAad, SealOpenError as CryptoSealOpenError, seal } from '@repo/crypto';

import { SealOpenError } from '../zone-crypto/auth-dh.types';
import { REASON_SEAL_FAILED } from '../zone-crypto/sealed-envelope.types';

export const CURRENT_AAD_VERSION = 1;
export const CURRENT_ENVELOPE_VERSION = 1;
export const DIRECTION_BRIDGE_TO_HUB = 'bridge_to_hub';

export interface ZoneCryptoState {
  zonePriv: Buffer;
  hubPub: Buffer;
  zoneId: string;
}

export interface SealedAad {
  aad_v: number;
  zone_id: string;
  queue_name: string;
  direction: string;
  job_id: string;
  created_at: number;
}

export interface SealedEnvelope {
  envelope_v: number;
  aad: SealedAad;
  eph_pub: string;
  ciphertext: string;
  tag: string;
}

export interface SealOutboundOptions {
  queueName: string;
  aadJobId: string;
  nowMs?: number | null;
  zoneCrypto?: ZoneCryptoState | null;
  now?: () => number;
}

export function sealOutboundPayload<T extends object>(payload: T, opts: SealOutboundOptions): T | SealedEnvelope {
  const { zoneCrypto = null } = opts;
  if (zoneCrypto === null) return payload;

  const nowMs = opts.nowMs ?? (opts.now ? opts.now() : Date.now());
  const aadFields: SealedAad = {
    aad_v: CURRENT_AAD_VERSION,
    zone_id: zoneCrypto.zoneId,
    queue_name: opts.queueName,
    direction: DIRECTION_BRIDGE_TO_HUB,
    job_id: opts.aadJobId,
    created_at: nowMs,
  };
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf-8');
  return sealBridgeToHub(plaintext, aadFields, zoneCrypto);
}

export function sealBridgeToHub(plaintext: Buffer, aadFields: SealedAad, zoneCrypto: ZoneCryptoState): SealedEnvelope {
  const aadBytes = canonicalizeAad(aadFields);
  let sealed;
  try {
    sealed = seal(zoneCrypto.zonePriv, zoneCrypto.hubPub, plaintext, aadBytes);
  } catch (error) {
    if (error instanceof CryptoSealOpenError) {
      throw new SealOpenError(error.message, {
        reason: REASON_SEAL_FAILED,
        zoneId: aadFields.zone_id,
        jobId: aadFields.job_id,
        direction: aadFields.direction,
      });
    }
    throw error;
  }
  return {
    envelope_v: CURRENT_ENVELOPE_VERSION,
    aad: { ...aadFields },
    eph_pub: sealed.ephPub.toString('base64'),
    ciphertext: sealed.ciphertext.toString('base64'),
    tag: sealed.tag.toString('base64'),
  };
}
