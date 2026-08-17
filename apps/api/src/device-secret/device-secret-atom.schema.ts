import { DeviceSecretKind, DeviceSecretPurpose } from '@repo/database';
import { z } from 'zod';

// Sealed auth-DH ciphertext, never plaintext (the hub writes it; only the zone's bridge can open it); fields mirror `SealedSecretEnvelope` so the bridge re-derives byte-identical AAD, and `.strict()` makes contract drift fail closed.
export const DeviceSecretAtomSchema = z
  .object({
    zoneId: z
      .string()
      .uuid()
      .describe('Custody zone the secret was sealed to; bound into the AAD the bridge re-derives.'),
    zoneKeyId: z
      .string()
      .uuid()
      .describe('ZoneEnrollment.id whose zone_pub sealed the blob; the bridge selects the matching zone_priv with it.'),
    deviceId: z.string().uuid().describe('Device the credential belongs to; bound into the AAD.'),
    purpose: z
      .nativeEnum(DeviceSecretPurpose)
      .describe('What the credential authenticates to (e.g. BMC); bound into the AAD.'),
    kind: z
      .nativeEnum(DeviceSecretKind)
      .describe('Decrypted shape of the sealed plaintext (e.g. USER = {user,pass}); bound into the AAD.'),
    keyGen: z
      .number()
      .int()
      .nonnegative()
      .describe('ZoneEnrollment.generation at seal time; a zone re-key supersedes this and invalidates the secret.'),
    ephPub: z.string().base64().describe('Sender ephemeral X25519 public key (base64); the nonce is derived from it.'),
    ciphertext: z
      .string()
      .base64()
      .describe(
        'AEAD ciphertext of the credential plaintext (base64) — the sealed username/password, never cleartext.',
      ),
    tag: z.string().base64().describe('AEAD authentication tag (base64) verifying ciphertext + AAD integrity.'),
  })
  .strict();

export type DeviceSecretAtom = z.infer<typeof DeviceSecretAtomSchema>;
