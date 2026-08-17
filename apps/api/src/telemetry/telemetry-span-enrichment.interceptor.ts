import { Injectable, type CallHandler, type ExecutionContext, type NestInterceptor } from '@nestjs/common';
import { enrichActiveSpan } from '@repo/telemetry';
import type { Observable } from 'rxjs';
import { ContextService } from 'src/common/context/context.service';
import { buildTelemetrySpanAttributes } from './telemetry-span-attributes';

@Injectable()
export class TelemetrySpanEnrichmentInterceptor implements NestInterceptor {
  constructor(private readonly contextService: ContextService) {}

  intercept(_executionContext: ExecutionContext, next: CallHandler): Observable<unknown> {
    enrichActiveSpan(
      buildTelemetrySpanAttributes({
        requestId: this.contextService.requestId,
        identity: this.contextService.identity,
        deviceIdentity: this.contextService.deviceIdentity,
        sessionUser: this.contextService.sessionUser,
      }),
    );
    return next.handle();
  }
}
