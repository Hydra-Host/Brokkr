import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Optional,
} from '@nestjs/common';

import { getLogger } from '../../logger/logger.service';

interface MinimalRequest {
  readonly ip?: string;
  readonly originalUrl: string;
  readonly socket?: { readonly remoteAddress?: string };
}
interface MinimalResponse {
  status(code: number): MinimalResponse;
  json(body: unknown): MinimalResponse;
}

export const HTTP_EXCEPTION_LOGGER = Symbol('HTTP_EXCEPTION_LOGGER');

export interface HttpExceptionLogger {
  warning(message: string): Promise<void> | void;
  error(message: string): Promise<void> | void;
}

const FORWARDING_LOGGER: HttpExceptionLogger = {
  warning: (msg) => getLogger().warning(msg),
  error: (msg) => getLogger().error(msg),
};

const STATUS_PREFIX: Readonly<Record<number, string>> = {
  [HttpStatus.BAD_REQUEST]: 'Bad Request',
  [HttpStatus.NOT_FOUND]: 'Not Found',
  [HttpStatus.METHOD_NOT_ALLOWED]: 'Method Not Allowed',
  [HttpStatus.INTERNAL_SERVER_ERROR]: 'Internal Server Error',
};

const STATUS_LEVEL: Readonly<Record<number, 'warning' | 'error'>> = {
  [HttpStatus.BAD_REQUEST]: 'error',
  [HttpStatus.NOT_FOUND]: 'warning',
  [HttpStatus.METHOD_NOT_ALLOWED]: 'warning',
  [HttpStatus.INTERNAL_SERVER_ERROR]: 'error',
};

@Injectable()
@Catch(HttpException)
export class HttpExceptionFilter implements ExceptionFilter<HttpException> {
  private readonly logger: HttpExceptionLogger;

  constructor(@Optional() @Inject(HTTP_EXCEPTION_LOGGER) logger?: HttpExceptionLogger) {
    this.logger = logger ?? FORWARDING_LOGGER;
  }

  catch(exception: HttpException, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<MinimalResponse>();
    const request = ctx.getRequest<MinimalRequest>();
    const status = exception.getStatus();
    const prefix = STATUS_PREFIX[status];
    const level = STATUS_LEVEL[status];
    const message = exception.message;

    if (level !== undefined) {
      const ip = request.ip ?? request.socket?.remoteAddress ?? '';
      const includeUrl = status === HttpStatus.BAD_REQUEST || status === HttpStatus.NOT_FOUND;
      const tail = includeUrl ? `, URL: ${request.originalUrl}, IP: ${ip}` : `, IP: ${ip}`;
      const line = `${status} error: ${message}${tail}`;
      void Promise.resolve(this.logger[level](line)).catch(() => undefined);
    }

    const body = prefix !== undefined ? { error: `${prefix}: ${message}` } : { error: message };
    response.status(status).json(body);
  }
}
