import { open as cryptoOpen, deviceSecretAad } from '@repo/crypto';
import { Buffer } from 'node:buffer';
import { z } from 'zod';
import { getActiveZoneCryptoSnapshot } from './zone-crypto.service';

export const forwardedSecretSchema = z.object({
  zoneId: z.string(),
  zoneKeyId: z.string(),
  deviceId: z.string(),
  purpose: z.string(),
  kind: z.string(),
  keyGen: z.number().int(),
  ephPub: z.string(),
  ciphertext: z.string(),
  tag: z.string(),
});
export type ForwardedSecret = z.infer<typeof forwardedSecretSchema>;

const bmcSecretPlaintextSchema = z
  .object({
    user: z.string().min(1),
    pass: z.string().min(1),
  })
  .strict();

export interface OpenedBmcSecret {
  username: string;
  password: string;
}

/** INNER decrypt of a cred-saga's two layers (the OUTER wire envelope is SealedEnvelopeService.openHubToBridge); same zone keypair, but the AADs are domain-separated so the layers can never be confused. */
export function openBmcSecret(blob: ForwardedSecret): OpenedBmcSecret {
  const plaintext = bmcSecretPlaintextSchema.parse(openForwardedSecret(blob));
  return { username: plaintext.user, password: plaintext.pass };
}

export function openForwardedSecret(blob: ForwardedSecret): Record<string, string> {
  const snapshot = getActiveZoneCryptoSnapshot();
  if (snapshot === null) {
    throw new Error('zone_crypto not loaded; cannot open device secret');
  }
  const plaintext = cryptoOpen(
    snapshot.zonePriv,
    snapshot.hubPub,
    Buffer.from(blob.ephPub, 'base64'),
    Buffer.from(blob.ciphertext, 'base64'),
    Buffer.from(blob.tag, 'base64'),
    deviceSecretAad({
      zoneId: blob.zoneId,
      zoneKeyId: blob.zoneKeyId,
      deviceId: blob.deviceId,
      purpose: blob.purpose,
      kind: blob.kind,
      keyGen: blob.keyGen,
    }),
  );
  return z.record(z.string()).parse(JSON.parse(plaintext.toString('utf8')));
}
