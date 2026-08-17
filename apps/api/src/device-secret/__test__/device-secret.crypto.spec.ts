import { type DeviceSecretAadFields, derivePublicKey, deviceSecretAad, open } from '@repo/crypto';
import { Buffer } from 'node:buffer';
import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sealDeviceSecret } from '../device-secret.crypto';

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
const PLAINTEXT = Buffer.from(JSON.stringify({ user: 'admin', pass: 's3cr3t' }), 'utf8');

describe('device-secret seal-to-zone (envelope)', () => {
  it('round-trips: hub seal → zone open recovers the plaintext', () => {
    const sealed = sealDeviceSecret(hubPriv, zonePub, PLAINTEXT, FIELDS);
    const opened = open(zonePriv, hubPub, sealed.ephPub, sealed.ciphertext, sealed.tag, deviceSecretAad(FIELDS));
    expect(opened.equals(PLAINTEXT)).toBe(true);
  });

  it('hub cannot open its own output (no zone_priv) — needs the zone key', () => {
    const sealed = sealDeviceSecret(hubPriv, zonePub, PLAINTEXT, FIELDS);
    expect(() =>
      open(hubPriv, hubPub, sealed.ephPub, sealed.ciphertext, sealed.tag, deviceSecretAad(FIELDS)),
    ).toThrow();
  });

  it('AAD binds the row — a different keyGen fails the tag', () => {
    const sealed = sealDeviceSecret(hubPriv, zonePub, PLAINTEXT, FIELDS);
    const wrongAad = deviceSecretAad({ ...FIELDS, keyGen: 2 });
    expect(() => open(zonePriv, hubPub, sealed.ephPub, sealed.ciphertext, sealed.tag, wrongAad)).toThrow();
  });

  it('AAD binds the device — another device cannot open it', () => {
    const sealed = sealDeviceSecret(hubPriv, zonePub, PLAINTEXT, FIELDS);
    const wrongAad = deviceSecretAad({ ...FIELDS, deviceId: 'other-device' });
    expect(() => open(zonePriv, hubPub, sealed.ephPub, sealed.ciphertext, sealed.tag, wrongAad)).toThrow();
  });

  it('AAD binds the zone key id — a blob sealed to one enrollment fails under another (even at the same keyGen)', () => {
    const sealed = sealDeviceSecret(hubPriv, zonePub, PLAINTEXT, FIELDS);
    const wrongAad = deviceSecretAad({ ...FIELDS, zoneKeyId: '00000000-0000-0000-0000-0000000000e2' });
    expect(() => open(zonePriv, hubPub, sealed.ephPub, sealed.ciphertext, sealed.tag, wrongAad)).toThrow();
  });

  it.each(['zoneId', 'zoneKeyId', 'deviceId', 'purpose', 'kind'] as const)(
    'AAD binds %s — swapping it fails the tag',
    (field) => {
      const sealed = sealDeviceSecret(hubPriv, zonePub, PLAINTEXT, FIELDS);
      const wrongAad = deviceSecretAad({ ...FIELDS, [field]: 'tampered-value' });
      expect(() => open(zonePriv, hubPub, sealed.ephPub, sealed.ciphertext, sealed.tag, wrongAad)).toThrow();
    },
  );

  it('a tampered ciphertext byte fails the tag', () => {
    const sealed = sealDeviceSecret(hubPriv, zonePub, PLAINTEXT, FIELDS);
    sealed.ciphertext[sealed.ciphertext.length - 1] ^= 0x01;
    expect(() =>
      open(zonePriv, hubPub, sealed.ephPub, sealed.ciphertext, sealed.tag, deviceSecretAad(FIELDS)),
    ).toThrow();
  });

  it('the sealed blob carries no plaintext', () => {
    const sealed = sealDeviceSecret(hubPriv, zonePub, PLAINTEXT, FIELDS);
    const wire = Buffer.concat([sealed.ephPub, sealed.ciphertext, sealed.tag]).toString('utf8');
    expect(wire).not.toContain('admin');
    expect(wire).not.toContain('s3cr3t');
  });
});
