import { ArgumentsHost, HttpStatus, Logger } from '@nestjs/common';
import { Prisma } from '@repo/database';
import { describe, expect, it, vi } from 'vitest';
import { PrismaKnownRequestExceptionFilter } from '../prisma-known-request-exception.filter';

function host(url = '/api/v1/tags') {
  const json = vi.fn();
  const status = vi.fn().mockReturnValue({ json });
  const argsHost = {
    switchToHttp: () => ({
      getResponse: () => ({ status }),
      getRequest: () => ({ url, method: 'POST' }),
    }),
  } as unknown as ArgumentsHost;
  return { argsHost, status, json };
}

const err = (code: string, meta?: Record<string, unknown>) =>
  new Prisma.PrismaClientKnownRequestError('db error', { code, clientVersion: 'test', meta });

describe('PrismaKnownRequestExceptionFilter', () => {
  const filter = new PrismaKnownRequestExceptionFilter();

  it('maps a unique-constraint violation (P2002) to 409', () => {
    const { argsHost, status, json } = host();
    filter.catch(err('P2002', { target: ['organizationId', 'slug'] }), argsHost);
    expect(status).toHaveBeenCalledWith(HttpStatus.CONFLICT);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 409, message: 'Resource already exists' }));
  });

  it('maps a foreign-key violation (P2003) to 409', () => {
    const { argsHost, status } = host();
    filter.catch(err('P2003'), argsHost);
    expect(status).toHaveBeenCalledWith(HttpStatus.CONFLICT);
  });

  it('maps a missing-record violation (P2025) to 404', () => {
    const { argsHost, status } = host();
    filter.catch(err('P2025'), argsHost);
    expect(status).toHaveBeenCalledWith(HttpStatus.NOT_FOUND);
  });

  it('maps a numeric-out-of-range violation (P2020) to 400', () => {
    const { argsHost, status, json } = host();
    filter.catch(err('P2020'), argsHost);
    expect(status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 400, message: 'A value is out of the allowed range' }),
    );
  });

  it('never leaks the offending column/model to the client', () => {
    const { argsHost, json } = host();
    filter.catch(err('P2002', { target: ['organizationId', 'slug'] }), argsHost);
    expect(JSON.stringify(json.mock.calls[0][0])).not.toContain('slug');
  });

  it('logs the code + meta server-side for diagnosis (never in the client body)', () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { argsHost } = host();
    filter.catch(err('P2002', { target: ['organizationId', 'slug'] }), argsHost);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toContain('P2002');
    expect(warn.mock.calls[0][0]).toContain('slug');
    warn.mockRestore();
  });

  it('rethrows codes it does not map so they stay 500 rather than a misleading 4xx', () => {
    const { argsHost } = host();
    expect(() => filter.catch(err('P2000'), argsHost)).toThrow();
  });
});
