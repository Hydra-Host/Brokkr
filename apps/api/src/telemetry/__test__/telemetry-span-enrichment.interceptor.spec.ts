import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host';
import { enrichActiveSpan } from '@repo/telemetry';
import { firstValueFrom, of } from 'rxjs';
import { ContextService } from 'src/common/context/context.service';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TelemetrySpanEnrichmentInterceptor } from '../telemetry-span-enrichment.interceptor';

vi.mock('@repo/telemetry', () => ({
  enrichActiveSpan: vi.fn(),
}));

describe('TelemetrySpanEnrichmentInterceptor', () => {
  const contextService = new ContextService({ isInstanceOperator: () => false });
  const interceptor = new TelemetrySpanEnrichmentInterceptor(contextService);
  const executionContext = new ExecutionContextHost([]);

  beforeEach(() => {
    vi.mocked(enrichActiveSpan).mockClear();
  });

  it('stamps the built attribute map from ContextService and passes the handler through', async () => {
    let result: unknown;
    contextService.run({ requestId: 'req-9' }, () => {
      const observable = interceptor.intercept(executionContext, { handle: () => of('payload') });
      result = firstValueFrom(observable);
    });
    await expect(result).resolves.toBe('payload');
    expect(enrichActiveSpan).toHaveBeenCalledExactlyOnceWith({ 'brokkr.request_id': 'req-9' });
  });

  it('maps a session-only user into id-only span attributes', () => {
    contextService.run({ requestId: 'req-10' }, () => {
      contextService.sessionUser = {
        id: 'user-1',
        email: 'ignored@example.com',
        firstName: 'Ada',
        lastName: 'Lovelace',
      };
      interceptor.intercept(executionContext, { handle: () => of(undefined) });
    });
    expect(enrichActiveSpan).toHaveBeenCalledExactlyOnceWith({
      'brokkr.request_id': 'req-10',
      'enduser.id': 'user-1',
      'brokkr.auth_type': 'session',
      'brokkr.request_source': 'UI',
    });
  });

  it('is safe outside any request context (no ALS store bound)', () => {
    expect(() => interceptor.intercept(executionContext, { handle: () => of(undefined) })).not.toThrow();
    expect(enrichActiveSpan).toHaveBeenCalledExactlyOnceWith({ 'brokkr.request_id': undefined });
  });
});
