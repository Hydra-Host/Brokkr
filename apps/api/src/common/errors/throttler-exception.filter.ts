import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus, Injectable } from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import { Request, Response } from 'express';

export const RATE_LIMITS = {
  limit: 100,
  ttl: 60000,
};

interface ResetTimeEntry {
  resetAt: Date;
  expiresAt: number;
}

@Catch(ThrottlerException)
@Injectable()
export class ThrottlerExceptionFilter implements ExceptionFilter {
  private resetTimes = new Map<string, ResetTimeEntry>();

  catch(_exception: ThrottlerException, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const trackingKey = (request.headers['x-api-key'] as string) || request.ip || 'unknown';

    let retryAfterSeconds = RATE_LIMITS.ttl / 1000;
    const retryHeader = response.getHeader('Retry-After');
    if (retryHeader) {
      retryAfterSeconds = parseInt(String(retryHeader), 10);
    }

    const now = new Date();
    const currentTime = now.getTime();
    const existing = this.resetTimes.get(trackingKey);

    if (!existing || existing.expiresAt < currentTime || existing.resetAt.getTime() < currentTime) {
      const resetAt = new Date(currentTime + retryAfterSeconds * 1000);
      this.resetTimes.set(trackingKey, {
        resetAt,
        expiresAt: currentTime + retryAfterSeconds * 2 * 1000,
      });
      this.cleanupExpiredEntries(currentTime);
    }

    const resetAt = this.resetTimes.get(trackingKey)!.resetAt;
    const secondsRemaining = Math.max(0, Math.ceil((resetAt.getTime() - currentTime) / 1000));

    response.status(HttpStatus.TOO_MANY_REQUESTS).json({
      statusCode: HttpStatus.TOO_MANY_REQUESTS,
      message: 'Too many requests, please try again later.',
      error: 'Rate limit exceeded',
      rateLimit: {
        limit: RATE_LIMITS.limit,
        timeWindow: `${RATE_LIMITS.ttl / 1000} seconds`,
        remainingTime: `${secondsRemaining} seconds`,
        resetAt: resetAt.toISOString(),
      },
      timestamp: now.toISOString(),
      path: request.url,
    });
  }

  private cleanupExpiredEntries(currentTime: number): void {
    for (const [key, entry] of this.resetTimes) {
      if (entry.expiresAt < currentTime) {
        this.resetTimes.delete(key);
      }
    }
  }
}
