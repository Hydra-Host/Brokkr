import { Buffer } from 'node:buffer';
import { createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';

export const X25519_PKCS8_PRIV_PREFIX = Buffer.from([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20,
]);
export const X25519_SPKI_PUB_PREFIX = Buffer.from([
  0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x03, 0x21, 0x00,
]);

export function privKeyFromRaw(raw: Buffer): KeyObject {
  return createPrivateKey({
    key: Buffer.concat([X25519_PKCS8_PRIV_PREFIX, raw]),
    format: 'der',
    type: 'pkcs8',
  });
}

export function pubKeyFromRaw(raw: Buffer): KeyObject {
  return createPublicKey({
    key: Buffer.concat([X25519_SPKI_PUB_PREFIX, raw]),
    format: 'der',
    type: 'spki',
  });
}

export function rawPub(key: KeyObject): Buffer {
  const der = key.export({ format: 'der', type: 'spki' });
  return Buffer.from(der.subarray(X25519_SPKI_PUB_PREFIX.length));
}
