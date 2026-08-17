import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import { isRecord } from '@repo/utils';
import { Request, Response } from 'express';
import { getErrorMessage } from '../error-utils';

@Catch(HttpException)
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: HttpException, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
    const status = exception.getStatus();
    const exceptionResponse = exception.getResponse();

    if (exception.cause !== undefined) {
      this.logger.error(`${request.method} ${request.url} -> ${status}: ${getErrorMessage(exception.cause)}`);
    }

    const responseBody: Record<string, unknown> = {
      statusCode: status,
      timestamp: new Date().toISOString(),
      path: request.url,
      message: exception.message,
    };

    if (isRecord(exceptionResponse)) {
      if (exceptionResponse.message !== undefined) {
        responseBody.message = exceptionResponse.message;
      }
      if (exceptionResponse.error !== undefined) {
        responseBody.error = exceptionResponse.error;
      }
    }

    response.status(status).json(responseBody);
  }
}
