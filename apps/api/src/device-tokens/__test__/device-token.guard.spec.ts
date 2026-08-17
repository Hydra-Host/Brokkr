import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';
import { DeviceTokenContext } from '@repo/database';
import { ContextService } from 'src/common/context/context.service';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { DeviceTokenGuard } from '../device-token.guard';
import { DeviceTokensService } from '../device-tokens.service';

function createExecutionContext(request: { headers: Record<string, string>; ip?: string }): ExecutionContext {
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

describe('DeviceTokenGuard', () => {
  let guard: DeviceTokenGuard;
  let verifyPlaintextToken: Mock;
  let contextService: { deviceIdentity?: unknown };

  beforeEach(async () => {
    verifyPlaintextToken = vi.fn();
    contextService = {};

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DeviceTokenGuard,
        {
          provide: Reflector,
          useValue: { getAllAndOverride: vi.fn().mockReturnValue([DeviceTokenContext.DEPLOYMENT_OS]) },
        },
        { provide: DeviceTokensService, useValue: { verifyPlaintextToken } },
        { provide: ContextService, useValue: contextService },
      ],
    }).compile();

    guard = module.get(DeviceTokenGuard);
  });

  it('rejects missing bearer auth', async () => {
    await expect(guard.canActivate(createExecutionContext({ headers: {} }))).rejects.toThrow(UnauthorizedException);
  });

  it('rejects unknown tokens via service verification', async () => {
    verifyPlaintextToken.mockRejectedValue(new UnauthorizedException('Unknown device token'));
    await expect(
      guard.canActivate(createExecutionContext({ headers: { authorization: 'Bearer unknown-token' } })),
    ).rejects.toThrow(UnauthorizedException);
    expect(verifyPlaintextToken).toHaveBeenCalled();
  });

  it('sets device identity after service verification', async () => {
    const identity = {
      deviceId: 'device-uuid',
      tokenId: 'token-uuid',
      context: DeviceTokenContext.DEPLOYMENT_OS,
      supplierId: 'supplier-uuid',
      zoneId: 'zone-uuid',
      systemUuid: null,
      deploymentId: 'deployment-uuid',
    };
    verifyPlaintextToken.mockResolvedValue(identity);

    await expect(
      guard.canActivate(
        createExecutionContext({
          headers: { authorization: 'Bearer test-os-token', 'user-agent': 'vitest' },
          ip: '127.0.0.1',
        }),
      ),
    ).resolves.toBe(true);

    expect(verifyPlaintextToken).toHaveBeenCalledWith({
      plaintext: 'test-os-token',
      allowedContexts: [DeviceTokenContext.DEPLOYMENT_OS],
      ip: '127.0.0.1',
      userAgent: 'vitest',
    });
    expect(contextService.deviceIdentity).toBe(identity);
  });
});
