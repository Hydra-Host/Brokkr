import { LifecycleGateRejection, type LifecycleGateRejectionKind } from '@hydrahost/plugin-sdk';
import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus } from '@nestjs/common';
import { Request, Response } from 'express';

function httpStatusFor(kind: LifecycleGateRejectionKind | undefined): HttpStatus {
  const resolved = kind ?? 'client';
  switch (resolved) {
    case 'client':
      return HttpStatus.BAD_REQUEST;
    case 'server':
      return HttpStatus.SERVICE_UNAVAILABLE;
    default: {
      const _exhaustive: never = resolved;
      return _exhaustive;
    }
  }
}

@Catch(LifecycleGateRejection)
export class LifecycleGateRejectionFilter implements ExceptionFilter {
  catch(exception: LifecycleGateRejection, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
    const status = httpStatusFor(exception.kind);

    response.status(status).json({
      statusCode: status,
      timestamp: new Date().toISOString(),
      path: request.url,
      message: exception.reason,
    });
  }
}
