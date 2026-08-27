import { type CallHandler, type ExecutionContext, Injectable, type NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { type Observable, catchError, tap, throwError } from 'rxjs';
import { ContextService } from 'src/common/context/context.service';
import { resolveOutcome, selectIntents } from 'src/common/context/permission-intents';
import { Logger } from 'src/common/decorators/logger.decorator';
import { getErrorMessage } from 'src/common/error-utils';
import { LoggerService } from 'src/logger/logger.service';
import { AUDIT_ACTION_KEY, type AuditActionOptions } from './audit-action.decorator';
import { resolveErrorCode } from './event-log-status-mapper';
import { EventLogService } from './event-log.service';
import type { EventLogWrite } from './event-log.types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface AuditRequest {
  method?: string;
  path?: string;
  params?: Record<string, string>;
  ip?: string;
  headers?: Record<string, unknown>;
}

@Injectable()
export class EventLogInterceptor implements NestInterceptor {
  constructor(
    private readonly contextService: ContextService,
    private readonly eventLog: EventLogService,
    private readonly reflector: Reflector,
    @Logger(EventLogInterceptor.name) private readonly logger: LoggerService,
  ) {}

  intercept(executionContext: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request: AuditRequest = executionContext.switchToHttp().getRequest();
    const options = this.reflector.get<AuditActionOptions | undefined>(AUDIT_ACTION_KEY, executionContext.getHandler());

    return next.handle().pipe(
      // ts-rest emits the validated body itself, so `body` here is the response payload, not a wrapper.
      tap((body) => void this.flush(request, options, body, undefined)),
      catchError((error: unknown) => {
        void this.flush(request, options, undefined, error);
        return throwError(() => error);
      }),
    );
  }

  /** Fire-and-forget from the response pipeline, so it must never reject: a throwing extractor
   *  or actor lookup would otherwise surface as an unhandled rejection. */
  private async flush(
    request: AuditRequest,
    options: AuditActionOptions | undefined,
    body: unknown,
    error: unknown,
  ): Promise<void> {
    try {
      await this.write(request, options, body, error);
    } catch (flushError) {
      this.logger.error(`Failed to finalize event-log intents: ${getErrorMessage(flushError)}`);
    }
  }

  private async write(
    request: AuditRequest,
    options: AuditActionOptions | undefined,
    body: unknown,
    error: unknown,
  ): Promise<void> {
    const organizationId = this.contextService.organizationIdOrUndefined;
    if (!organizationId) return;

    const intents = selectIntents(this.contextService, options);
    if (intents.length === 0) return;

    const actor = this.contextService.resolveActor();
    const target = this.resolveTarget(request, options, body);
    const errorCode = error === undefined ? null : resolveErrorCode(error);

    for (const intent of intents) {
      const write: EventLogWrite = {
        organizationId,
        tier: 'ACTIVITY',
        durability: 'BEST_EFFORT',
        resource: intent.resource,
        action: intent.action,
        actionKey: options?.actionKey ?? `${intent.resource}.${intent.action}`,
        ...actor,
        ...target,
        outcome: resolveOutcome(intent, error),
        errorCode,
        requestId: this.contextService.requestId ?? null,
        method: request.method ?? null,
        path: request.path ?? null,
        ipAddress: request.ip ?? null,
        userAgent: typeof request.headers?.['user-agent'] === 'string' ? request.headers['user-agent'] : null,
        metadata: options?.metadata?.(request) ?? null,
      };
      await this.eventLog.recordBestEffort(write);
    }
  }

  private resolveTarget(
    request: AuditRequest,
    options: AuditActionOptions | undefined,
    body: unknown,
  ): { targetId: string | null; targetLabel: string | null } {
    const extracted = options?.target?.(request, body);
    if (extracted) return { targetId: extracted.id ?? null, targetLabel: extracted.label ?? null };

    const uuidParam = Object.values(request.params ?? {})
      .filter((value) => typeof value === 'string' && UUID.test(value))
      .at(-1);
    if (uuidParam) return { targetId: uuidParam, targetLabel: null };

    if (body !== null && typeof body === 'object' && 'id' in body) {
      const id = (body as { id: unknown }).id;
      if (typeof id === 'string' && UUID.test(id)) return { targetId: id, targetLabel: null };
    }

    return { targetId: null, targetLabel: null };
  }
}
