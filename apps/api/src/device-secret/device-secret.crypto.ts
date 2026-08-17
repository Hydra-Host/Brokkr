import { deviceSecretAad, seal, type DeviceSecretAadFields } from '@repo/crypto';
import { Buffer } from 'node:buffer';

// Hub SEALS to zone_pub and cannot open (only the bridge holds zone_priv); AAD is derived from the row via the shared `deviceSecretAad`, never stored, so both sides reconstruct byte-identical AAD.

export type { DeviceSecretAadFields };

export interface SealedSecret {
  ephPub: Buffer;
  ciphertext: Buffer;
  tag: Buffer;
}

export function sealDeviceSecret(
  hubPriv: Buffer,
  zonePub: Buffer,
  plaintext: Buffer,
  aadFields: DeviceSecretAadFields,
): SealedSecret {
  const sealed = seal(hubPriv, zonePub, plaintext, deviceSecretAad(aadFields));
  return { ephPub: sealed.ephPub, ciphertext: sealed.ciphertext, tag: sealed.tag };
}
