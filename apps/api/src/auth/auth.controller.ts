import { All, Controller, ForbiddenException, Inject, Post, Req, Res } from '@nestjs/common';
import { API_PREFIX } from '@repo/api-client';
import { INTERNAL_CLIENT_IP_HEADER, type AuthClient } from '@repo/auth';
import { sleep } from '@repo/utils';
import { toNodeHandler } from 'better-auth/node';
import type { Request, Response } from 'express';
import { Public } from './decorators/public.decorator';

@Controller(`${API_PREFIX.slice(1)}/auth`)
@Public()
export class AuthController {
  constructor(@Inject('AUTH_CLIENT') private readonly authClient: AuthClient) {}

  // Overwrite the internal client-IP header with req.ip so Better Auth's rate limiter keys on a non-spoofable IP.
  private stampClientIp(req: Request): void {
    delete req.headers[INTERNAL_CLIENT_IP_HEADER];
    if (req.ip) req.headers[INTERNAL_CLIENT_IP_HEADER] = req.ip;
  }

  @Post('sign-up/email')
  async handleSignUp(@Req() req: Request, @Res() res: Response) {
    this.stampClientIp(req);
    const authClient = this.authClient;
    const handler = toNodeHandler(async (webRequest) => {
      const webResponse = await authClient.handler(webRequest);

      if (webResponse.status === 422) {
        const clone = webResponse.clone();
        const body = await clone.text();
        if (body.includes('USER_ALREADY_EXISTS')) {
          const headers = new Headers(webResponse.headers);
          headers.set('content-type', 'application/json');
          headers.delete('content-length');
          return new globalThis.Response(JSON.stringify({ status: true }), {
            status: 200,
            headers,
          });
        }
      }

      return webResponse;
    });
    return handler(req, res);
  }

  @Post('request-password-reset')
  async handleRequestPasswordReset(@Req() req: Request, @Res() res: Response) {
    this.stampClientIp(req);
    const MINIMUM_RESPONSE_MS = 500;
    const start = Date.now();

    const authClient = this.authClient;
    const handler = toNodeHandler(async (webRequest) => {
      const webResponse = await authClient.handler(webRequest);

      const elapsed = Date.now() - start;
      if (elapsed < MINIMUM_RESPONSE_MS) {
        await sleep(MINIMUM_RESPONSE_MS - elapsed);
      }

      return webResponse;
    });
    return handler(req, res);
  }

  @All('organization/*path')
  blockBuiltInOrganizationEndpoints(): never {
    throw new ForbiddenException(
      'Better Auth built-in organization endpoints are disabled; use the /organizations REST API',
    );
  }

  @All('api-key/*path')
  blockBuiltInApiKeyEndpoints(): never {
    throw new ForbiddenException('Better Auth built-in api-key endpoints are disabled; use /organizations/api-keys');
  }

  @All('*path')
  async handleAuth(@Req() req: Request, @Res() res: Response) {
    this.stampClientIp(req);
    const handler = toNodeHandler(this.authClient);
    return handler(req, res);
  }
}
