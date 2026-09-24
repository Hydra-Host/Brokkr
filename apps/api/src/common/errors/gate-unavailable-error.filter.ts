import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus, Logger } from '@nestjs/common';
import { Request, Response } from 'express';
import { GateUnavailableError } from 'src/plugin-host/host-plugin-gate-bus';

@Catch(GateUnavailableError)
export class GateUnavailableErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(GateUnavailableErrorFilter.name);

  catch(exception: GateUnavailableError, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    this.logger.warn(
      `Gate "${exception.gate}" unavailable (plugin "${exception.pluginId}") at ${request.method} ${request.url}`,
    );

    response.status(HttpStatus.SERVICE_UNAVAILABLE).json({
      statusCode: HttpStatus.SERVICE_UNAVAILABLE,
      timestamp: new Date().toISOString(),
      path: request.url,
      message: 'Authorization is currently unavailable; try again shortly',
    });
  }
}
