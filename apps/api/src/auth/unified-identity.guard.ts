import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { AuthClient } from '@repo/auth';
import { RbacResolverService } from '@repo/auth/rbac';
import { Request } from 'express';
import { ContextService } from 'src/common/context/context.service';
import { Logger } from 'src/common/decorators/logger.decorator';
import { LoggerService } from 'src/logger/logger.service';
import { PrismaClient } from 'src/prisma/prisma.client';
import { buildApiKeyIdentityContext } from './api-key-identity';
import { AuthRepository } from './auth.repo';
import { IS_PUBLIC_KEY } from './decorators/public.decorator';
import { IS_SESSION_ONLY_KEY } from './decorators/session-only.decorator';
import { AuthType, IdentityContext } from './identity-context';
import { assertOrganizationNotDeleted, assertUserNotBanned } from './identity-guards';

@Injectable()
export class UnifiedIdentityGuard implements CanActivate {
  private readonly suppressExpectedSessionErrors: boolean;

  constructor(
    @Inject('AUTH_CLIENT') private readonly authClient: AuthClient,
    private readonly repo: AuthRepository,
    private readonly prisma: PrismaClient,
    private readonly reflector: Reflector,
    private readonly contextService: ContextService,
    private readonly rbacResolver: RbacResolverService,
    private readonly configService: ConfigService,
    @Logger(UnifiedIdentityGuard.name) protected readonly logger: LoggerService,
  ) {
    this.suppressExpectedSessionErrors = this.configService.get<string>('SUPPRESS_EXPECTED_AUTH_ERRORS') === 'true';
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    const isSessionOnly = this.reflector.getAllAndOverride<boolean>(IS_SESSION_ONLY_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    const req = context.switchToHttp().getRequest() as Request;
    const authType = this.resolveAuthType(req);

    if (isSessionOnly) {
      const session = await this.authClient.api.getSession({
        headers: req.headers as Record<string, string>,
      });
      if (!session) {
        this.logExpectedSessionError('Unable to find valid session');
        throw new UnauthorizedException();
      }
      await this.rejectIfBanned(session.user.id);
      // Better Auth marks the name fields required, but the columns stayed nullable — coalesce here so
      // `SessionUser` is not asserting an invariant the database never enforced.
      const sessionUser = {
        id: session.user.id,
        email: session.user.email,
        firstName: session.user.firstName ?? '',
        lastName: session.user.lastName ?? '',
      };
      req.user = sessionUser;
      this.contextService.sessionUser = sessionUser;
      return true;
    }

    const identityContext = await (async () => {
      switch (authType) {
        case AuthType.ApiKey:
          return this.createApiKeyBasedIdentityContext(req);
        case AuthType.Session:
          return this.createSessionBasedIdentityContext(req);
        default:
          throw new UnauthorizedException();
      }
    })();

    this.contextService.identity = Object.freeze(identityContext);

    return true;
  }

  private resolveAuthType(req: Request): AuthType {
    const apiKey = req.headers['x-api-key'] as string;

    if (apiKey) {
      return AuthType.ApiKey;
    }

    return AuthType.Session;
  }

  private async createSessionBasedIdentityContext(req: Request): Promise<IdentityContext> {
    const session = await this.authClient.api.getSession({
      headers: req.headers as Record<string, string>,
    });
    if (!session) {
      this.logExpectedSessionError('Unable to find valid session');
      throw new UnauthorizedException();
    }

    const activeOrganizationId = (session.session as { activeOrganizationId?: string }).activeOrganizationId;
    const userId = session.user.id;

    if (!activeOrganizationId || !userId) {
      this.logExpectedSessionError('Session is missing active organization ID or user ID');
      throw new UnauthorizedException();
    }

    const member = await this.repo.findOrganizationMember(userId, activeOrganizationId);
    if (!member) {
      this.logger.error('Unable to find a matching member record for provided user and organization ID');
      throw new UnauthorizedException();
    }

    assertOrganizationNotDeleted(member.organization);
    assertUserNotBanned(member.user);

    const permissions = await this.rbacResolver.resolveEffectivePermissions(member.assignedRoleId);

    return {
      authType: AuthType.Session,
      organizationId: activeOrganizationId,
      organization: member.organization,
      role: member.role,
      assignedRoleId: member.assignedRoleId,
      permissions,
      session,
    };
  }

  private async rejectIfBanned(userId: string): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { banned: true, banExpires: true },
    });
    if (user) assertUserNotBanned(user);
  }

  private logExpectedSessionError(message: string): void {
    if (this.suppressExpectedSessionErrors) {
      return;
    }
    this.logger.error(message);
  }

  private async createApiKeyBasedIdentityContext(req: Request): Promise<IdentityContext> {
    const apiKey = req.headers['x-api-key'] as string;
    if (!apiKey) {
      this.logger.error('No API key provided in headers');
      throw new UnauthorizedException();
    }

    const result = await this.authClient.api.verifyApiKey({
      body: {
        key: apiKey,
      },
    });

    if (!result.valid || result.error) {
      if (result.error?.code === 'RATE_LIMITED') {
        this.logger.warn(`API key rate limited: ${result.error.message}`);
        throw new HttpException(
          {
            statusCode: HttpStatus.TOO_MANY_REQUESTS,
            message: 'Too many requests, please try again later.',
            error: 'Rate limit exceeded',
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      this.logger.error('Invalid API Key');
      const errorMessage = result.error ? `${result.error.code} ${result.error.message}` : 'No error message provided';
      this.logger.error(errorMessage);
      throw new UnauthorizedException();
    }

    const key = result.key;
    if (!key?.id || !key.referenceId) {
      this.logger.error('API key verification returned no key object');
      throw new UnauthorizedException();
    }

    return buildApiKeyIdentityContext(
      { id: key.id, referenceId: key.referenceId, name: key.name },
      {
        prisma: this.prisma,
        repo: this.repo,
        rbacResolver: this.rbacResolver,
        logger: this.logger,
      },
    );
  }
}
