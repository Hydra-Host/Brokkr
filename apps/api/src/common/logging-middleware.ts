import { Injectable, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { Logger } from 'src/common/decorators/logger.decorator';
import { LoggerService } from 'src/logger/logger.service';

@Injectable()
export class LoggingMiddleware implements NestMiddleware {
  constructor(@Logger(LoggingMiddleware.name) private readonly logger: LoggerService) {}
  use(req: Request, res: Response, next: NextFunction) {
    const { ip, method, originalUrl } = req;
    const userAgent = req.get('user-agent') || '';
    const requestId = req['requestId'];

    const isLoopback = ip === '::1' || ip === '127.0.0.1' || ip === '::ffff:127.0.0.1';
    if (originalUrl === '/healthcheck' && (/Azure Traffic Manager|Nomad\//i.test(userAgent) || isLoopback)) {
      return next();
    }

    res.on('finish', () => {
      const { statusCode } = res;
      const contentLength = res.get('content-length');

      this.logger.log(
        `${method} ${originalUrl} ${statusCode} ${contentLength} - ${userAgent} ${ip} - RequestID: ${requestId}`,
      );
    });

    next();
  }
}
