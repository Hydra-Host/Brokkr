import { ForbiddenException } from '@nestjs/common';
import type { AuthClient } from '@repo/auth';
import { INTERNAL_CLIENT_IP_HEADER } from '@repo/auth';
import type { Request, Response } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const captured: { req?: Request } = {};
vi.mock('better-auth/node', () => ({
  toNodeHandler: () => (req: Request) => {
    captured.req = req;
    return Promise.resolve();
  },
}));

import { AuthController } from '../auth.controller';

function fakeRequest(ip: string | undefined, headers: Record<string, string>): Request {
  return { ip, headers } as unknown as Request;
}

describe('AuthController client-IP stamping', () => {
  let controller: AuthController;
  const res = {} as Response;

  beforeEach(() => {
    captured.req = undefined;
    controller = new AuthController({} as AuthClient);
  });

  it('stamps the peer IP into the internal header on the catch-all handler', async () => {
    const req = fakeRequest('203.0.113.7', {});
    await controller.handleAuth(req, res);
    expect(captured.req?.headers[INTERNAL_CLIENT_IP_HEADER]).toBe('203.0.113.7');
  });

  it('overwrites a client-supplied internal header so it cannot be spoofed', async () => {
    const req = fakeRequest('203.0.113.7', { [INTERNAL_CLIENT_IP_HEADER]: '10.0.0.1' });
    await controller.handleAuth(req, res);
    expect(captured.req?.headers[INTERNAL_CLIENT_IP_HEADER]).toBe('203.0.113.7');
  });

  it('drops the internal header entirely when no peer IP is resolved', async () => {
    const req = fakeRequest(undefined, { [INTERNAL_CLIENT_IP_HEADER]: '10.0.0.1' });
    await controller.handleAuth(req, res);
    expect(captured.req?.headers[INTERNAL_CLIENT_IP_HEADER]).toBeUndefined();
  });

  it('stamps the peer IP on the sign-up handler', async () => {
    const req = fakeRequest('198.51.100.4', { [INTERNAL_CLIENT_IP_HEADER]: '10.0.0.2' });
    await controller.handleSignUp(req, res);
    expect(captured.req?.headers[INTERNAL_CLIENT_IP_HEADER]).toBe('198.51.100.4');
  });
});

describe('AuthController built-in organization block', () => {
  const controller = new AuthController({} as AuthClient);

  it('blocks every Better Auth built-in organization endpoint', () => {
    expect(() => controller.blockBuiltInOrganizationEndpoints()).toThrow(ForbiddenException);
  });
});

describe('AuthController built-in api-key block', () => {
  const controller = new AuthController({} as AuthClient);

  it('blocks every Better Auth built-in api-key endpoint', () => {
    expect(() => controller.blockBuiltInApiKeyEndpoints()).toThrow(ForbiddenException);
  });
});
