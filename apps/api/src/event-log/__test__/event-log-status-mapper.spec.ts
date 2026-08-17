import { ConflictException, ForbiddenException, HttpStatus, NotFoundException } from '@nestjs/common';
import { RecordNotFoundError } from '@repo/active-record';
import { Prisma } from '@repo/database';
import { describe, expect, it } from 'vitest';
import { PRISMA_ERROR_STATUS } from 'src/common/errors/prisma-known-request-exception.filter';
import { resolveErrorCode } from '../event-log-status-mapper';

function prismaError(code: string) {
  return new Prisma.PrismaClientKnownRequestError('boom', { code, clientVersion: 'test' });
}

describe('resolveErrorCode', () => {
  it('maps an HttpException to its own status', () => {
    expect(resolveErrorCode(new NotFoundException('nope'))).toBe('404:NotFoundException');
  });

  it('maps a business 403 to 403 rather than treating it as success', () => {
    expect(resolveErrorCode(new ForbiddenException('Invitation limit reached'))).toBe('403:ForbiddenException');
  });

  it('preserves the exception class alongside the status', () => {
    expect(resolveErrorCode(new ConflictException('dup'))).toBe('409:ConflictException');
  });

  it('maps a unique-constraint violation to conflict', () => {
    expect(resolveErrorCode(prismaError('P2002'))).toBe('409:PrismaClientKnownRequestError');
  });

  it('maps a missing-record violation to not found', () => {
    expect(resolveErrorCode(prismaError('P2025'))).toBe('404:PrismaClientKnownRequestError');
  });

  it('maps a foreign-key violation to conflict, matching the status the filter returns', () => {
    expect(resolveErrorCode(prismaError('P2003'))).toBe('409:PrismaClientKnownRequestError');
  });

  it('maps an out-of-range value to bad request, matching the status the filter returns', () => {
    expect(resolveErrorCode(prismaError('P2020'))).toBe('400:PrismaClientKnownRequestError');
  });

  it('maps a prisma code the filter does not handle to server error', () => {
    expect(resolveErrorCode(prismaError('P2021'))).toBe('500:PrismaClientKnownRequestError');
  });

  it('covers every code the filter maps, with the same status', () => {
    const codes = Object.keys(PRISMA_ERROR_STATUS);
    expect(codes.length).toBeGreaterThan(0);
    for (const code of codes) {
      expect(resolveErrorCode(prismaError(code))).toBe(`${PRISMA_ERROR_STATUS[code]}:PrismaClientKnownRequestError`);
    }
  });

  it('maps an active-record miss to not found', () => {
    expect(resolveErrorCode(new RecordNotFoundError('Device', 'dev-1'))).toBe('404:RecordNotFoundError');
  });

  it('falls back to server error for an unknown error', () => {
    expect(resolveErrorCode(new Error('boom'))).toBe(`${HttpStatus.INTERNAL_SERVER_ERROR}:Error`);
  });

  it('does not throw on a non-error value', () => {
    expect(resolveErrorCode('a string')).toBe(`${HttpStatus.INTERNAL_SERVER_ERROR}:UnknownError`);
  });

  it('never includes the message, which can carry user data', () => {
    expect(resolveErrorCode(new NotFoundException('user@example.com not found'))).not.toContain('user@example.com');
  });
});
