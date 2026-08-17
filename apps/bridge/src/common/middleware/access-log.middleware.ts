import { Injectable, type NestMiddleware } from '@nestjs/common';

import { shouldLogAccess } from '../../logger/context/access-log-filter';
import { ContextLogger } from '../../logger/logger.service';
import { getMonitoringConfig } from '../../monitoring/monitoring.config';
import { getResponseTimingDuration } from './response-timing.middleware';

const ACCESS_LOG_APP_CLASS_NAME = 'http';

export interface AccessLogRequest {
  readonly method?: string;
  readonly url?: string;
  readonly originalUrl?: string;
  readonly protocol?: string;
  readonly headers?: { host?: string | string[] };
  readonly ip?: string;
  readonly socket?: { remoteAddress?: string };
}

export interface AccessLogResponse {
  readonly statusCode: number;
  on(event: 'finish' | 'close', listener: () => void): unknown;
}

type NextFn = (err?: unknown) => void;

// req.originalUrl/req.url are path-only — reconstruct the full URL; the log line must stay byte-stable for consumers.
function requestUrl(req: AccessLogRequest): string {
  const path = req.originalUrl ?? req.url ?? '';
  const protocol = req.protocol ?? 'http';
  const hostHeader = req.headers?.host;
  const host = Array.isArray(hostHeader) ? hostHeader[0] : hostHeader;
  if (host === undefined || host === '') {
    return path;
  }
  return `${protocol}://${host}${path}`;
}

function requestMethod(req: AccessLogRequest): string {
  return req.method ?? '';
}

function requestRemoteAddr(req: AccessLogRequest): string {
  return req.ip ?? req.socket?.remoteAddress ?? 'unknown';
}

function formatDurationSeconds(value: number): string {
  if (Number.isInteger(value)) {
    return `${value}.0`;
  }
  return String(value);
}

function roundHalfToEven(value: number, decimals: number): number {
  if (!Number.isFinite(value)) return value;
  const sign = value < 0 ? -1 : 1;
  const absStr = Math.abs(value).toFixed(20);
  const dot = absStr.indexOf('.');
  const intPart = dot === -1 ? absStr : absStr.slice(0, dot);
  const fracPart = dot === -1 ? '' : absStr.slice(dot + 1);
  if (fracPart.length <= decimals) {
    return sign * Number(absStr);
  }
  const keep = fracPart.slice(0, decimals);
  const rest = fracPart.slice(decimals);
  const firstRest = rest.charCodeAt(0) - 48;
  let roundUp: boolean;
  if (firstRest > 5) {
    roundUp = true;
  } else if (firstRest < 5) {
    roundUp = false;
  } else {
    const hasNonZeroTail = /[1-9]/.test(rest.slice(1));
    if (hasNonZeroTail) {
      roundUp = true;
    } else {
      const lastKeptChar = decimals === 0 ? intPart[intPart.length - 1] : keep[keep.length - 1];
      roundUp = (lastKeptChar.charCodeAt(0) - 48) % 2 === 1;
    }
  }
  const combined = intPart + keep;
  const rounded = roundUp ? BigInt(combined) + 1n : BigInt(combined);
  const factor = Math.pow(10, decimals);
  return (sign * Number(rounded)) / factor;
}

@Injectable()
export class AccessLogMiddleware implements NestMiddleware {
  constructor(private readonly logger: ContextLogger) {}

  use(req: AccessLogRequest, res: AccessLogResponse, next: NextFn): void {
    const startNs = process.hrtime.bigint();

    res.on('finish', () => {
      const elapsedSeconds = Number(process.hrtime.bigint() - startNs) / 1e9;
      const duration = formatDurationSeconds(roundHalfToEven(elapsedSeconds, 2));
      const method = requestMethod(req);
      const url = requestUrl(req);
      const statusCode = res.statusCode;
      const clientIp = requestRemoteAddr(req);

      void this.logger.debug(`HTTP ${method} ${url} -> ${statusCode} (${duration}s)`, {
        appClassName: ACCESS_LOG_APP_CLASS_NAME,
      });

      const totalDuration = formatDurationSeconds(getResponseTimingDuration());
      void this.logger.debug(`HTTP ${method} ${url} total ${totalDuration}s`, {
        appClassName: ACCESS_LOG_APP_CLASS_NAME,
      });

      const monitoringLogsEnabled = getMonitoringConfig().monitoringLogsEnabled;
      if (shouldLogAccess({ url, statusCode, monitoringLogsEnabled })) {
        void this.logger.info(`${method} ${url} ${statusCode} ${clientIp} ${duration}s`, {
          appClassName: ACCESS_LOG_APP_CLASS_NAME,
        });
      }
    });

    next();
  }
}
