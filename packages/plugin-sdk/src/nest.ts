import {
  applyDecorators,
  type CanActivate,
  type ExecutionContext,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  InternalServerErrorException,
  SetMetadata,
  UseGuards,
} from '@nestjs/common';

import { PLUGIN_RATE_LIMITER, type PluginRateLimiter, type PluginRateLimitPolicy } from './plugin-rate-limiter';

export const PublicRoute = () => SetMetadata('isPublic', true);

export { PLUGIN_OPERATOR_ADMIN_ORG, PluginOperatorGuard } from './operator-guard';

const RATE_LIMIT_POLICY = Symbol.for('@hydrahost/plugin-sdk/RATE_LIMIT_POLICY');

function isRateLimitPolicy(value: unknown): value is PluginRateLimitPolicy {
  return (
    typeof value === 'object' &&
    value !== null &&
    'name' in value &&
    typeof value.name === 'string' &&
    value.name !== '' &&
    'limit' in value &&
    typeof value.limit === 'number' &&
    Number.isSafeInteger(value.limit) &&
    value.limit > 0 &&
    'windowSeconds' in value &&
    typeof value.windowSeconds === 'number' &&
    Number.isSafeInteger(value.windowSeconds) &&
    value.windowSeconds > 0
  );
}

@Injectable()
export class PluginRateLimitGuard implements CanActivate {
  constructor(@Inject(PLUGIN_RATE_LIMITER) private readonly rateLimiter: PluginRateLimiter) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const policy: unknown = Reflect.getMetadata(RATE_LIMIT_POLICY, context.getHandler());
    if (!isRateLimitPolicy(policy)) {
      throw new InternalServerErrorException('Plugin rate limit policy is invalid');
    }

    const request = context.switchToHttp().getRequest<{ ip?: string }>();
    if (!request.ip) {
      throw new InternalServerErrorException('Plugin rate limit request identity is unavailable');
    }

    const result = await this.rateLimiter.consume({ ...policy, subject: request.ip });
    if (!result.allowed) {
      context
        .switchToHttp()
        .getResponse<{ setHeader(name: string, value: string): void }>()
        .setHeader('Retry-After', String(result.retryAfterSeconds));
      throw new HttpException(
        { statusCode: HttpStatus.TOO_MANY_REQUESTS, message: 'Too many requests, please try again shortly' },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    return true;
  }
}

export const PluginRateLimit = (policy: PluginRateLimitPolicy) =>
  applyDecorators(SetMetadata(RATE_LIMIT_POLICY, policy), UseGuards(PluginRateLimitGuard));
