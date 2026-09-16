import {
  type CallHandler,
  type ExecutionContext,
  HttpException,
  Injectable,
  Logger,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { getErrorMessage, isRecord } from '@repo/utils';
import { catchError, type Observable, tap, throwError } from 'rxjs';

import type { AuditEventRow } from '../db/db';
import { AuditStore } from '../ledger/audit-store';
import { auditParams, type AuditRequest, isSafeMethod } from './audit-row';
import { auditOriginColumns, currentOrigin } from './lab-context';
import { LAB_ROUTE, type LabRouteOptions } from './lab-route';

type AuditWrite = Omit<AuditEventRow, 'id'>;

/** Default-on for every unsafe-method request, so a mutation added later is audited with no edit
 *  here; `@LabRoute({ audit: false })` is the only opt-out. */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  private readonly log = new Logger(AuditInterceptor.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly audit: AuditStore,
  ) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = ctx.switchToHttp();
    const req = http.getRequest<AuditRequest>();
    const opts = this.reflector.get<LabRouteOptions | undefined>(LAB_ROUTE, ctx.getHandler());
    if (isSafeMethod(req.method) || opts?.audit === false) return next.handle();
    const startedAt = Date.now();
    const base = {
      ts: startedAt,
      method: req.method,
      path: req.path,
      handler: `${ctx.getClass().name}.${ctx.getHandler().name}`,
      params: auditParams(req),
      ...auditOriginColumns(currentOrigin()),
    };
    return next.handle().pipe(
      tap((body) => {
        this.write({
          ...base,
          outcome: 'ok',
          // the ts-rest handler interceptor is method-scoped, so the route's status is already on the
          // response by the time this outer interceptor sees the body
          status_code: http.getResponse<{ statusCode?: number }>().statusCode ?? null,
          duration_ms: Date.now() - startedAt,
          run_id: runIdOf(body),
          error: null,
        });
      }),
      catchError((error: unknown) => {
        this.write({
          ...base,
          outcome: 'error',
          status_code: error instanceof HttpException ? error.getStatus() : 500,
          duration_ms: Date.now() - startedAt,
          run_id: null,
          error: getErrorMessage(error),
        });
        return throwError(() => error);
      }),
    );
  }

  /** A lost audit row must never cost the operator the response the request already earned. */
  private write(row: AuditWrite): void {
    try {
      this.audit.insert(row);
    } catch (error) {
      this.log.warn(`audit write failed for ${row.method} ${row.path}: ${getErrorMessage(error)}`);
    }
  }
}

// opportunistic: audit_events has no fk to runs, so a run this row names may be pruned before it is
function runIdOf(body: unknown): string | null {
  return isRecord(body) && typeof body.runId === 'string' ? body.runId : null;
}
