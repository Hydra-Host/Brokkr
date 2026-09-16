import { DeviceSecretKind, ZoneNetworkType } from '@repo/database/enums';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('database enums subpath', () => {
  it('exports ZoneNetworkType from the Prisma schema', () => {
    expect(ZoneNetworkType).toEqual({ FLAT: 'FLAT', VPC: 'VPC' });
  });

  it('exports all DeviceSecretKind values', () => {
    expect(DeviceSecretKind).toEqual({
      USER: 'USER',
      KEY: 'KEY',
      TOKEN: 'TOKEN',
      CERT: 'CERT',
    });
  });

  it('is Prisma-runtime-free (no module imports)', () => {
    const source = readFileSync(new URL('../generated/client/enums.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/from ['"]/);
    expect(source).not.toMatch(/require\(/);
    expect(source).not.toMatch(/import\(/);
  });
});
