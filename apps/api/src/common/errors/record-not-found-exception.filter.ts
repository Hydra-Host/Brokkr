import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus } from '@nestjs/common';
import { RecordNotFoundError } from '@repo/active-record';
import { Request, Response } from 'express';

@Catch(RecordNotFoundError)
export class RecordNotFoundExceptionFilter implements ExceptionFilter {
  catch(exception: RecordNotFoundError, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    response.status(HttpStatus.NOT_FOUND).json({
      statusCode: HttpStatus.NOT_FOUND,
      timestamp: new Date().toISOString(),
      path: request.url,
      message: 'Resource not found',
    });
  }
}
