import { derivePublicKey, deviceSecretAad, seal, type DeviceSecretAadFields } from '@repo/crypto';
import { Buffer } from 'node:buffer';
import { generateKeyPairSync } from 'node:crypto';

import type { ForwardedSecret } from '../../../zone-crypto/device-secret-open.js';
import {
  clearActiveZoneCryptoSnapshot,
  setActiveZoneCryptoSnapshot,
  type ZoneCryptoSnapshot,
} from '../../../zone-crypto/zone-crypto.service.js';

function genPriv(): Buffer {
  return Buffer.from(generateKeyPairSync('x25519').privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32));
}

const hubPriv = genPriv();
const hubPub = derivePublicKey(hubPriv);
const zonePriv = genPriv();
const zonePub = derivePublicKey(zonePriv);

export const ZONE_CRYPTO_SNAPSHOT: ZoneCryptoSnapshot = { zonePriv, zonePub, hubPub, enrolledAt: 1_730_000_000_000 };

const AAD_FIELDS: DeviceSecretAadFields = {
  zoneId: '00000000-0000-0000-0000-000000000001',
  zoneKeyId: '00000000-0000-0000-0000-0000000000e1',
  deviceId: '00000000-0000-0000-0000-0000000000aa',
  purpose: 'BMC',
  kind: 'USER',
  keyGen: 1,
};

export function installZoneCrypto(): void {
  setActiveZoneCryptoSnapshot(ZONE_CRYPTO_SNAPSHOT);
}

export function clearZoneCrypto(): void {
  clearActiveZoneCryptoSnapshot();
}

export function sealedBmc(
  plaintext: { user: string; pass: string } = { user: 'admin', pass: 'secret' },
): ForwardedSecret {
  const sealed = seal(hubPriv, zonePub, Buffer.from(JSON.stringify(plaintext), 'utf8'), deviceSecretAad(AAD_FIELDS));
  return {
    ...AAD_FIELDS,
    ephPub: sealed.ephPub.toString('base64'),
    ciphertext: sealed.ciphertext.toString('base64'),
    tag: sealed.tag.toString('base64'),
  };
}

export function sealedBmcPayload(
  plaintext: { user: string; pass: string } = { user: 'admin', pass: 'secret' },
  bmcIp = '10.0.0.5',
): { bmc_ip: string; secrets: { bmc: ForwardedSecret } } {
  return { bmc_ip: bmcIp, secrets: { bmc: sealedBmc(plaintext) } };
}

export function sealedCredPayload(opts: { bmcIp?: string; user?: string; pass?: string } = {}): {
  bmc_ip: string;
  secrets: { bmc: ForwardedSecret };
} {
  return sealedBmcPayload({ user: opts.user ?? 'admin', pass: opts.pass ?? 'secret' }, opts.bmcIp ?? '10.0.0.9');
}
