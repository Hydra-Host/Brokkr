
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { canonicalizeAad, INFO, KEY_SIZE, open, seal } from '@repo/crypto';
import { describe, expect, it } from 'vitest';

import { CURRENT_AAD_VERSION as BULLMQ_AAD_VERSION } from '../../../src/bullmq/seal-outbound-payload.js';

interface CorpusVector {
  name: string;
  inputs: { aad_obj: { aad_v: number } };
}

interface Corpus {
  info: string;
  vectors: CorpusVector[];
}

const here = __dirname;
const CORPUS_PATH = path.resolve(here, '../../../../../packages/crypto/test-vectors/auth-dh-v1.json');
const corpus = JSON.parse(readFileSync(CORPUS_PATH, 'utf-8')) as Corpus;

const hex = (s: string) => Buffer.from(s, 'hex');

function newKeypair(): { priv: Buffer; pub: Buffer } {
  const kp = generateKeyPairSync('x25519');
  const privDer = kp.privateKey.export({ format: 'der', type: 'pkcs8' });
  const pubDer = kp.publicKey.export({ format: 'der', type: 'spki' });
  return { priv: privDer.subarray(privDer.length - KEY_SIZE), pub: pubDer.subarray(pubDer.length - KEY_SIZE) };
}

describe('auth-dh INFO / wire-version single source of truth', () => {
  const corpusInfo = hex(corpus.info);

  it('@repo/crypto INFO equals the frozen corpus INFO', () => {
    expect(corpusInfo.toString('utf-8')).toBe('brokkr-auth-dh-v1');
    expect(INFO.equals(corpusInfo)).toBe(true);
  });

  it('the bridge AAD wire-version matches the corpus vectors', () => {
    for (const vec of corpus.vectors) {
      expect(vec.inputs.aad_obj.aad_v).toBe(BULLMQ_AAD_VERSION);
    }
  });
});

describe('non-ASCII AAD regression', () => {
  const nonAscii = {
    aad_v: 1,
    zone_id: 'zöne-üñîçødé-日本語-😀',
    queue_name: 'results.café',
    direction: 'bridge_to_hub',
    job_id: 'job-ሰላም',
    created_at: 1_730_000_000_000,
  };

  it('canonicalizeAad emits non-ASCII as raw UTF-8 (not \\uXXXX)', () => {
    const out = canonicalizeAad(nonAscii);
    expect(out.includes(Buffer.from('zöne-üñîçødé-日本語-😀', 'utf-8'))).toBe(true);
    expect(out.includes(Buffer.from('results.café', 'utf-8'))).toBe(true);
    expect(out.includes(Buffer.from('job-ሰላም', 'utf-8'))).toBe(true);
    expect(out.toString('utf-8')).not.toContain('\\u');
  });

  it('open(seal(...)) round-trips with a non-ASCII AAD', () => {
    const sender = newKeypair();
    const recipient = newKeypair();
    const plaintext = Buffer.from('non-ascii payload');
    const aadBytes = canonicalizeAad(nonAscii);

    const sealed = seal(sender.priv, recipient.pub, plaintext, aadBytes);
    const recovered = open(recipient.priv, sender.pub, sealed.ephPub, sealed.ciphertext, sealed.tag, aadBytes);
    expect(recovered.equals(plaintext)).toBe(true);
  });
});
