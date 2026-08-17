import { InternalServerErrorException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { DeviceTokenContext, DeviceTokenStatus } from '@repo/database';
import { ContextService } from 'src/common/context/context.service';
import { PrismaClient } from 'src/prisma/prisma.client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DeviceTokenAppService } from '../device-token-app.service';
import { DeviceTokensService } from '../device-tokens.service';

const tokenRow = {
  id: 'token-id',
  deviceId: 'device-id',
  deploymentId: null,
  context: DeviceTokenContext.BROKKR_LIVE,
  displayId: 'dtok_live',
  status: DeviceTokenStatus.ACTIVE,
  rotationGeneration: 0,
  expiresAt: new Date('2030-01-01T00:00:00Z'),
  lastUsedAt: null,
  lastUsedIp: null,
  revokedAt: null,
  revokedReason: null,
  revokedNote: null,
  issuedBy: 'device:device-id',
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
};

describe('DeviceTokenAppService', () => {
  const rotateBrokkrLiveToken = vi.fn();
  const publishBrokkrLiveTokenMaterial = vi.fn();
  const findUnique = vi.fn();
  const logger = { warn: vi.fn(), log: vi.fn(), error: vi.fn(), debug: vi.fn(), verbose: vi.fn(), setContext: vi.fn() };
  let service: DeviceTokenAppService;

  beforeEach(async () => {
    vi.clearAllMocks();
    publishBrokkrLiveTokenMaterial.mockResolvedValue(undefined);
    findUnique.mockResolvedValue(tokenRow);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DeviceTokenAppService,
        {
          provide: ContextService,
          useValue: { requireDeviceIdentity: { deviceId: 'device-id' } },
        },
        {
          provide: DeviceTokensService,
          useValue: {
            rotateBrokkrLiveToken,
            publishBrokkrLiveTokenMaterial,
          },
        },
        {
          provide: PrismaClient,
          useValue: { deviceToken: { findUnique } },
        },
        {
          provide: 'LoggerServiceDeviceTokenAppService',
          useValue: logger,
        },
      ],
    }).compile();

    service = module.get(DeviceTokenAppService);
  });

  it('publishes the rotated Brokkr Live token before returning plaintext', async () => {
    const material = {
      brokkr_live_token: 'test-live-token-rotated',
      endpoint: 'https://hub.example/api/v1/bmc/phone-home',
      exp: 1_900_000_000,
    };
    rotateBrokkrLiveToken.mockResolvedValue({
      tokenId: 'token-id',
      displayId: 'dtok_live',
      plaintext: 'test-live-token-rotated',
      material,
      reused: false,
    });

    await expect(service.rotateBrokkrLiveTokenForCaller()).resolves.toEqual({
      token: tokenRow,
      plaintext: 'test-live-token-rotated',
    });

    expect(publishBrokkrLiveTokenMaterial).toHaveBeenCalledWith({
      deviceId: 'device-id',
      material,
      requestId: 'rotate:token-id',
    });
  });

  it('returns rotated plaintext when publishing the server-token atom fails', async () => {
    const material = {
      brokkr_live_token: 'test-live-token-rotated',
      endpoint: 'https://hub.example/api/v1/bmc/phone-home',
      exp: 1_900_000_000,
    };
    rotateBrokkrLiveToken.mockResolvedValue({
      tokenId: 'token-id',
      displayId: 'dtok_live',
      plaintext: 'test-live-token-rotated',
      material,
      reused: false,
    });
    publishBrokkrLiveTokenMaterial.mockRejectedValueOnce(new Error('redis down'));

    await expect(service.rotateBrokkrLiveTokenForCaller()).resolves.toEqual({
      token: tokenRow,
      plaintext: 'test-live-token-rotated',
    });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Failed to publish rotated Brokkr Live token'),
      'rotate:token-id',
    );
  });

  it('rejects rotations that do not return publishable material', async () => {
    rotateBrokkrLiveToken.mockResolvedValue({
      tokenId: 'token-id',
      displayId: 'dtok_live',
      plaintext: 'test-live-token-rotated',
      material: null,
      reused: false,
    });

    await expect(service.rotateBrokkrLiveTokenForCaller()).rejects.toThrow(InternalServerErrorException);
    expect(publishBrokkrLiveTokenMaterial).not.toHaveBeenCalled();
  });
});
