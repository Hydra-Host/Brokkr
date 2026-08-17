import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import type { Response } from 'express';

import { RedfishError } from './fleet-power.service';

@Catch(RedfishError, HttpException)
export class RedfishExceptionFilter implements ExceptionFilter {
  catch(exception: RedfishError | HttpException, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const status = exception instanceof HttpException ? exception.getStatus() : HttpStatus.BAD_GATEWAY;
    res.status(status).json({ error: exception.message });
  }
}
