import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { DeviceTokenContext } from '@repo/database';
import { ContextService } from 'src/common/context/context.service';
import { DeviceTokensService } from 'src/device-tokens/device-tokens.service';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { PhoneHomeGuard, type PhoneHomeRequest } from '../phone-home.guard';

function createExecutionContext(request: Partial<PhoneHomeRequest>): ExecutionContext {
  return {
    getClass: vi.fn(),
    getHandler: vi.fn(),
    getArgs: vi.fn().mockReturnValue([request]),
    getArgByIndex: vi.fn().mockImplementation((index: number) => [request][index]),
    switchToRpc: vi.fn(),
    switchToHttp: vi.fn().mockReturnValue({
      getRequest: () => request,
      getResponse: vi.fn(),
      getNext: vi.fn(),
    }),
    switchToWs: vi.fn(),
    getType: vi.fn().mockReturnValue('http'),
  };
}

describe('PhoneHomeGuard', () => {
  let guard: PhoneHomeGuard;
  let deviceTokensService: { verifyPlaintextToken: Mock };
  let contextService: { deviceIdentity?: unknown };

  beforeEach(async () => {
    deviceTokensService = {
      verifyPlaintextToken: vi.fn(),
    };
    contextService = {};

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PhoneHomeGuard,
        { provide: DeviceTokensService, useValue: deviceTokensService },
        { provide: ContextService, useValue: contextService },
      ],
    }).compile();

    guard = module.get(PhoneHomeGuard);
  });

  it('sets phoneHome.deviceId from a valid bearer token', async () => {
    const request: Partial<PhoneHomeRequest> = {
      headers: { authorization: 'Bearer test-os-token-123' },
    };

    deviceTokensService.verifyPlaintextToken.mockResolvedValue({
      deviceId: 'device-uuid',
      tokenId: 'token-uuid',
      context: DeviceTokenContext.DEPLOYMENT_OS,
      supplierId: 'supplier-uuid',
      zoneId: 'zone-uuid',
      systemUuid: null,
      deploymentId: 'deployment-uuid',
    });

    await expect(guard.canActivate(createExecutionContext(request))).resolves.toBe(true);
    expect(deviceTokensService.verifyPlaintextToken).toHaveBeenCalledWith(
      expect.objectContaining({ plaintext: 'test-os-token-123' }),
    );
    expect(contextService.deviceIdentity).toEqual(expect.objectContaining({ deviceId: 'device-uuid' }));
    expect(request.phoneHome).toEqual({ deviceId: 'device-uuid' });
  });

  it('rejects requests missing bearer auth', async () => {
    const request: Partial<PhoneHomeRequest> = { headers: {} };

    await expect(guard.canActivate(createExecutionContext(request))).rejects.toThrow(UnauthorizedException);
  });

  it('rejects requests with an invalid authorization header', async () => {
    const request: Partial<PhoneHomeRequest> = {
      headers: { authorization: 'Basic dXNlcjpwYXNz' },
    };

    await expect(guard.canActivate(createExecutionContext(request))).rejects.toThrow(UnauthorizedException);
  });

  it('rejects requests when token verification fails', async () => {
    const request: Partial<PhoneHomeRequest> = {
      headers: { authorization: 'Bearer invalid-token' },
    };

    deviceTokensService.verifyPlaintextToken.mockRejectedValue(new UnauthorizedException('Invalid token'));

    await expect(guard.canActivate(createExecutionContext(request))).rejects.toThrow(UnauthorizedException);
  });
});
