import { Buffer } from 'node:buffer';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  type KeyObject,
} from 'node:crypto';

import { SealOpenError } from './errors';
import { privKeyFromRaw, pubKeyFromRaw, rawPub } from './keys';

export const INFO: Buffer = Buffer.from('brokkr-auth-dh-v1', 'utf8');
export const KEY_SIZE = 32;
export const AES_KEY_SIZE = 32;
export const NONCE_SIZE = 12;
export const TAG_SIZE = 16;

export interface SealedEnvelope {
  ephPub: Buffer;
  ciphertext: Buffer;
  tag: Buffer;
}

export function derivePublicKey(privateKey: Buffer): Buffer {
  return rawPub(createPublicKey(privKeyFromRaw(privateKey)));
}

function deriveAesKey(ikm: Buffer, aad: Buffer): Buffer {
  const salt = createHash('sha256').update(aad).digest();
  return Buffer.from(hkdfSync('sha256', ikm, salt, INFO, AES_KEY_SIZE));
}

function deriveNonce(ephPub: Buffer): Buffer {
  return createHash('sha256').update(ephPub).digest().subarray(0, NONCE_SIZE);
}

function sealCore(
  ephPrivKey: KeyObject,
  ephPub: Buffer,
  senderPriv: Buffer,
  recipientPub: Buffer,
  plaintext: Buffer,
  aad: Buffer,
): SealedEnvelope {
  // Coerce raw node:crypto errors (bad key length/point) to the leak-free SealOpenError — same guarantee as open().
  try {
    const senderPrivKey = privKeyFromRaw(senderPriv);
    const recipientPubKey = pubKeyFromRaw(recipientPub);

    const sharedE = diffieHellman({ privateKey: ephPrivKey, publicKey: recipientPubKey });
    const sharedS = diffieHellman({ privateKey: senderPrivKey, publicKey: recipientPubKey });
    const ikm = Buffer.concat([sharedE, sharedS]);

    const aesKey = deriveAesKey(ikm, aad);
    const nonce = deriveNonce(ephPub);

    const cipher = createCipheriv('aes-256-gcm', aesKey, nonce, { authTagLength: TAG_SIZE });
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();

    return { ephPub, ciphertext, tag };
  } catch (error) {
    if (error instanceof SealOpenError) throw error;
    throw new SealOpenError('malformed seal input', {}, { cause: error });
  }
}

export function seal(senderPriv: Buffer, recipientPub: Buffer, plaintext: Buffer, aad: Buffer): SealedEnvelope {
  const { privateKey, publicKey } = generateKeyPairSync('x25519');
  return sealCore(privateKey, rawPub(publicKey), senderPriv, recipientPub, plaintext, aad);
}

export function sealWithEphemeral(
  ephPriv: Buffer,
  senderPriv: Buffer,
  recipientPub: Buffer,
  plaintext: Buffer,
  aad: Buffer,
): SealedEnvelope {
  const ephPrivKey = privKeyFromRaw(ephPriv);
  const ephPub = rawPub(createPublicKey(ephPrivKey));
  return sealCore(ephPrivKey, ephPub, senderPriv, recipientPub, plaintext, aad);
}

export function open(
  recipientPriv: Buffer,
  senderPub: Buffer,
  ephPub: Buffer,
  ciphertext: Buffer,
  tag: Buffer,
  aad: Buffer,
): Buffer {
  let decipher;
  try {
    const recipientPrivKey = privKeyFromRaw(recipientPriv);
    const senderPubKey = pubKeyFromRaw(senderPub);
    const ephPubKey = pubKeyFromRaw(ephPub);

    const sharedE = diffieHellman({ privateKey: recipientPrivKey, publicKey: ephPubKey });
    const sharedS = diffieHellman({ privateKey: recipientPrivKey, publicKey: senderPubKey });
    const ikm = Buffer.concat([sharedE, sharedS]);

    const aesKey = deriveAesKey(ikm, aad);
    const nonce = deriveNonce(ephPub);

    decipher = createDecipheriv('aes-256-gcm', aesKey, nonce, { authTagLength: TAG_SIZE });
    decipher.setAAD(aad);
    if (tag.length !== TAG_SIZE) throw new SealOpenError('malformed seal input');
    decipher.setAuthTag(tag);
  } catch (error) {
    if (error instanceof SealOpenError) throw error;
    throw new SealOpenError('malformed seal input', {}, { cause: error });
  }

  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (error) {
    throw new SealOpenError('AES-GCM tag verification failed', {}, { cause: error });
  }
}
