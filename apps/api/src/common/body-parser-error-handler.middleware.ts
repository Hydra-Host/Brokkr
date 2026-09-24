import { isRecord } from '@repo/utils';
import { NextFunction, Request, Response } from 'express';

export function bodyParserErrorHandler(error: unknown, req: Request, res: Response, next: NextFunction): void {
  if (res.headersSent) {
    next(error);
    return;
  }
  if (isBodyParserError(error)) {
    const status = error.status === 413 || error.type === 'entity.too.large' ? 413 : 400;
    res.status(status).json({
      statusCode: status,
      timestamp: new Date().toISOString(),
      path: req.url,
      message: status === 413 ? 'Payload Too Large' : 'Malformed request body',
    });
    return;
  }
  next(error);
}

function isBodyParserError(error: unknown): error is { status?: number; type?: string } {
  if (!isRecord(error)) return false;
  const isSyntaxError = error instanceof SyntaxError;
  const hasParserStatus = error.status === 400 || error.status === 413;
  const hasParserType = error.type === 'entity.parse.failed' || error.type === 'entity.too.large';
  return isSyntaxError || hasParserStatus || hasParserType;
}
