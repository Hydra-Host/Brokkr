import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { canonicalizeAad, KEY_SIZE, NONCE_SIZE, open, seal, SealOpenError, TAG_SIZE } from '@repo/crypto';

function newKeypair(): { priv: Buffer; pub: Buffer } {
  const kp = generateKeyPairSync('x25519');
  const privDer = kp.privateKey.export({ format: 'der', type: 'pkcs8' });
  const pubDer = kp.publicKey.export({ format: 'der', type: 'spki' });
  return {
    priv: privDer.subarray(privDer.length - KEY_SIZE),
    pub: pubDer.subarray(pubDer.length - KEY_SIZE),
  };
}

const X25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');

function pubFromPriv(priv: Buffer): Buffer {
  const privKey = createPrivateKey({
    key: Buffer.concat([X25519_PKCS8_PREFIX, priv]),
    format: 'der',
    type: 'pkcs8',
  });
  const pubKey = createPublicKey(privKey);
  const der = pubKey.export({ format: 'der', type: 'spki' }) as Buffer;
  return der.subarray(der.length - KEY_SIZE);
}

function makeAad(
  direction: 'hub_to_bridge' | 'bridge_to_hub' = 'hub_to_bridge',
  overrides: Record<string, unknown> = {},
): Buffer {
  return canonicalizeAad({
    aad_v: 1,
    zone_id: 'zone-test',
    queue_name: 'q.events',
    direction,
    job_id: 'job-1',
    created_at: 1_730_000_000_000,
    ...overrides,
  });
}

describe('auth-dh roundtrip', () => {
  it('hub_to_bridge: seal/open with envelope sizes pinned', () => {
    const sender = newKeypair();
    const recipient = newKeypair();
    const aad = makeAad('hub_to_bridge');
    const plaintext = Buffer.from('the quick brown fox jumps over the lazy dog');

    const env = seal(sender.priv, recipient.pub, plaintext, aad);
    expect(env.ephPub.length).toBe(KEY_SIZE);
    expect(env.tag.length).toBe(TAG_SIZE);
    expect(env.ciphertext.length).toBe(plaintext.length);

    const recovered = open(recipient.priv, sender.pub, env.ephPub, env.ciphertext, env.tag, aad);
    expect(recovered.equals(plaintext)).toBe(true);
  });

  it('bridge_to_hub: seal/open', () => {
    const sender = newKeypair();
    const recipient = newKeypair();
    const aad = makeAad('bridge_to_hub');
    const plaintext = Buffer.from('reply payload');

    const env = seal(sender.priv, recipient.pub, plaintext, aad);
    const recovered = open(recipient.priv, sender.pub, env.ephPub, env.ciphertext, env.tag, aad);
    expect(recovered.equals(plaintext)).toBe(true);
  });

  it('empty plaintext and empty AAD are accepted by the primitive', () => {
    const sender = newKeypair();
    const recipient = newKeypair();
    const senderPub = pubFromPriv(sender.priv);

    const env = seal(sender.priv, recipient.pub, Buffer.alloc(0), Buffer.alloc(0));
    const recovered = open(recipient.priv, senderPub, env.ephPub, env.ciphertext, env.tag, Buffer.alloc(0));
    expect(recovered.length).toBe(0);
  });

  it('large plaintext above 64 KiB roundtrips', () => {
    const sender = newKeypair();
    const recipient = newKeypair();
    const aad = makeAad();
    const plaintext = randomBytes(65_537);

    const env = seal(sender.priv, recipient.pub, plaintext, aad);
    const recovered = open(recipient.priv, sender.pub, env.ephPub, env.ciphertext, env.tag, aad);
    expect(recovered.equals(plaintext)).toBe(true);
  });

  it('binary payload covering all 256 byte values', () => {
    const sender = newKeypair();
    const recipient = newKeypair();
    const aad = makeAad();
    const block = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    const plaintext = Buffer.concat([block, block, block, block]);

    const env = seal(sender.priv, recipient.pub, plaintext, aad);
    const recovered = open(recipient.priv, sender.pub, env.ephPub, env.ciphertext, env.tag, aad);
    expect(recovered.equals(plaintext)).toBe(true);
  });
});

describe('auth-dh tamper detection', () => {
  function freshSealed() {
    const sender = newKeypair();
    const recipient = newKeypair();
    const aad = makeAad();
    const plaintext = Buffer.from('sensitive payload');
    const env = seal(sender.priv, recipient.pub, plaintext, aad);
    return { sender, recipient, aad, env, plaintext };
  }

  it('ciphertext byte-flip is rejected', () => {
    const { sender, recipient, aad, env } = freshSealed();
    const tampered = Buffer.from(env.ciphertext);
    tampered[0] ^= 0x01;
    expect(() => open(recipient.priv, sender.pub, env.ephPub, tampered, env.tag, aad)).toThrow(SealOpenError);
  });

  it('tag byte-flip is rejected', () => {
    const { sender, recipient, aad, env } = freshSealed();
    const tampered = Buffer.from(env.tag);
    tampered[tampered.length - 1] ^= 0xff;
    expect(() => open(recipient.priv, sender.pub, env.ephPub, env.ciphertext, tampered, aad)).toThrow(SealOpenError);
  });

  it('eph_pub byte-flip is rejected', () => {
    const { sender, recipient, aad, env } = freshSealed();
    const tampered = Buffer.from(env.ephPub);
    tampered[0] ^= 0x01;
    expect(() => open(recipient.priv, sender.pub, tampered, env.ciphertext, env.tag, aad)).toThrow(SealOpenError);
  });

  it.each([
    { field: 'zone_id', value: 'zone-other' },
    { field: 'queue_name', value: 'q.different' },
    { field: 'direction', value: 'bridge_to_hub' },
    { field: 'job_id', value: 'job-99' },
    { field: 'created_at', value: 1_730_000_000_001 },
    { field: 'aad_v', value: 1 },
  ])('AAD field tamper rejected for $field', ({ field, value }) => {
    const sender = newKeypair();
    const recipient = newKeypair();
    const originalAad = makeAad();
    const env = seal(sender.priv, recipient.pub, Buffer.from('payload'), originalAad);

    const tamperedAad = makeAad('hub_to_bridge', { [field]: value });
    if (tamperedAad.equals(originalAad)) {
      const recovered = open(recipient.priv, sender.pub, env.ephPub, env.ciphertext, env.tag, tamperedAad);
      expect(recovered.toString('utf-8')).toBe('payload');
      return;
    }

    expect(() => open(recipient.priv, sender.pub, env.ephPub, env.ciphertext, env.tag, tamperedAad)).toThrow(
      SealOpenError,
    );
  });
});

describe('auth-dh authenticity properties', () => {
  it('forgery with wrong sender priv is rejected (auth-DH guarantee)', () => {
    const legitimateSender = newKeypair();
    const attackerSender = newKeypair();
    const recipient = newKeypair();
    const aad = makeAad();

    const forged = seal(attackerSender.priv, recipient.pub, Buffer.from('forged payload'), aad);

    expect(() => open(recipient.priv, legitimateSender.pub, forged.ephPub, forged.ciphertext, forged.tag, aad)).toThrow(
      SealOpenError,
    );
  });

  it('wrong recipient priv is rejected', () => {
    const sender = newKeypair();
    const recipient = newKeypair();
    const wrongRecipient = newKeypair();
    const aad = makeAad();

    const env = seal(sender.priv, recipient.pub, Buffer.from('payload'), aad);

    expect(() => open(wrongRecipient.priv, sender.pub, env.ephPub, env.ciphertext, env.tag, aad)).toThrow(
      SealOpenError,
    );
  });

  it('wrong sender pub is rejected', () => {
    const sender = newKeypair();
    const wrongSender = newKeypair();
    const recipient = newKeypair();
    const aad = makeAad();

    const env = seal(sender.priv, recipient.pub, Buffer.from('payload'), aad);

    expect(() => open(recipient.priv, wrongSender.pub, env.ephPub, env.ciphertext, env.tag, aad)).toThrow(
      SealOpenError,
    );
  });
});

describe('auth-dh error coercion', () => {
  it('invalid tag is coerced to SealOpenError, leaking no secrets', () => {
    const sender = newKeypair();
    const recipient = newKeypair();
    const aad = makeAad();
    const env = seal(sender.priv, recipient.pub, Buffer.from('payload'), aad);

    const badTag = Buffer.alloc(TAG_SIZE);
    let caught: unknown;
    try {
      open(recipient.priv, sender.pub, env.ephPub, env.ciphertext, badTag, aad);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SealOpenError);
    const message = (caught as Error).message;
    expect(message).not.toContain(sender.pub.toString('hex'));
    expect(message).not.toContain(env.ciphertext.toString('hex'));
  });

  it('malformed key length is coerced to SealOpenError', () => {
    let caught: unknown;
    try {
      open(
        Buffer.from('too-short'),
        Buffer.alloc(KEY_SIZE),
        Buffer.alloc(KEY_SIZE),
        Buffer.alloc(0),
        Buffer.alloc(TAG_SIZE),
        Buffer.alloc(0),
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SealOpenError);
  });
});

describe('auth-dh ephemeral contract', () => {
  it('seal generates a fresh ephemeral per call (no nonce reuse)', () => {
    const sender = newKeypair();
    const recipient = newKeypair();
    const aad = makeAad();

    const a = seal(sender.priv, recipient.pub, Buffer.from('msg-a'), aad);
    const b = seal(sender.priv, recipient.pub, Buffer.from('msg-b'), aad);
    expect(a.ephPub.equals(b.ephPub)).toBe(false);
  });

  it('seal uses a fresh ephemeral per call (random, not deterministic)', () => {
    const sender = newKeypair();
    const recipient = newKeypair();
    const aad = makeAad();
    const plaintext = Buffer.from('deterministic');

    const a = seal(sender.priv, recipient.pub, plaintext, aad);
    const b = seal(sender.priv, recipient.pub, plaintext, aad);
    expect(a.ephPub.equals(b.ephPub)).toBe(false);

    const recovered = open(recipient.priv, sender.pub, a.ephPub, a.ciphertext, a.tag, aad);
    expect(recovered.equals(plaintext)).toBe(true);
  });

  it('nonce is derived from SHA256(eph_pub)[:NONCE_SIZE]', () => {
    const sender = newKeypair();
    const recipient = newKeypair();
    const aad = makeAad();
    const env = seal(sender.priv, recipient.pub, Buffer.from('payload'), aad);

    const derived = createHash('sha256').update(env.ephPub).digest().subarray(0, NONCE_SIZE);
    expect(derived.length).toBe(NONCE_SIZE);

    const recovered = open(recipient.priv, sender.pub, env.ephPub, env.ciphertext, env.tag, aad);
    expect(recovered.toString('utf-8')).toBe('payload');
  });
});
