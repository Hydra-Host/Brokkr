import { HttpException, HttpStatus } from '@nestjs/common';
import { RecordNotFoundError } from '@repo/active-record';
import { Prisma } from '@repo/database';
import { PRISMA_ERROR_STATUS } from 'src/common/errors/prisma-known-request-exception.filter';

/** The interceptor runs outside the exception filters, so it cannot read the status the client receives. */
export function resolveErrorCode(error: unknown): string {
  const name = error instanceof Error ? error.constructor.name : 'UnknownError';

  if (error instanceof HttpException) {
    return `${error.getStatus()}:${name}`;
  }
  if (error instanceof RecordNotFoundError) {
    return `${HttpStatus.NOT_FOUND}:${name}`;
  }
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    return `${PRISMA_ERROR_STATUS[error.code] ?? HttpStatus.INTERNAL_SERVER_ERROR}:${name}`;
  }
  // No message: it can carry user data and is unstable across refactors.
  return `${HttpStatus.INTERNAL_SERVER_ERROR}:${name}`;
}
