import { BadRequestException, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigAtomWriter } from 'src/common/redis';
import { DeviceTokensService } from 'src/device-tokens/device-tokens.service';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { DeviceContextService } from '../../device-context.service';
import { ServerTokenSchema, ServerTokenService, TTL_SERVER_TOKEN_SECONDS } from '../server-token.service';

const DEVICE_UUID = '550e8400-e29b-41d4-a716-446655440042';
const ZONE_ID = '1-1-1';
const REQUEST_ID = '11111111-1111-1111-1111-111111111111';

const LIVE_MATERIAL = {
  brokkr_live_token: 'test-live-token',
  endpoint: 'https://brokkr.example/api/v1/bmc/phone-home',
  exp: 1_900_000_000,
};

function makeCtx() {
  return {
    device: { id: DEVICE_UUID },
    zoneId: ZONE_ID,
  };
}

describe('ServerTokenService', () => {
  let service: ServerTokenService;
  let mockResolveZoneContext: Mock;
  let mockIssueBrokkrLiveToken: Mock;
  let mockWriteAtomJson: Mock;

  beforeEach(async () => {
    mockResolveZoneContext = vi.fn().mockResolvedValue(makeCtx());
    mockIssueBrokkrLiveToken = vi.fn().mockResolvedValue({
      tokenId: 'live-token-id',
      displayId: 'dtok_live',
      plaintext: 'test-live-token',
      material: LIVE_MATERIAL,
      reused: false,
    });
    mockWriteAtomJson = vi.fn().mockResolvedValue(undefined);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ServerTokenService,
        {
          provide: DeviceContextService,
          useValue: { resolveZoneContext: mockResolveZoneContext },
        },
        {
          provide: DeviceTokensService,
          useValue: { issueBrokkrLiveToken: mockIssueBrokkrLiveToken },
        },
        {
          provide: ConfigAtomWriter,
          useValue: { writeAtomJson: mockWriteAtomJson },
        },
        {
          provide: `LoggerService${ServerTokenService.name}`,
          useValue: {
            log: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
            debug: vi.fn(),
            verbose: vi.fn(),
            setContext: vi.fn().mockReturnThis(),
          },
        },
      ],
    }).compile();

    service = module.get<ServerTokenService>(ServerTokenService);
  });

  afterEach(() => vi.clearAllMocks());

  describe('writeForDevice', () => {
    it('writes the atom at device:{uuid}:server_token with TTL=86400 and the canonical envelope', async () => {
      await service.writeForDevice(DEVICE_UUID, { requestId: REQUEST_ID });

      expect(mockWriteAtomJson).toHaveBeenCalledOnce();
      expect(mockWriteAtomJson).toHaveBeenCalledWith(
        ZONE_ID,
        `device:${DEVICE_UUID}:server_token`,
        LIVE_MATERIAL,
        ServerTokenSchema,
        TTL_SERVER_TOKEN_SECONDS,
        { request_id: REQUEST_ID },
      );
    });

    it('resolves the zone context exactly once across the mint+write cycle', async () => {
      await service.writeForDevice(DEVICE_UUID, { requestId: REQUEST_ID });

      expect(mockResolveZoneContext).toHaveBeenCalledOnce();
      expect(mockResolveZoneContext).toHaveBeenCalledWith(DEVICE_UUID);
    });

    it('defaults request_id to null when no opts are passed', async () => {
      await service.writeForDevice(DEVICE_UUID);

      expect(mockWriteAtomJson).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
        { request_id: null },
      );
    });

    it('propagates mint errors so the caller can decide whether to swallow', async () => {
      mockIssueBrokkrLiveToken.mockRejectedValueOnce(new Error('db unreachable'));

      await expect(service.writeForDevice(DEVICE_UUID)).rejects.toThrow('db unreachable');
      expect(mockWriteAtomJson).not.toHaveBeenCalled();
    });
  });

  describe('mintForCtx / writeAtomForCtx', () => {
    it('mintForCtx rotates a BROKKR_LIVE token from the supplied ctx without a device lookup', async () => {
      const ctx = makeCtx();
      const result = await service.mintForCtx(ctx);

      expect(mockResolveZoneContext).not.toHaveBeenCalled();
      expect(mockIssueBrokkrLiveToken).toHaveBeenCalledWith({
        deviceId: DEVICE_UUID,
        issuedBy: 'system',
      });
      expect(result).toEqual(LIVE_MATERIAL);
    });

    it('mintForCtx throws when issuance returns no material', async () => {
      mockIssueBrokkrLiveToken.mockResolvedValueOnce({
        tokenId: 'live-token-id',
        displayId: 'dtok_live',
        plaintext: null,
        material: null,
        reused: true,
      });

      await expect(service.mintForCtx(makeCtx())).rejects.toBeInstanceOf(InternalServerErrorException);
    });

    it('writeAtomForCtx writes the pre-minted atom without a device lookup', async () => {
      const ctx = makeCtx();
      const atom = { ...LIVE_MATERIAL, brokkr_live_token: 'test-live-token-other' };

      await service.writeAtomForCtx(ctx, atom, { requestId: REQUEST_ID });

      expect(mockResolveZoneContext).not.toHaveBeenCalled();
      expect(mockWriteAtomJson).toHaveBeenCalledWith(
        ZONE_ID,
        `device:${DEVICE_UUID}:server_token`,
        atom,
        ServerTokenSchema,
        TTL_SERVER_TOKEN_SECONDS,
        { request_id: REQUEST_ID },
      );
    });
  });

  describe('resolveZoneContext error propagation', () => {
    it('propagates BadRequestException when the device has no zoneId', async () => {
      mockResolveZoneContext.mockRejectedValueOnce(
        new BadRequestException(`Device ${DEVICE_UUID} is not assigned to a zone`),
      );

      await expect(service.writeForDevice(DEVICE_UUID, { requestId: REQUEST_ID })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(mockIssueBrokkrLiveToken).not.toHaveBeenCalled();
      expect(mockWriteAtomJson).not.toHaveBeenCalled();
    });

    it('propagates BadRequestException when the device has no IPv4 IPMI address', async () => {
      mockResolveZoneContext.mockRejectedValueOnce(
        new BadRequestException(`Device ${DEVICE_UUID} has no IPv4 IPMI address on its management interface`),
      );

      await expect(service.writeForDevice(DEVICE_UUID, { requestId: REQUEST_ID })).rejects.toThrow(
        /has no IPv4 IPMI address/,
      );
      expect(mockWriteAtomJson).not.toHaveBeenCalled();
    });

    it('propagates BadRequestException when the device has no supplier', async () => {
      mockResolveZoneContext.mockRejectedValueOnce(
        new BadRequestException(`Device ${DEVICE_UUID} has no supplier organization`),
      );

      await expect(service.writeForDevice(DEVICE_UUID)).rejects.toThrow(/has no supplier organization/);
      expect(mockWriteAtomJson).not.toHaveBeenCalled();
    });

    it('propagates BadRequestException when the device is missing site or location', async () => {
      mockResolveZoneContext.mockRejectedValueOnce(
        new BadRequestException(`Device ${DEVICE_UUID} is missing site or location`),
      );

      await expect(service.writeForDevice(DEVICE_UUID)).rejects.toThrow(/missing site or location/);
      expect(mockWriteAtomJson).not.toHaveBeenCalled();
    });

    it('propagates NotFoundException when the device row does not exist', async () => {
      mockResolveZoneContext.mockRejectedValueOnce(new NotFoundException(`Device ${DEVICE_UUID} not found`));

      await expect(service.writeForDevice(DEVICE_UUID)).rejects.toBeInstanceOf(NotFoundException);
      expect(mockIssueBrokkrLiveToken).not.toHaveBeenCalled();
      expect(mockWriteAtomJson).not.toHaveBeenCalled();
    });

    it('writeForDeviceBestEffort swallows resolver BadRequest with a warn log', async () => {
      mockResolveZoneContext.mockRejectedValueOnce(
        new BadRequestException(`Device ${DEVICE_UUID} is not assigned to a zone`),
      );

      await expect(
        service.writeForDeviceBestEffort(DEVICE_UUID, { requestId: REQUEST_ID, opLabel: 'rescue activate' }),
      ).resolves.toBeUndefined();
      expect(mockWriteAtomJson).not.toHaveBeenCalled();
    });
  });
});
