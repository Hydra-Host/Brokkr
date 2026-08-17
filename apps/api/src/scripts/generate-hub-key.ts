import { KEY_SIZE, derivePublicKey } from '@repo/crypto';
import { Buffer } from 'node:buffer';
import { generateKeyPairSync } from 'node:crypto';

function main(): void {
  const { privateKey } = generateKeyPairSync('x25519');
  const privateKeyRaw = Buffer.from(privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-KEY_SIZE));
  const publicKeyHex = derivePublicKey(privateKeyRaw).toString('hex');

  process.stderr.write(
    [
      '',
      'Generated hub X25519 keypair (S1).',
      '',
      `  hub_pub (hex): ${publicKeyHex}`,
      '    └─ expect this in the hub boot log: "Hub crypto loaded; hub_pub=<hex>"',
      '',
      '  Set the line below as BROKKR_HUB_PRIVATE_KEY in the hub deployment secret env.',
      '  Treat it as a secret: never commit it, never log it, one key per environment.',
      '',
    ].join('\n'),
  );

  process.stdout.write(`${privateKeyRaw.toString('base64')}\n`);

  privateKeyRaw.fill(0);
}

main();
