import { Injectable, NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { NextFunction, Request, Response } from 'express';
import { ContextService } from './context.service';

@Injectable()
export class ContextMiddleware implements NestMiddleware {
  constructor(private readonly contextService: ContextService) {}

  use(req: Request, _res: Response, next: NextFunction) {
    const requestId = randomUUID();
    (req as any).requestId = requestId;

    // This middleware is mounted on a wildcard, so express strips req.path/req.url down to '/';
    // originalUrl minus the query is what the request would read as `req.path` at handler time.
    this.contextService.run(
      {
        requestId,
        method: req.method,
        path: req.originalUrl.split('?')[0],
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
      },
      () => {
        next();
      },
    );
  }
}
