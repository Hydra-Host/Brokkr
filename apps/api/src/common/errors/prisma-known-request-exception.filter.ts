import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus, Logger } from '@nestjs/common';
import { Prisma } from '@repo/database';
import { Request, Response } from 'express';

const CODE_STATUS: Record<string, { status: HttpStatus; message: string }> = {
  P2002: { status: HttpStatus.CONFLICT, message: 'Resource already exists' },
  P2003: { status: HttpStatus.CONFLICT, message: 'Request conflicts with a related resource' },
  P2020: { status: HttpStatus.BAD_REQUEST, message: 'A value is out of the allowed range' },
  P2025: { status: HttpStatus.NOT_FOUND, message: 'Resource not found' },
};

// Status-only projection of CODE_STATUS: consumers that must mirror the client-facing
// status (the audit log) read this instead of keeping their own list of codes.
export const PRISMA_ERROR_STATUS: Record<string, HttpStatus> = Object.fromEntries(
  Object.entries(CODE_STATUS).map(([code, { status }]) => [code, status]),
);

@Catch(Prisma.PrismaClientKnownRequestError)
export class PrismaKnownRequestExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(PrismaKnownRequestExceptionFilter.name);

  catch(exception: Prisma.PrismaClientKnownRequestError, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const mapped = CODE_STATUS[exception.code];
    if (!mapped) throw exception;

    // Offending model/column stays server-side only, never echoed to the client.
    this.logger.warn(
      `Prisma ${exception.code} on ${request.method} ${request.url} → ${mapped.status}: ${JSON.stringify(exception.meta ?? {})}`,
    );

    response.status(mapped.status).json({
      statusCode: mapped.status,
      timestamp: new Date().toISOString(),
      path: request.url,
      message: mapped.message,
    });
  }
}
