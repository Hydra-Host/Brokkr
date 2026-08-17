import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { KEY_SIZE } from '@repo/crypto';
import { Buffer } from 'node:buffer';
import { describe, expect, it, vi } from 'vitest';

import { ZoneCryptoConfig } from '../zone-crypto.config';

const PRIVATE_KEY_BYTES = Buffer.alloc(KEY_SIZE, 0x42);
const PRIVATE_KEY_BASE64 = PRIVATE_KEY_BYTES.toString('base64');
const PRIVATE_KEY_HEX = PRIVATE_KEY_BYTES.toString('hex');

async function buildConfig(rawPrivateKey: string | undefined): Promise<ZoneCryptoConfig> {
  const mockConfigService = {
    get: vi.fn().mockReturnValue(rawPrivateKey),
  };
  const mockLogger = { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

  const module: TestingModule = await Test.createTestingModule({
    providers: [
      ZoneCryptoConfig,
      { provide: ConfigService, useValue: mockConfigService },
      { provide: `LoggerService${ZoneCryptoConfig.name}`, useValue: mockLogger },
    ],
  }).compile();

  const config = module.get(ZoneCryptoConfig);
  config.onModuleInit();
  return config;
}

describe('ZoneCryptoConfig', () => {
  describe('onModuleInit', () => {
    it('stays dormant when BROKKR_HUB_PRIVATE_KEY is unset', async () => {
      const config = await buildConfig(undefined);
      expect(config.isAvailable).toBe(false);
      expect(config.privateKey).toBeNull();
      expect(config.publicKey).toBeNull();
    });

    it('stays dormant when the env var is empty/whitespace', async () => {
      const config = await buildConfig('   ');
      expect(config.isAvailable).toBe(false);
    });

    it('loads when given a valid base64 32-byte key', async () => {
      const config = await buildConfig(PRIVATE_KEY_BASE64);
      expect(config.isAvailable).toBe(true);
      expect(config.privateKey?.length).toBe(KEY_SIZE);
      expect(config.publicKey?.length).toBe(KEY_SIZE);
    });

    it('throws on wrong-length input', async () => {
      const tooShort = Buffer.alloc(16, 0x42).toString('base64');
      await expect(buildConfig(tooShort)).rejects.toThrow(/must decode to 32 bytes/);
    });
  });

  describe('toJSON() redaction', () => {
    it('returns a redacted shape when configured', async () => {
      const config = await buildConfig(PRIVATE_KEY_BASE64);
      const json = config.toJSON();

      expect(json).toEqual({
        isAvailable: true,
        publicKey: expect.stringMatching(/^[0-9a-f]{64}$/),
        privateKey: '[REDACTED]',
      });
    });

    it('returns a redacted shape when dormant', async () => {
      const config = await buildConfig(undefined);
      const json = config.toJSON();

      expect(json).toEqual({
        isAvailable: false,
        publicKey: null,
        privateKey: '[REDACTED]',
      });
    });

    it('JSON.stringify of the instance never contains the raw private key (hex)', async () => {
      const config = await buildConfig(PRIVATE_KEY_BASE64);
      const stringified = JSON.stringify(config);

      expect(stringified).not.toContain(PRIVATE_KEY_HEX);
      expect(stringified).toContain('[REDACTED]');
    });

    it('JSON.stringify never contains the raw private key (base64)', async () => {
      const config = await buildConfig(PRIVATE_KEY_BASE64);
      const stringified = JSON.stringify(config);

      expect(stringified).not.toContain(PRIVATE_KEY_BASE64);
    });

    it('JSON.stringify never contains the per-byte Buffer JSON form of the private key', async () => {
      const config = await buildConfig(PRIVATE_KEY_BASE64);
      const stringified = JSON.stringify(config);
      const bufferJsonShape = JSON.stringify({ type: 'Buffer', data: Array.from(PRIVATE_KEY_BYTES) });

      expect(stringified).not.toContain(bufferJsonShape);
    });
  });

  describe('toString() redaction', () => {
    it('returns a redacted human-readable summary', async () => {
      const config = await buildConfig(PRIVATE_KEY_BASE64);
      expect(config.toString()).toBe('ZoneCryptoConfig { isAvailable=true, privateKey=[REDACTED] }');
    });

    it('reports dormant state honestly', async () => {
      const config = await buildConfig(undefined);
      expect(config.toString()).toBe('ZoneCryptoConfig { isAvailable=false, privateKey=[REDACTED] }');
    });

    it('template literal interpolation does not leak the private key', async () => {
      const config = await buildConfig(PRIVATE_KEY_BASE64);
      const interpolated = `${config}`;

      expect(interpolated).not.toContain(PRIVATE_KEY_HEX);
      expect(interpolated).not.toContain(PRIVATE_KEY_BASE64);
      expect(interpolated).toContain('[REDACTED]');
    });

    it('String(config) does not leak the private key', async () => {
      const config = await buildConfig(PRIVATE_KEY_BASE64);
      const str = String(config);

      expect(str).not.toContain(PRIVATE_KEY_HEX);
      expect(str).not.toContain(PRIVATE_KEY_BASE64);
      expect(str).toContain('[REDACTED]');
    });
  });

  describe('legitimate access paths still work', () => {
    it('the privateKey getter still returns the raw Buffer for internal callers', async () => {
      const config = await buildConfig(PRIVATE_KEY_BASE64);
      expect(config.privateKey).toBeInstanceOf(Buffer);
      expect(config.privateKey?.equals(PRIVATE_KEY_BYTES)).toBe(true);
    });
  });
});
