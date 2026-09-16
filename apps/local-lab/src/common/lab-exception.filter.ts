import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { getErrorMessage } from '@repo/utils';
import { RequestValidationError } from '@ts-rest/nest';
import type { Response } from 'express';

// Global catch-all rendering every escaped exception as the contract's { error: string } body:
// HttpExceptions keep their own status, everything else becomes a 500.
@Catch()
export class LabExceptionFilter implements ExceptionFilter {
  private readonly log = new Logger(LabExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    // SSE/streaming routes can fail mid-stream; writing a JSON body after headers went out would
    // throw inside the filter itself — log the exception (nowhere else to surface) and skip the write.
    if (res.headersSent) {
      this.log.error(getErrorMessage(exception), exception instanceof Error ? exception.stack : undefined);
      return;
    }
    // ts-rest request validation carries structured zod issues the client can
    // render field-by-field — pass its payload through instead of flattening.
    if (exception instanceof RequestValidationError) {
      res.status(exception.getStatus()).json(exception.getResponse());
      return;
    }
    if (exception instanceof HttpException) {
      res.status(exception.getStatus()).json({ error: getErrorMessage(exception) });
      return;
    }
    // nest's default handler would have logged unknown exceptions; keep that signal.
    this.log.error(getErrorMessage(exception), exception instanceof Error ? exception.stack : undefined);
    res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({ error: getErrorMessage(exception) });
  }
}
