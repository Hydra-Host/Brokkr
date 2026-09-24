import type { NextFunction, Request, Response } from 'express';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { bodyParserErrorHandler } from '../body-parser-error-handler.middleware';

describe('bodyParserErrorHandler', () => {
  let status: Mock;
  let json: Mock;
  let res: Response;
  let next: NextFunction;
  const req = { url: '/api/v1/deployments' } as Request;

  beforeEach(() => {
    json = vi.fn();
    status = vi.fn().mockReturnValue({ json });
    res = { status, json } as unknown as Response;
    next = vi.fn();
  });

  it('maps an oversized body (entity.too.large) to 413', () => {
    const err = Object.assign(new Error('too big'), { type: 'entity.too.large', statusCode: 413 });

    bodyParserErrorHandler(err, req, res, next);

    expect(status).toHaveBeenCalledWith(413);
    expect(json).toHaveBeenCalledWith({
      statusCode: 413,
      timestamp: expect.any(String),
      path: '/api/v1/deployments',
      message: 'Payload Too Large',
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('maps a malformed body (entity.parse.failed) to 400', () => {
    const err = Object.assign(new SyntaxError('Unexpected token'), { type: 'entity.parse.failed' });

    bodyParserErrorHandler(err, req, res, next);

    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith({
      statusCode: 400,
      timestamp: expect.any(String),
      path: '/api/v1/deployments',
      message: 'Malformed request body',
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('maps a bare SyntaxError (no type tag) to 400', () => {
    bodyParserErrorHandler(new SyntaxError('bad json'), req, res, next);

    expect(status).toHaveBeenCalledWith(400);
    expect(next).not.toHaveBeenCalled();
  });

  it('maps a numeric-status body-parser error (413, no type tag) to 413', () => {
    const err = Object.assign(new Error('too big'), { status: 413 });

    bodyParserErrorHandler(err, req, res, next);

    expect(status).toHaveBeenCalledWith(413);
    expect(json).toHaveBeenCalledWith({
      statusCode: 413,
      timestamp: expect.any(String),
      path: '/api/v1/deployments',
      message: 'Payload Too Large',
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('delegates to next without writing when the response has already begun streaming', () => {
    const err = Object.assign(new SyntaxError('bad json'), { type: 'entity.parse.failed' });
    res = { status, json, headersSent: true } as unknown as Response;

    bodyParserErrorHandler(err, req, res, next);

    expect(next).toHaveBeenCalledWith(err);
    expect(status).not.toHaveBeenCalled();
  });

  it('re-raises unrelated errors to the next handler', () => {
    const err = new Error('database exploded');

    bodyParserErrorHandler(err, req, res, next);

    expect(next).toHaveBeenCalledWith(err);
    expect(status).not.toHaveBeenCalled();
  });
});
