import { ExecutionContext } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import type { CreateDeviceDiagnosticsRequest } from '@repo/api-client';
import { DeviceTokenContext } from '@repo/database';
import { ContextService } from 'src/common/context/context.service';
import { DeviceTokensService } from 'src/device-tokens/device-tokens.service';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { PhoneHomeController } from '../phone-home.controller';
import { PhoneHomeGuard, type PhoneHomeRequest } from '../phone-home.guard';
import { PhoneHomeService } from '../phone-home.service';

const DEVICE_ID = 'device-uuid-777';

function makeExecutionContext(request: Partial<PhoneHomeRequest>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe('PhoneHomeController + PhoneHomeGuard pipeline', () => {
  let controller: PhoneHomeController;
  let guard: PhoneHomeGuard;
  let phoneHomeService: { execute: Mock; createDeviceDiagnostics: Mock };
  let deviceTokensService: { verifyPlaintextToken: Mock };
  let contextService: { deviceIdentity?: { deviceId: string; context: DeviceTokenContext } };

  beforeEach(async () => {
    phoneHomeService = {
      execute: vi.fn().mockResolvedValue({ deviceId: DEVICE_ID }),
      createDeviceDiagnostics: vi.fn().mockResolvedValue({
        id: 'diag-1',
        deploymentId: 'dep-1',
        type: 'Health',
        data: { errors: 1 },
      }),
    };
    deviceTokensService = {
      verifyPlaintextToken: vi.fn().mockResolvedValue({ deviceId: DEVICE_ID, context: DeviceTokenContext.BROKKR_LIVE }),
    };
    contextService = {};

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PhoneHomeController,
        PhoneHomeGuard,
        { provide: PhoneHomeService, useValue: phoneHomeService },
        { provide: DeviceTokensService, useValue: deviceTokensService },
        { provide: ContextService, useValue: contextService },
        {
          provide: 'LoggerServicePhoneHomeController',
          useValue: {
            log: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
            debug: vi.fn(),
            setContext: vi.fn().mockReturnThis(),
          },
        },
      ],
    }).compile();

    controller = module.get(PhoneHomeController);
    guard = module.get(PhoneHomeGuard);
  });

  it('guard verifies the bearer token and stamps req.phoneHome.deviceId from the verified identity', async () => {
    const request: Partial<PhoneHomeRequest> = { headers: { authorization: 'Bearer live-token' }, ip: '10.0.0.9' };

    const allowed = await guard.canActivate(makeExecutionContext(request));

    expect(allowed).toBe(true);
    expect(deviceTokensService.verifyPlaintextToken).toHaveBeenCalledWith(
      expect.objectContaining({
        plaintext: 'live-token',
        allowedContexts: [DeviceTokenContext.BROKKR_LIVE, DeviceTokenContext.DEPLOYMENT_OS],
      }),
    );
    expect(request.phoneHome).toEqual({ deviceId: DEVICE_ID });
    expect(contextService.deviceIdentity).toEqual({ deviceId: DEVICE_ID, context: DeviceTokenContext.BROKKR_LIVE });
  });

  it('phoneHome handler processes the guard-resolved device id (never a client-supplied one)', async () => {
    const request = { phoneHome: { deviceId: DEVICE_ID } } as PhoneHomeRequest;

    const handler = await controller.phoneHome(request);
    const res = await handler({ headers: {} });

    expect(phoneHomeService.execute).toHaveBeenCalledWith(DEVICE_ID);
    expect(res.status).toBe(200);
  });

  it('createDeviceDiagnostics handler routes the body to the guard-resolved device id', async () => {
    const request = { phoneHome: { deviceId: DEVICE_ID } } as PhoneHomeRequest;
    const body: CreateDeviceDiagnosticsRequest = { type: 'Health', data: { errors: 1 } };

    const handler = await controller.createDeviceDiagnostics(request);
    const res = await handler({ body, headers: {} });

    expect(phoneHomeService.createDeviceDiagnostics).toHaveBeenCalledWith(DEVICE_ID, body);
    expect(res.status).toBe(201);
  });
});
