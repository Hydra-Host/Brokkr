import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus, Logger } from '@nestjs/common';
import { TenantContextRequiredError } from '@repo/active-record';
import { Request, Response } from 'express';

// Always a programming error, never user input — client gets a generic 500; model/tenantField stay server-side only.
@Catch(TenantContextRequiredError)
export class TenantContextRequiredExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(TenantContextRequiredExceptionFilter.name);

  catch(exception: TenantContextRequiredError, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    this.logger.error(
      `Tenant context missing for scoped read on '${exception.model}.${exception.tenantField}' at ${request.method} ${request.url}`,
      exception.stack,
    );

    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      timestamp: new Date().toISOString(),
      path: request.url,
      message: 'Internal server error',
    });
  }
}
