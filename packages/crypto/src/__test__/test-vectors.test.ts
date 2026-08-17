import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { canonicalizeAad } from '../aad';
import { AES_KEY_SIZE, INFO, NONCE_SIZE, TAG_SIZE, open } from '../auth-dh';
import { __test_only__ } from '../test-only';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CORPUS_PATH = resolve(__dirname, '..', '..', 'test-vectors', 'auth-dh-v1.json');

const EXPECTED_CORPUS_SHA256 = '610bc89afacf9ecb28332a17009eaa4a4efaa90387fc7ff70efbebbb9294dc33';

interface VectorInputs {
  sender_priv: string;
  sender_pub: string;
  recipient_priv: string;
  recipient_pub: string;
  eph_priv: string;
  plaintext: string;
  aad_obj: Record<string, unknown>;
}

interface VectorIntermediates {
  canonical_aad: string;
  hkdf_salt: string;
  aes_key: string;
  nonce: string;
}

interface VectorExpected {
  eph_pub: string;
  ciphertext: string;
  tag: string;
}

interface Vector {
  name: string;
  inputs: VectorInputs;
  intermediates: VectorIntermediates;
  expected: VectorExpected;
}

interface Corpus {
  version: string;
  envelope_v: number;
  aad_v: number;
  info: string;
  constants: Record<string, string | number>;
  comment: string;
  vectors: Vector[];
}

const corpusBytes = readFileSync(CORPUS_PATH);
const corpus: Corpus = JSON.parse(corpusBytes.toString('utf8'));

describe('corpus integrity', () => {
  it('SHA-256 hash matches expected', () => {
    const actual = createHash('sha256').update(corpusBytes).digest('hex');
    expect(actual).toBe(EXPECTED_CORPUS_SHA256);
  });

  it('declares expected constants', () => {
    expect(corpus.version).toBe('auth-dh-v1');
    expect(corpus.envelope_v).toBe(1);
    expect(corpus.aad_v).toBe(1);
    expect(Buffer.from(corpus.info, 'hex').equals(INFO)).toBe(true);
    expect(corpus.constants['aes_key_size']).toBe(AES_KEY_SIZE);
    expect(corpus.constants['nonce_size']).toBe(NONCE_SIZE);
    expect(corpus.constants['tag_size']).toBe(TAG_SIZE);
    expect(corpus.constants['curve']).toBe('x25519');
    expect(corpus.constants['aead']).toBe('aes-256-gcm');
    expect(corpus.constants['hkdf_hash']).toBe('sha256');
  });

  it('contains at least one vector', () => {
    expect(corpus.vectors.length).toBeGreaterThan(0);
  });
});

describe.each(corpus.vectors)('vector parity — $name', (vector) => {
  it('canonical AAD bytes match', () => {
    const actual = canonicalizeAad(vector.inputs.aad_obj);
    expect(actual.toString('hex')).toBe(vector.intermediates.canonical_aad);
  });

  it('HKDF salt matches', () => {
    const canonicalAad = Buffer.from(vector.intermediates.canonical_aad, 'hex');
    const actual = createHash('sha256').update(canonicalAad).digest('hex');
    expect(actual).toBe(vector.intermediates.hkdf_salt);
  });

  it('nonce matches', () => {
    const ephPub = Buffer.from(vector.expected.eph_pub, 'hex');
    const actual = createHash('sha256').update(ephPub).digest().subarray(0, NONCE_SIZE).toString('hex');
    expect(actual).toBe(vector.intermediates.nonce);
  });

  it('sealWithEphemeral produces expected bytes', () => {
    const sealed = __test_only__.sealWithEphemeral(
      Buffer.from(vector.inputs.eph_priv, 'hex'),
      Buffer.from(vector.inputs.sender_priv, 'hex'),
      Buffer.from(vector.inputs.recipient_pub, 'hex'),
      Buffer.from(vector.inputs.plaintext, 'hex'),
      Buffer.from(vector.intermediates.canonical_aad, 'hex'),
    );
    expect(sealed.ephPub.toString('hex')).toBe(vector.expected.eph_pub);
    expect(sealed.ciphertext.toString('hex')).toBe(vector.expected.ciphertext);
    expect(sealed.tag.toString('hex')).toBe(vector.expected.tag);
    expect(sealed.tag.length).toBe(TAG_SIZE);
  });

  it('open recovers plaintext', () => {
    const recovered = open(
      Buffer.from(vector.inputs.recipient_priv, 'hex'),
      Buffer.from(vector.inputs.sender_pub, 'hex'),
      Buffer.from(vector.expected.eph_pub, 'hex'),
      Buffer.from(vector.expected.ciphertext, 'hex'),
      Buffer.from(vector.expected.tag, 'hex'),
      Buffer.from(vector.intermediates.canonical_aad, 'hex'),
    );
    const expectedPlaintext = Buffer.from(vector.inputs.plaintext, 'hex');
    expect(recovered.equals(expectedPlaintext)).toBe(true);
  });
});
