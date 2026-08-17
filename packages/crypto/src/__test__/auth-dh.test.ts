import { Buffer } from 'node:buffer';
import { generateKeyPairSync } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { canonicalizeAad } from '../aad';
import { KEY_SIZE, NONCE_SIZE, TAG_SIZE, derivePublicKey, open, seal } from '../auth-dh';
import { SealOpenError } from '../errors';
import { __test_only__ } from '../test-only';

const SPKI_PREFIX_LEN = 12;
const PKCS8_PREFIX_LEN = 16;

interface RawKeypair {
  priv: Buffer;
  pub: Buffer;
}

function newKeypair(): RawKeypair {
  const { privateKey, publicKey } = generateKeyPairSync('x25519');
  const priv = Buffer.from(privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(PKCS8_PREFIX_LEN));
  const pub = Buffer.from(publicKey.export({ format: 'der', type: 'spki' }).subarray(SPKI_PREFIX_LEN));
  return { priv, pub };
}

function aadFor(
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

function captureError(fn: () => void): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected fn to throw, but it did not');
}

describe('roundtrip', () => {
  it('hub_to_bridge', () => {
    const sender = newKeypair();
    const recipient = newKeypair();
    const aad = aadFor('hub_to_bridge');
    const plaintext = Buffer.from('the quick brown fox jumps over the lazy dog', 'utf8');

    const env = seal(sender.priv, recipient.pub, plaintext, aad);
    expect(env.ephPub.length).toBe(KEY_SIZE);
    expect(env.tag.length).toBe(TAG_SIZE);
    expect(env.ciphertext.length).toBe(plaintext.length);

    const recovered = open(recipient.priv, sender.pub, env.ephPub, env.ciphertext, env.tag, aad);
    expect(recovered.equals(plaintext)).toBe(true);
  });

  it('bridge_to_hub', () => {
    const sender = newKeypair();
    const recipient = newKeypair();
    const aad = aadFor('bridge_to_hub');
    const plaintext = Buffer.from('reply payload', 'utf8');

    const env = seal(sender.priv, recipient.pub, plaintext, aad);
    const recovered = open(recipient.priv, sender.pub, env.ephPub, env.ciphertext, env.tag, aad);
    expect(recovered.equals(plaintext)).toBe(true);
  });

  it('empty plaintext + empty AAD', () => {
    const sender = newKeypair();
    const recipient = newKeypair();
    const env = seal(sender.priv, recipient.pub, Buffer.alloc(0), Buffer.alloc(0));
    const recovered = open(recipient.priv, sender.pub, env.ephPub, env.ciphertext, env.tag, Buffer.alloc(0));
    expect(recovered.length).toBe(0);
  });

  it('large plaintext above 64 KiB', () => {
    const sender = newKeypair();
    const recipient = newKeypair();
    const aad = aadFor();
    const plaintext = Buffer.from(Array.from({ length: 65_537 }, (_, i) => i % 256));

    const env = seal(sender.priv, recipient.pub, plaintext, aad);
    const recovered = open(recipient.priv, sender.pub, env.ephPub, env.ciphertext, env.tag, aad);
    expect(recovered.equals(plaintext)).toBe(true);
  });

  it('binary payload covering all byte values', () => {
    const sender = newKeypair();
    const recipient = newKeypair();
    const aad = aadFor();
    const plaintext = Buffer.from(Array.from({ length: 1024 }, (_, i) => i % 256));

    const env = seal(sender.priv, recipient.pub, plaintext, aad);
    const recovered = open(recipient.priv, sender.pub, env.ephPub, env.ciphertext, env.tag, aad);
    expect(recovered.equals(plaintext)).toBe(true);
  });
});

describe('tamper detection', () => {
  function sealedFixture() {
    const sender = newKeypair();
    const recipient = newKeypair();
    const aad = aadFor();
    const plaintext = Buffer.from('sensitive payload', 'utf8');
    const env = seal(sender.priv, recipient.pub, plaintext, aad);
    return { sender, recipient, aad, plaintext, env };
  }

  it('rejects ciphertext byte flip', () => {
    const f = sealedFixture();
    const tampered = Buffer.from(f.env.ciphertext);
    tampered[0] ^= 0x01;
    expect(() => open(f.recipient.priv, f.sender.pub, f.env.ephPub, tampered, f.env.tag, f.aad)).toThrow(SealOpenError);
  });

  it('rejects tag byte flip', () => {
    const f = sealedFixture();
    const tampered = Buffer.from(f.env.tag);
    tampered[tampered.length - 1] ^= 0xff;
    expect(() => open(f.recipient.priv, f.sender.pub, f.env.ephPub, f.env.ciphertext, tampered, f.aad)).toThrow(
      SealOpenError,
    );
  });

  it('rejects eph_pub byte flip', () => {
    const f = sealedFixture();
    const tampered = Buffer.from(f.env.ephPub);
    tampered[0] ^= 0x01;
    expect(() => open(f.recipient.priv, f.sender.pub, tampered, f.env.ciphertext, f.env.tag, f.aad)).toThrow(
      SealOpenError,
    );
  });

  it.each([
    ['zone_id', 'zone-other'],
    ['queue_name', 'q.different'],
    ['direction', 'bridge_to_hub'],
    ['job_id', 'job-99'],
    ['created_at', 1_730_000_000_001],
  ])('rejects AAD field tamper: %s', (field, value) => {
    const sender = newKeypair();
    const recipient = newKeypair();
    const originalAad = aadFor();
    const env = seal(sender.priv, recipient.pub, Buffer.from('payload', 'utf8'), originalAad);

    const tamperedAad = aadFor('hub_to_bridge', { [field]: value });
    expect(() => open(recipient.priv, sender.pub, env.ephPub, env.ciphertext, env.tag, tamperedAad)).toThrow(
      SealOpenError,
    );
  });
});

describe('GCM auth-tag length enforcement', () => {
  it.each([4, 8, 12])('rejects a %d-byte truncated tag', (tagLen) => {
    const sender = newKeypair();
    const recipient = newKeypair();
    const aad = aadFor();
    const env = seal(sender.priv, recipient.pub, Buffer.from('payload', 'utf8'), aad);

    const truncated = env.tag.subarray(0, tagLen);
    const error = captureError(() => open(recipient.priv, sender.pub, env.ephPub, env.ciphertext, truncated, aad));

    expect(error).toBeInstanceOf(SealOpenError);
    if (error instanceof SealOpenError) {
      expect(error.message).toBe('malformed seal input');
    }
  });

  it('still round-trips a valid 16-byte tag', () => {
    const sender = newKeypair();
    const recipient = newKeypair();
    const aad = aadFor();
    const plaintext = Buffer.from('payload', 'utf8');
    const env = seal(sender.priv, recipient.pub, plaintext, aad);

    expect(env.tag.length).toBe(TAG_SIZE);
    const recovered = open(recipient.priv, sender.pub, env.ephPub, env.ciphertext, env.tag, aad);
    expect(recovered.equals(plaintext)).toBe(true);
  });
});

describe('authenticity properties', () => {
  it('rejects forgery with wrong sender priv', () => {
    const legitimateSender = newKeypair();
    const attacker = newKeypair();
    const recipient = newKeypair();
    const aad = aadFor();

    const forged = seal(attacker.priv, recipient.pub, Buffer.from('forged payload', 'utf8'), aad);

    expect(() => open(recipient.priv, legitimateSender.pub, forged.ephPub, forged.ciphertext, forged.tag, aad)).toThrow(
      SealOpenError,
    );
  });

  it('rejects wrong recipient priv', () => {
    const sender = newKeypair();
    const recipient = newKeypair();
    const wrongRecipient = newKeypair();
    const aad = aadFor();

    const env = seal(sender.priv, recipient.pub, Buffer.from('payload', 'utf8'), aad);

    expect(() => open(wrongRecipient.priv, sender.pub, env.ephPub, env.ciphertext, env.tag, aad)).toThrow(
      SealOpenError,
    );
  });

  it('rejects wrong sender pub', () => {
    const sender = newKeypair();
    const wrongSender = newKeypair();
    const recipient = newKeypair();
    const aad = aadFor();

    const env = seal(sender.priv, recipient.pub, Buffer.from('payload', 'utf8'), aad);

    expect(() => open(recipient.priv, wrongSender.pub, env.ephPub, env.ciphertext, env.tag, aad)).toThrow(
      SealOpenError,
    );
  });
});

describe('error coercion', () => {
  it('coerces AES-GCM tag failure to SealOpenError with cause', () => {
    const sender = newKeypair();
    const recipient = newKeypair();
    const aad = aadFor();
    const env = seal(sender.priv, recipient.pub, Buffer.from('payload', 'utf8'), aad);

    const badTag = Buffer.alloc(TAG_SIZE);
    const error = captureError(() => open(recipient.priv, sender.pub, env.ephPub, env.ciphertext, badTag, aad));

    expect(error).toBeInstanceOf(SealOpenError);
    if (error instanceof SealOpenError) {
      expect(error.message).toContain('AES-GCM tag verification failed');
      expect(error.cause).toBeDefined();
      expect(error.message).not.toContain(sender.pub.toString('hex'));
      expect(error.message).not.toContain(env.ciphertext.toString('hex'));
    }
  });

  it('classifies tampered ciphertext as a tag-verification failure (structural, not string-matched)', () => {
    const sender = newKeypair();
    const recipient = newKeypair();
    const aad = aadFor();
    const env = seal(sender.priv, recipient.pub, Buffer.from('payload', 'utf8'), aad);

    const tampered = Buffer.from(env.ciphertext);
    tampered[0] ^= 0xff;
    const error = captureError(() => open(recipient.priv, sender.pub, env.ephPub, tampered, env.tag, aad));

    expect(error).toBeInstanceOf(SealOpenError);
    if (error instanceof SealOpenError) {
      expect(error.message).toBe('AES-GCM tag verification failed');
      expect(error.cause).toBeDefined();
    }
  });

  it('coerces malformed key length to SealOpenError', () => {
    const error = captureError(() =>
      open(
        Buffer.from('too-short', 'utf8'),
        Buffer.alloc(KEY_SIZE),
        Buffer.alloc(KEY_SIZE),
        Buffer.alloc(0),
        Buffer.alloc(TAG_SIZE),
        Buffer.alloc(0),
      ),
    );

    expect(error).toBeInstanceOf(SealOpenError);
    if (error instanceof SealOpenError) {
      expect(error.cause).toBeDefined();
      expect(error.message).toContain('malformed seal input');
    }
  });
});

describe('seal() error coercion (parity with open)', () => {
  it('coerces a wrong-length senderPriv to SealOpenError, not a raw node:crypto error', () => {
    const recipient = newKeypair();
    const aad = aadFor();
    const badSenderPriv = Buffer.alloc(16);
    const error = captureError(() => seal(badSenderPriv, recipient.pub, Buffer.from('payload', 'utf8'), aad));

    expect(error).toBeInstanceOf(SealOpenError);
    if (error instanceof SealOpenError) {
      expect(error.message).toBe('malformed seal input');
      expect(error.cause).toBeDefined();
      expect(error.message).not.toContain(badSenderPriv.toString('hex'));
    }
  });

  it('coerces a wrong-length recipientPub to SealOpenError', () => {
    const sender = newKeypair();
    const aad = aadFor();
    const badRecipientPub = Buffer.alloc(16);
    const error = captureError(() => seal(sender.priv, badRecipientPub, Buffer.from('payload', 'utf8'), aad));

    expect(error).toBeInstanceOf(SealOpenError);
    if (error instanceof SealOpenError) {
      expect(error.message).toBe('malformed seal input');
      expect(error.cause).toBeDefined();
    }
  });
});

describe('ephemeral contract', () => {
  it('seal generates a fresh ephemeral on each call', () => {
    const sender = newKeypair();
    const recipient = newKeypair();
    const aad = aadFor();

    const a = seal(sender.priv, recipient.pub, Buffer.from('msg-a', 'utf8'), aad);
    const b = seal(sender.priv, recipient.pub, Buffer.from('msg-b', 'utf8'), aad);
    expect(a.ephPub.equals(b.ephPub)).toBe(false);
  });

  it('sealWithEphemeral is deterministic and openable', () => {
    const sender = newKeypair();
    const recipient = newKeypair();
    const ephPriv = Buffer.from('11'.repeat(KEY_SIZE), 'hex');
    const aad = aadFor();
    const plaintext = Buffer.from('deterministic', 'utf8');

    const a = __test_only__.sealWithEphemeral(ephPriv, sender.priv, recipient.pub, plaintext, aad);
    const b = __test_only__.sealWithEphemeral(ephPriv, sender.priv, recipient.pub, plaintext, aad);
    expect(a.ephPub.equals(b.ephPub)).toBe(true);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(true);
    expect(a.tag.equals(b.tag)).toBe(true);

    const recovered = open(recipient.priv, sender.pub, a.ephPub, a.ciphertext, a.tag, aad);
    expect(recovered.equals(plaintext)).toBe(true);
  });

  it('NONCE_SIZE export matches AES-GCM expectation', () => {
    expect(NONCE_SIZE).toBe(12);
  });
});

describe('derivePublicKey', () => {
  it('produces the same pub a freshly-generated keypair would carry', () => {
    const kp = newKeypair();
    const derived = derivePublicKey(kp.priv);
    expect(derived.equals(kp.pub)).toBe(true);
    expect(derived.length).toBe(KEY_SIZE);
  });

  it('is deterministic for a fixed input', () => {
    const priv = Buffer.from('aa'.repeat(KEY_SIZE), 'hex');
    const a = derivePublicKey(priv);
    const b = derivePublicKey(priv);
    expect(a.equals(b)).toBe(true);
  });

  it('round-trips through seal/open as a recipient pub', () => {
    const sender = newKeypair();
    const recipientPriv = Buffer.from('cc'.repeat(KEY_SIZE), 'hex');
    const recipientPub = derivePublicKey(recipientPriv);
    const aad = aadFor();
    const plaintext = Buffer.from('payload', 'utf8');

    const env = seal(sender.priv, recipientPub, plaintext, aad);
    const recovered = open(recipientPriv, sender.pub, env.ephPub, env.ciphertext, env.tag, aad);
    expect(recovered.equals(plaintext)).toBe(true);
  });

  it('rejects wrong-length input via underlying createPrivateKey validation', () => {
    expect(() => derivePublicKey(Buffer.alloc(16))).toThrow();
  });
});
