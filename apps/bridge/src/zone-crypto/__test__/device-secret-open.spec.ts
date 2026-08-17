import { type DeviceSecretAadFields, derivePublicKey, deviceSecretAad, seal } from '@repo/crypto';
import { Buffer } from 'node:buffer';
import { generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ForwardedSecret, forwardedSecretSchema, openBmcSecret, openForwardedSecret } from '../device-secret-open';
import { clearActiveZoneCryptoSnapshot, setActiveZoneCryptoSnapshot } from '../zone-crypto.service';

function genPriv(): Buffer {
  return Buffer.from(generateKeyPairSync('x25519').privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32));
}

const hubPriv = genPriv();
const hubPub = derivePublicKey(hubPriv);
const zonePriv = genPriv();
const zonePub = derivePublicKey(zonePriv);

const FIELDS: DeviceSecretAadFields = {
  zoneId: '00000000-0000-0000-0000-000000000001',
  zoneKeyId: '00000000-0000-0000-0000-0000000000e1',
  deviceId: '00000000-0000-0000-0000-0000000000aa',
  purpose: 'BMC',
  kind: 'USER',
  keyGen: 1,
};
const PLAINTEXT = { user: 'admin', pass: 's3cr3t' };

function sealForwardPlaintext(plaintext: unknown, overrides: Partial<DeviceSecretAadFields> = {}): ForwardedSecret {
  const fields = { ...FIELDS, ...overrides };
  const sealed = seal(hubPriv, zonePub, Buffer.from(JSON.stringify(plaintext), 'utf8'), deviceSecretAad(fields));
  return {
    zoneId: fields.zoneId,
    zoneKeyId: fields.zoneKeyId,
    deviceId: fields.deviceId,
    purpose: fields.purpose,
    kind: fields.kind,
    keyGen: fields.keyGen,
    ephPub: sealed.ephPub.toString('base64'),
    ciphertext: sealed.ciphertext.toString('base64'),
    tag: sealed.tag.toString('base64'),
  };
}

function sealForward(overrides: Partial<DeviceSecretAadFields> = {}): ForwardedSecret {
  return sealForwardPlaintext(PLAINTEXT, overrides);
}

describe('openForwardedSecret (bridge open)', () => {
  beforeEach(() => {
    setActiveZoneCryptoSnapshot({ zonePriv, zonePub, hubPub, enrolledAt: 1_730_000_000_000 });
  });
  afterEach(() => {
    clearActiveZoneCryptoSnapshot();
  });

  it('round-trips: hub seal → bridge open recovers the plaintext', () => {
    const opened = openForwardedSecret(sealForward());
    expect(opened).toEqual(PLAINTEXT);
  });

  it('throws when zone crypto is not loaded', () => {
    clearActiveZoneCryptoSnapshot();
    expect(() => openForwardedSecret(sealForward())).toThrow(/zone_crypto not loaded/);
  });

  it.each(['zoneId', 'zoneKeyId', 'deviceId', 'purpose', 'kind'] as const)(
    'fails the tag when the forwarded %s is swapped',
    (field) => {
      const blob = { ...sealForward(), [field]: 'tampered-value' };
      expect(() => openForwardedSecret(blob)).toThrow();
    },
  );

  it('fails the tag when the forwarded keyGen is swapped', () => {
    const blob = { ...sealForward(), keyGen: 2 };
    expect(() => openForwardedSecret(blob)).toThrow();
  });

  it('fails the tag when zoneKeyId differs but keyGen matches (binds the specific enrollment)', () => {
    const blob = { ...sealForward(), zoneKeyId: '00000000-0000-0000-0000-0000000000e2' };
    expect(() => openForwardedSecret(blob)).toThrow();
  });

  it('fails the tag when a ciphertext byte is tampered', () => {
    const blob = sealForward();
    const ct = Buffer.from(blob.ciphertext, 'base64');
    ct[ct.length - 1] ^= 0x01;
    expect(() => openForwardedSecret({ ...blob, ciphertext: ct.toString('base64') })).toThrow();
  });

  it('rejects a forwarded blob missing zoneKeyId at the schema boundary', () => {
    const { zoneKeyId: _omit, ...withoutZoneKeyId } = sealForward();
    expect(forwardedSecretSchema.safeParse(withoutZoneKeyId).success).toBe(false);
  });
});

describe('openBmcSecret (inner cred-saga decrypt)', () => {
  beforeEach(() => {
    setActiveZoneCryptoSnapshot({ zonePriv, zonePub, hubPub, enrolledAt: 1_730_000_000_000 });
  });
  afterEach(() => {
    clearActiveZoneCryptoSnapshot();
  });

  it('maps the decrypted {user,pass} to {username,password}', () => {
    expect(openBmcSecret(sealForward())).toEqual({ username: 'admin', password: 's3cr3t' });
  });

  it('throws when zone crypto is not loaded', () => {
    clearActiveZoneCryptoSnapshot();
    expect(() => openBmcSecret(sealForward())).toThrow(/zone_crypto not loaded/);
  });

  it('fails the tag when an AAD-bound field is swapped (inner blob is device-bound)', () => {
    expect(() => openBmcSecret({ ...sealForward(), deviceId: 'tampered-value' })).toThrow();
  });

  it.each([
    ['missing pass', { user: 'admin' }],
    ['missing user', { pass: 's3cr3t' }],
    ['empty user', { user: '', pass: 's3cr3t' }],
    ['empty pass', { user: 'admin', pass: '' }],
    ['extra field', { user: 'admin', pass: 's3cr3t', extra: 'x' }],
    ['non-string pass', { user: 'admin', pass: 123 }],
  ])('rejects a decrypted plaintext that is not the {user,pass} shape (%s)', (_label, plaintext) => {
    expect(() => openBmcSecret(sealForwardPlaintext(plaintext))).toThrow();
  });
});
