import {
  ConflictException,
  HttpException,
  HttpStatus,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Buffer } from 'node:buffer';
import { createHash, createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';

import { ZoneCryptoConfig } from '../zone-crypto.config';
import { TokenConsumeRaceError, ZoneCryptoRepository } from '../zone-crypto.repository';
import { ZoneCryptoService } from '../zone-crypto.service';

const ZONE_ID = '00000000-0000-4000-8000-000000000001';
const OTHER_ZONE_ID = '00000000-0000-4000-8000-000000000002';
const AUDIT = { ip: '203.0.113.42' };
const HUB_PUB = Buffer.alloc(32, 0x42);
const RAW_TOKEN = 'test-token-abcdef0123';
const TOKEN_HASH = createHash('sha256').update(RAW_TOKEN, 'utf8').digest('hex');
const ZONE_PUB = Buffer.alloc(32, 0x33);
const OTHER_ZONE_PUB = Buffer.alloc(32, 0x66);

function macHex(...parts: Array<string | Buffer>): string {
  const h = createHmac('sha256', RAW_TOKEN);
  for (const p of parts) {
    if (typeof p === 'string') h.update(p, 'utf8');
    else h.update(p);
  }
  return h.digest('hex');
}

function validRequestMac(zoneId: string = ZONE_ID, zonePublicKey: Buffer = ZONE_PUB): string {
  return macHex(zoneId, zonePublicKey);
}

function expectedResponseMac(zoneId: string = ZONE_ID, zonePublicKey: Buffer = ZONE_PUB): string {
  return macHex(zoneId, zonePublicKey, HUB_PUB);
}

function tokenRow(
  overrides: Partial<{
    id: string;
    zoneId: string;
    expiresAt: Date;
    consumedAt: Date | null;
    consumedZonePub: Buffer | null;
  }> = {},
) {
  return {
    id: 'token-row-uuid',
    tokenHash: TOKEN_HASH,
    zoneId: ZONE_ID,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    consumedAt: null,
    consumedZonePub: null,
    createdAt: new Date(),
    createdById: 'admin-user-uuid',
    ...overrides,
  };
}

function validRequest(overrides: Partial<{ registration_token: string; zone_pub: string; mac: string }> = {}) {
  return {
    registration_token: RAW_TOKEN,
    zone_pub: ZONE_PUB.toString('hex'),
    mac: validRequestMac(),
    ...overrides,
  };
}

describe('ZoneCryptoService', () => {
  let service: ZoneCryptoService;
  let mockConfig: { isAvailable: boolean; publicKey: Buffer | null };
  let mockRepo: {
    findTokenByHash: Mock;
    consumeTokenAndUpsertEnrollment: Mock;
  };
  let mockLogger: { log: Mock; warn: Mock; error: Mock; debug: Mock };

  beforeEach(async () => {
    mockConfig = { isAvailable: true, publicKey: HUB_PUB };
    mockRepo = {
      findTokenByHash: vi.fn(),
      consumeTokenAndUpsertEnrollment: vi.fn(),
    };
    mockLogger = { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ZoneCryptoService,
        { provide: ZoneCryptoConfig, useValue: mockConfig },
        { provide: ZoneCryptoRepository, useValue: mockRepo },
        { provide: `LoggerService${ZoneCryptoService.name}`, useValue: mockLogger },
      ],
    }).compile();

    service = module.get(ZoneCryptoService);
  });

  describe('config gate', () => {
    it('returns 503 when hub crypto is not configured', async () => {
      mockConfig.isAvailable = false;
      mockConfig.publicKey = null;

      await expect(service.enrollZone(ZONE_ID, validRequest(), AUDIT)).rejects.toThrow(ServiceUnavailableException);
      expect(mockRepo.findTokenByHash).not.toHaveBeenCalled();
    });
  });

  describe('token validation', () => {
    it('returns 401 when token is not found', async () => {
      mockRepo.findTokenByHash.mockResolvedValue(null);

      await expect(service.enrollZone(ZONE_ID, validRequest(), AUDIT)).rejects.toThrow(UnauthorizedException);
    });

    it('returns 401 when token belongs to a different zone (no oracle)', async () => {
      mockRepo.findTokenByHash.mockResolvedValue(tokenRow({ zoneId: OTHER_ZONE_ID }));

      await expect(service.enrollZone(ZONE_ID, validRequest(), AUDIT)).rejects.toThrow(UnauthorizedException);
    });

    it('returns 410 when token has expired', async () => {
      mockRepo.findTokenByHash.mockResolvedValue(tokenRow({ expiresAt: new Date(Date.now() - 1000) }));

      await expect(service.enrollZone(ZONE_ID, validRequest(), AUDIT)).rejects.toThrow(
        new HttpException('Registration token has expired', HttpStatus.GONE),
      );
    });

    it('returns 401 when request MAC does not verify', async () => {
      mockRepo.findTokenByHash.mockResolvedValue(tokenRow());
      const bogusMac = '0'.repeat(64);

      await expect(service.enrollZone(ZONE_ID, validRequest({ mac: bogusMac }), AUDIT)).rejects.toThrow(
        UnauthorizedException,
      );
      expect(mockRepo.consumeTokenAndUpsertEnrollment).not.toHaveBeenCalled();
    });

    it('returns 401 when MAC has wrong length', async () => {
      mockRepo.findTokenByHash.mockResolvedValue(tokenRow());
      const shortMac = 'aabbcc';

      await expect(service.enrollZone(ZONE_ID, validRequest({ mac: shortMac }), AUDIT)).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });

  describe('MAC precedence over token state', () => {
    const bogusMac = '0'.repeat(64);

    it('returns 401 (not 200) for invalid MAC on the idempotent re-presentation path', async () => {
      mockRepo.findTokenByHash.mockResolvedValue(tokenRow({ consumedAt: new Date(), consumedZonePub: ZONE_PUB }));

      await expect(service.enrollZone(ZONE_ID, validRequest({ mac: bogusMac }), AUDIT)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('returns 401 (not 409) for invalid MAC when consumed with a different zone_pub', async () => {
      mockRepo.findTokenByHash.mockResolvedValue(tokenRow({ consumedAt: new Date(), consumedZonePub: OTHER_ZONE_PUB }));

      await expect(service.enrollZone(ZONE_ID, validRequest({ mac: bogusMac }), AUDIT)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('returns 401 (not 410) for invalid MAC on an expired token', async () => {
      mockRepo.findTokenByHash.mockResolvedValue(tokenRow({ expiresAt: new Date(Date.now() - 1000) }));

      await expect(service.enrollZone(ZONE_ID, validRequest({ mac: bogusMac }), AUDIT)).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });

  describe('idempotent re-presentation', () => {
    it('returns the original response when same (token, zone_pub) is presented after consumption', async () => {
      mockRepo.findTokenByHash.mockResolvedValue(tokenRow({ consumedAt: new Date(), consumedZonePub: ZONE_PUB }));

      const result = await service.enrollZone(ZONE_ID, validRequest(), AUDIT);

      expect(result.hub_pub).toBe(HUB_PUB.toString('hex'));
      expect(result.mac).toBe(expectedResponseMac());
      expect(mockRepo.consumeTokenAndUpsertEnrollment).not.toHaveBeenCalled();
    });

    it('returns 409 when same token is presented with a different zone_pub', async () => {
      mockRepo.findTokenByHash.mockResolvedValue(tokenRow({ consumedAt: new Date(), consumedZonePub: OTHER_ZONE_PUB }));

      await expect(service.enrollZone(ZONE_ID, validRequest(), AUDIT)).rejects.toThrow(ConflictException);
      expect(mockRepo.consumeTokenAndUpsertEnrollment).not.toHaveBeenCalled();
    });
  });

  describe('successful enrollment', () => {
    it('consumes the token, upserts enrollment, and returns hub_pub + valid MAC', async () => {
      mockRepo.findTokenByHash.mockResolvedValue(tokenRow());
      mockRepo.consumeTokenAndUpsertEnrollment.mockResolvedValue({
        id: 'enrollment-uuid',
        zoneId: ZONE_ID,
        zonePublicKey: ZONE_PUB,
        enrolledAt: new Date(),
        consumedTokenId: 'token-row-uuid',
      });

      const result = await service.enrollZone(ZONE_ID, validRequest(), AUDIT);

      expect(result.hub_pub).toBe(HUB_PUB.toString('hex'));
      expect(result.mac).toBe(expectedResponseMac());

      expect(mockRepo.consumeTokenAndUpsertEnrollment).toHaveBeenCalledWith({
        tokenId: 'token-row-uuid',
        zoneId: ZONE_ID,
        zonePublicKey: ZONE_PUB,
      });
    });

    it('response MAC is byte-deterministic for the same inputs', async () => {
      mockRepo.findTokenByHash.mockResolvedValue(tokenRow());
      mockRepo.consumeTokenAndUpsertEnrollment.mockResolvedValue(undefined);

      const first = await service.enrollZone(ZONE_ID, validRequest(), AUDIT);

      mockRepo.findTokenByHash.mockResolvedValue(tokenRow({ consumedAt: new Date(), consumedZonePub: ZONE_PUB }));
      const second = await service.enrollZone(ZONE_ID, validRequest(), AUDIT);

      expect(second.mac).toBe(first.mac);
      expect(second.hub_pub).toBe(first.hub_pub);
    });
  });

  describe('concurrent-consume race', () => {
    it('returns the same response when the racing consumer committed our zone_pub', async () => {
      mockRepo.findTokenByHash
        .mockResolvedValueOnce(tokenRow())
        .mockResolvedValueOnce(tokenRow({ consumedAt: new Date(), consumedZonePub: ZONE_PUB }));
      mockRepo.consumeTokenAndUpsertEnrollment.mockRejectedValue(new TokenConsumeRaceError());

      const result = await service.enrollZone(ZONE_ID, validRequest(), AUDIT);

      expect(result.hub_pub).toBe(HUB_PUB.toString('hex'));
      expect(result.mac).toBe(expectedResponseMac());
    });

    it('returns 409 when the racing consumer committed a different zone_pub', async () => {
      mockRepo.findTokenByHash
        .mockResolvedValueOnce(tokenRow())
        .mockResolvedValueOnce(tokenRow({ consumedAt: new Date(), consumedZonePub: OTHER_ZONE_PUB }));
      mockRepo.consumeTokenAndUpsertEnrollment.mockRejectedValue(new TokenConsumeRaceError());

      await expect(service.enrollZone(ZONE_ID, validRequest(), AUDIT)).rejects.toThrow(ConflictException);
    });

    it('propagates non-race repository errors as-is', async () => {
      mockRepo.findTokenByHash.mockResolvedValue(tokenRow());
      mockRepo.consumeTokenAndUpsertEnrollment.mockRejectedValue(new Error('redis is on fire'));

      await expect(service.enrollZone(ZONE_ID, validRequest(), AUDIT)).rejects.toThrow('redis is on fire');
    });
  });

  describe('audit logging', () => {
    let logSpy: Mock;

    beforeEach(() => {
      logSpy = mockLogger.log;
    });

    it('logs success on the fresh-enrollment path with path=fresh', async () => {
      mockRepo.findTokenByHash.mockResolvedValue(tokenRow());
      mockRepo.consumeTokenAndUpsertEnrollment.mockResolvedValue(undefined);

      await service.enrollZone(ZONE_ID, validRequest(), AUDIT);

      const successLogs = logSpy.mock.calls.filter((call) => String(call[0]).includes('Zone enrollment ok'));
      expect(successLogs).toHaveLength(1);
      expect(successLogs[0]?.[0]).toContain(`zone=${ZONE_ID}`);
      expect(successLogs[0]?.[0]).toContain('token=token-row-uuid');
      expect(successLogs[0]?.[0]).toContain(`zone_pub=${ZONE_PUB.toString('hex')}`);
      expect(successLogs[0]?.[0]).toContain('path=fresh');
      expect(successLogs[0]?.[0]).toContain(`ip=${AUDIT.ip}`);
    });

    it('logs success on the idempotent re-presentation path with path=idempotent', async () => {
      mockRepo.findTokenByHash.mockResolvedValue(tokenRow({ consumedAt: new Date(), consumedZonePub: ZONE_PUB }));

      await service.enrollZone(ZONE_ID, validRequest(), AUDIT);

      const successLogs = logSpy.mock.calls.filter((call) => String(call[0]).includes('Zone enrollment ok'));
      expect(successLogs).toHaveLength(1);
      expect(successLogs[0]?.[0]).toContain('path=idempotent');
      expect(successLogs[0]?.[0]).toContain(`ip=${AUDIT.ip}`);
    });

    it('logs success on the race-recovered path with path=race-recovered', async () => {
      mockRepo.findTokenByHash
        .mockResolvedValueOnce(tokenRow())
        .mockResolvedValueOnce(tokenRow({ consumedAt: new Date(), consumedZonePub: ZONE_PUB }));
      mockRepo.consumeTokenAndUpsertEnrollment.mockRejectedValue(new TokenConsumeRaceError());

      await service.enrollZone(ZONE_ID, validRequest(), AUDIT);

      const successLogs = logSpy.mock.calls.filter((call) => String(call[0]).includes('Zone enrollment ok'));
      expect(successLogs).toHaveLength(1);
      expect(successLogs[0]?.[0]).toContain('path=race-recovered');
    });

    it.each([
      ['invalid_token (token not found)', () => mockRepo.findTokenByHash.mockResolvedValue(null), 'invalid_token'],
      [
        'invalid_token (wrong zone)',
        () => mockRepo.findTokenByHash.mockResolvedValue(tokenRow({ zoneId: OTHER_ZONE_ID })),
        'invalid_token',
      ],
      [
        'expired',
        () => mockRepo.findTokenByHash.mockResolvedValue(tokenRow({ expiresAt: new Date(Date.now() - 1000) })),
        'expired',
      ],
      [
        'zone_pub_mismatch',
        () =>
          mockRepo.findTokenByHash.mockResolvedValue(
            tokenRow({ consumedAt: new Date(), consumedZonePub: OTHER_ZONE_PUB }),
          ),
        'zone_pub_mismatch',
      ],
    ])('logs rejection on %s with reason=%s', async (_label, setup, expectedReason) => {
      setup();

      await service.enrollZone(ZONE_ID, validRequest(), AUDIT).catch(() => undefined);

      const rejectionLogs = logSpy.mock.calls.filter((call) => String(call[0]).includes('Zone enrollment rejected'));
      expect(rejectionLogs).toHaveLength(1);
      expect(rejectionLogs[0]?.[0]).toContain(`reason=${expectedReason}`);
      expect(rejectionLogs[0]?.[0]).toContain(`ip=${AUDIT.ip}`);
    });

    it('logs rejection with reason=not_configured when hub crypto is unset', async () => {
      mockConfig.isAvailable = false;
      mockConfig.publicKey = null;

      await service.enrollZone(ZONE_ID, validRequest(), AUDIT).catch(() => undefined);

      const rejectionLogs = logSpy.mock.calls.filter((call) => String(call[0]).includes('Zone enrollment rejected'));
      expect(rejectionLogs).toHaveLength(1);
      expect(rejectionLogs[0]?.[0]).toContain('reason=not_configured');
    });

    it('never logs the raw token, token hash, or HMAC inputs', async () => {
      mockRepo.findTokenByHash.mockResolvedValue(tokenRow());
      mockRepo.consumeTokenAndUpsertEnrollment.mockResolvedValue(undefined);

      await service.enrollZone(ZONE_ID, validRequest(), AUDIT);

      const allLogText = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(allLogText).not.toContain(RAW_TOKEN);
      expect(allLogText).not.toContain(TOKEN_HASH);
      expect(allLogText).not.toContain(validRequestMac());
    });
  });

  describe('error message hygiene', () => {
    it('returns identical message for not-found / wrong-zone / bad-mac (no oracle)', async () => {
      const messages: string[] = [];

      mockRepo.findTokenByHash.mockResolvedValueOnce(null);
      try {
        await service.enrollZone(ZONE_ID, validRequest(), AUDIT);
      } catch (error) {
        if (error instanceof UnauthorizedException) messages.push(error.message);
      }

      mockRepo.findTokenByHash.mockResolvedValueOnce(tokenRow({ zoneId: OTHER_ZONE_ID }));
      try {
        await service.enrollZone(ZONE_ID, validRequest(), AUDIT);
      } catch (error) {
        if (error instanceof UnauthorizedException) messages.push(error.message);
      }

      mockRepo.findTokenByHash.mockResolvedValueOnce(tokenRow());
      try {
        await service.enrollZone(ZONE_ID, validRequest({ mac: '0'.repeat(64) }), AUDIT);
      } catch (error) {
        if (error instanceof UnauthorizedException) messages.push(error.message);
      }

      expect(messages).toHaveLength(3);
      expect(new Set(messages).size).toBe(1);
    });
  });
});
