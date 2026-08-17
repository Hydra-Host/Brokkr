import { Buffer } from 'node:buffer';
import { createHash, createPublicKey, diffieHellman, hkdfSync } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AES_KEY_SIZE, INFO, KEY_SIZE, NONCE_SIZE, TAG_SIZE, canonicalizeAad } from '../src/index';
import { privKeyFromRaw, pubKeyFromRaw, rawPub } from '../src/keys';
import { __test_only__ } from '../src/test-only';

const HUB_PRIV = Buffer.alloc(KEY_SIZE, 0x01);
const ZONE_PRIV = Buffer.alloc(KEY_SIZE, 0x02);
const HUB_PUB = rawPub(createPublicKey(privKeyFromRaw(HUB_PRIV)));
const ZONE_PUB = rawPub(createPublicKey(privKeyFromRaw(ZONE_PRIV)));
const EPH_PRIV_1 = Buffer.alloc(KEY_SIZE, 0x03);
const EPH_PRIV_2 = Buffer.alloc(KEY_SIZE, 0x04);
const EPH_PRIV_3 = Buffer.alloc(KEY_SIZE, 0x05);

interface AadObj {
  aad_v: number;
  zone_id: string;
  queue_name: string;
  direction: 'hub_to_bridge' | 'bridge_to_hub';
  job_id: string;
  created_at: number;
}

interface VectorInputs {
  sender_priv: string;
  sender_pub: string;
  recipient_priv: string;
  recipient_pub: string;
  eph_priv: string;
  plaintext: string;
  aad_obj: AadObj;
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

interface BuildArgs {
  name: string;
  senderPriv: Buffer;
  senderPub: Buffer;
  recipientPriv: Buffer;
  recipientPub: Buffer;
  ephPriv: Buffer;
  plaintext: Buffer;
  aadObj: AadObj;
}

function buildVector(args: BuildArgs): Vector {
  const aadBytes = canonicalizeAad(args.aadObj);
  const sealed = __test_only__.sealWithEphemeral(
    args.ephPriv,
    args.senderPriv,
    args.recipientPub,
    args.plaintext,
    aadBytes,
  );

  const salt = createHash('sha256').update(aadBytes).digest();
  const ephPrivKey = privKeyFromRaw(args.ephPriv);
  const senderPrivKey = privKeyFromRaw(args.senderPriv);
  const recipientPubKey = pubKeyFromRaw(args.recipientPub);
  const sharedE = diffieHellman({ privateKey: ephPrivKey, publicKey: recipientPubKey });
  const sharedS = diffieHellman({ privateKey: senderPrivKey, publicKey: recipientPubKey });
  const ikm = Buffer.concat([sharedE, sharedS]);
  const aesKey = Buffer.from(hkdfSync('sha256', ikm, salt, INFO, AES_KEY_SIZE));
  const nonce = Buffer.from(createHash('sha256').update(sealed.ephPub).digest().subarray(0, NONCE_SIZE));

  return {
    name: args.name,
    inputs: {
      sender_priv: args.senderPriv.toString('hex'),
      sender_pub: args.senderPub.toString('hex'),
      recipient_priv: args.recipientPriv.toString('hex'),
      recipient_pub: args.recipientPub.toString('hex'),
      eph_priv: args.ephPriv.toString('hex'),
      plaintext: args.plaintext.toString('hex'),
      aad_obj: args.aadObj,
    },
    intermediates: {
      canonical_aad: aadBytes.toString('hex'),
      hkdf_salt: salt.toString('hex'),
      aes_key: aesKey.toString('hex'),
      nonce: nonce.toString('hex'),
    },
    expected: {
      eph_pub: sealed.ephPub.toString('hex'),
      ciphertext: sealed.ciphertext.toString('hex'),
      tag: sealed.tag.toString('hex'),
    },
  };
}

const vectors: Vector[] = [
  buildVector({
    name: 'empty_plaintext_minimal_aad_hub_to_bridge',
    senderPriv: HUB_PRIV,
    senderPub: HUB_PUB,
    recipientPriv: ZONE_PRIV,
    recipientPub: ZONE_PUB,
    ephPriv: EPH_PRIV_1,
    plaintext: Buffer.alloc(0),
    aadObj: {
      aad_v: 1,
      zone_id: 'z',
      queue_name: 'q',
      direction: 'hub_to_bridge',
      job_id: '',
      created_at: 0,
    },
  }),
  buildVector({
    name: 'ascii_payload_full_aad_hub_to_bridge',
    senderPriv: HUB_PRIV,
    senderPub: HUB_PUB,
    recipientPriv: ZONE_PRIV,
    recipientPub: ZONE_PUB,
    ephPriv: EPH_PRIV_2,
    plaintext: Buffer.from('the quick brown fox jumps over the lazy dog', 'utf8'),
    aadObj: {
      aad_v: 1,
      zone_id: 'zone-prod-east-1',
      queue_name: 'results.servers.discovery',
      direction: 'hub_to_bridge',
      job_id: 'job-01HQZ7K4YV0QXG',
      created_at: 1_730_000_000_000,
    },
  }),
  buildVector({
    name: 'ascii_payload_full_aad_bridge_to_hub',
    senderPriv: ZONE_PRIV,
    senderPub: ZONE_PUB,
    recipientPriv: HUB_PRIV,
    recipientPub: HUB_PUB,
    ephPriv: EPH_PRIV_3,
    plaintext: Buffer.from('reply: discovery.complete', 'utf8'),
    aadObj: {
      aad_v: 1,
      zone_id: 'zone-prod-east-1',
      queue_name: 'results.servers.discovery',
      direction: 'bridge_to_hub',
      job_id: 'job-01HQZ7K4YV0QXG',
      created_at: 1_730_000_001_000,
    },
  }),
  buildVector({
    name: 'binary_payload_all_byte_values_hub_to_bridge',
    senderPriv: HUB_PRIV,
    senderPub: HUB_PUB,
    recipientPriv: ZONE_PRIV,
    recipientPub: ZONE_PUB,
    ephPriv: Buffer.alloc(KEY_SIZE, 0x06),
    plaintext: Buffer.from(Array.from({ length: 1024 }, (_, i) => i % 256)),
    aadObj: {
      aad_v: 1,
      zone_id: 'zone-prod-east-1',
      queue_name: 'results.servers.discovery',
      direction: 'hub_to_bridge',
      job_id: 'job-binary-01',
      created_at: 1_730_000_002_000,
    },
  }),
  buildVector({
    name: 'edge_aad_long_zone_id_empty_job_id_hub_to_bridge',
    senderPriv: HUB_PRIV,
    senderPub: HUB_PUB,
    recipientPriv: ZONE_PRIV,
    recipientPub: ZONE_PUB,
    ephPriv: Buffer.alloc(KEY_SIZE, 0x07),
    plaintext: Buffer.from('edge', 'utf8'),
    aadObj: {
      aad_v: 1,
      zone_id: 'z-' + 'a'.repeat(4096),
      queue_name: 'q',
      direction: 'hub_to_bridge',
      job_id: '',
      created_at: 1_730_000_003_000,
    },
  }),
  buildVector({
    name: 'large_payload_64kib_plus_hub_to_bridge',
    senderPriv: HUB_PRIV,
    senderPub: HUB_PUB,
    recipientPriv: ZONE_PRIV,
    recipientPub: ZONE_PUB,
    ephPriv: Buffer.alloc(KEY_SIZE, 0x08),
    plaintext: Buffer.from(Array.from({ length: 65_537 }, (_, i) => i % 256)),
    aadObj: {
      aad_v: 1,
      zone_id: 'zone-prod-east-1',
      queue_name: 'results.servers.discovery',
      direction: 'hub_to_bridge',
      job_id: 'job-large-01',
      created_at: 1_730_000_004_000,
    },
  }),
];

const corpus = {
  version: 'auth-dh-v1',
  envelope_v: 1,
  aad_v: 1,
  info: INFO.toString('hex'),
  constants: {
    key_size: KEY_SIZE,
    aes_key_size: AES_KEY_SIZE,
    nonce_size: NONCE_SIZE,
    tag_size: TAG_SIZE,
    hkdf_hash: 'sha256',
    aead: 'aes-256-gcm',
    curve: 'x25519',
  },
  comment:
    'Frozen regression corpus for the @repo/crypto auth-DH seal/open primitives. ' +
    'Test-only -- never loaded by production code. Generated by ' +
    "packages/crypto/test-vectors/generate.ts; the test suite pins this file's " +
    'SHA-256 so an accidental change to the TS seal/HKDF/nonce derivation fails CI.',
  vectors,
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (isPlainObject(value)) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortKeysDeep(value[key]);
    }
    return sorted;
  }
  return value;
}

const sortedCorpus = sortKeysDeep(corpus);
const json = JSON.stringify(sortedCorpus, null, 2) + '\n';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outPath = resolve(__dirname, 'auth-dh-v1.json');
writeFileSync(outPath, json, 'utf8');

const sha = createHash('sha256').update(json, 'utf8').digest('hex');
console.info(`wrote ${outPath} (${Buffer.byteLength(json, 'utf8')} bytes)`);
console.info(`sha256 = ${sha}`);
