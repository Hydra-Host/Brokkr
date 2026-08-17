import { createParamDecorator, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Request } from 'express';
import type { SessionUser } from 'src/common/context/context.service';

export const CurrentSessionUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): SessionUser => {
  const request = ctx.switchToHttp().getRequest<Request>();
  if (!request.user) {
    throw new UnauthorizedException('Session user context is missing');
  }
  return request.user;
});
