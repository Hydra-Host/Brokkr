import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { RequestSource } from '@repo/database';
import { of, throwError } from 'rxjs';
import type { PermissionIntent } from 'src/common/context/context.service';
import { describe, expect, it, vi } from 'vitest';
import type { AuditActionOptions } from '../audit-action.decorator';
import { EventLogInterceptor } from '../event-log.interceptor';

const TARGET_UUID = '3f0f1d6e-0000-4000-8000-000000000001';

function intent(overrides: Partial<PermissionIntent> = {}): PermissionIntent {
  return { id: 'i1', resource: 'device', action: 'update', denied: false, finalized: false, ...overrides };
}

function buildHarness(
  intents: PermissionIntent[],
  options?: AuditActionOptions,
  request: Record<string, unknown> = {},
  gated = false,
) {
  const recordBestEffort = vi.fn().mockResolvedValue(undefined);
  const contextService = {
    drainIntents: vi.fn().mockReturnValue(intents),
    hasRecordedIntents: gated,
    organizationIdOrUndefined: 'org-1',
    requestId: 'req-1',
    resolveActor: () => ({
      actorType: RequestSource.UI,
      actorId: 'u-1',
      actorLabel: 'caller@example.com',
      apiKeyId: null,
      apiKeyLabel: null,
    }),
  };
  const logger = { log: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), verbose: vi.fn() };
  const interceptor = new EventLogInterceptor(
    contextService as never,
    { recordBestEffort } as never,
    { get: () => options } as never,
    logger as never,
  );
  const executionContext = {
    switchToHttp: () => ({
      getRequest: () => ({
        method: 'PATCH',
        path: '/api/v1/devices/x',
        params: {},
        ip: '203.0.113.9',
        headers: { 'user-agent': 'vitest' },
        ...request,
      }),
    }),
    getHandler: () => () => undefined,
  };
  return { interceptor, executionContext, recordBestEffort, contextService, logger };
}

async function runSuccess(interceptor: EventLogInterceptor, ctx: unknown, body: unknown = {}) {
  await new Promise<void>((resolve) =>
    interceptor.intercept(ctx as never, { handle: () => of(body) }).subscribe({ complete: () => resolve() }),
  );
}

async function runFailure(interceptor: EventLogInterceptor, ctx: unknown, error: unknown) {
  await new Promise<void>((resolve) =>
    interceptor.intercept(ctx as never, { handle: () => throwError(() => error) }).subscribe({
      error: () => resolve(),
    }),
  );
}

describe('EventLogInterceptor', () => {
  it('writes SUCCEEDED for a mutating intent on a successful response', async () => {
    const { interceptor, executionContext, recordBestEffort } = buildHarness([intent()]);

    await runSuccess(interceptor, executionContext);

    expect(recordBestEffort).toHaveBeenCalledWith(
      expect.objectContaining({ actionKey: 'device.update', outcome: 'SUCCEEDED', tier: 'ACTIVITY' }),
    );
  });

  it('writes FAILED when the handler throws a business 403 after a passing check', async () => {
    const { interceptor, executionContext, recordBestEffort } = buildHarness([intent()]);

    await runFailure(interceptor, executionContext, new ForbiddenException('Invitation limit reached'));

    expect(recordBestEffort).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'FAILED', errorCode: '403:ForbiddenException' }),
    );
  });

  it('writes DENIED when the intent itself was denied', async () => {
    const { interceptor, executionContext, recordBestEffort } = buildHarness([intent({ denied: true })]);

    await runFailure(interceptor, executionContext, new ForbiddenException('nope'));

    expect(recordBestEffort).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'DENIED' }));
  });

  it('keeps a denied read-only intent that classification would otherwise drop', async () => {
    const { interceptor, executionContext, recordBestEffort } = buildHarness([
      intent({ resource: 'event-log', action: 'access', denied: true }),
    ]);

    await runFailure(interceptor, executionContext, new ForbiddenException('nope'));

    expect(recordBestEffort).toHaveBeenCalledWith(
      expect.objectContaining({ actionKey: 'event-log.access', outcome: 'DENIED' }),
    );
  });

  it('drops an allowed read-only intent', async () => {
    const { interceptor, executionContext, recordBestEffort } = buildHarness([
      intent({ resource: 'event-log', action: 'access' }),
    ]);

    await runSuccess(interceptor, executionContext);

    expect(recordBestEffort).not.toHaveBeenCalled();
  });

  it('drops an allowed read intent', async () => {
    const { interceptor, executionContext, recordBestEffort } = buildHarness([intent({ action: 'read' })]);

    await runSuccess(interceptor, executionContext);

    expect(recordBestEffort).not.toHaveBeenCalled();
  });

  it('keeps device-secret access, which is a disclosure rather than a read', async () => {
    const { interceptor, executionContext, recordBestEffort } = buildHarness([
      intent({ resource: 'device-secret', action: 'access' }),
    ]);

    await runSuccess(interceptor, executionContext);

    expect(recordBestEffort).toHaveBeenCalledWith(expect.objectContaining({ actionKey: 'device-secret.access' }));
  });

  it('writes one row per surviving intent', async () => {
    const { interceptor, executionContext, recordBestEffort } = buildHarness([
      intent({ id: 'i1' }),
      intent({ id: 'i2', resource: 'member', action: 'delete' }),
    ]);

    await runSuccess(interceptor, executionContext);

    expect(recordBestEffort).toHaveBeenCalledTimes(2);
  });

  it('resolves the target from the response body itself, not from a body property', async () => {
    const { interceptor, executionContext, recordBestEffort } = buildHarness([intent()]);

    await runSuccess(interceptor, executionContext, { id: TARGET_UUID });

    expect(recordBestEffort).toHaveBeenCalledWith(expect.objectContaining({ targetId: TARGET_UUID }));
  });

  it('prefers a uuid route param over the response body', async () => {
    const { interceptor, executionContext, recordBestEffort } = buildHarness([intent()], undefined, {
      params: { deviceUuid: TARGET_UUID },
    });

    await runSuccess(interceptor, executionContext, { id: '11111111-2222-4333-8444-555555555555' });

    expect(recordBestEffort).toHaveBeenCalledWith(expect.objectContaining({ targetId: TARGET_UUID }));
  });

  it('leaves the target null when nothing resolves', async () => {
    const { interceptor, executionContext, recordBestEffort } = buildHarness([intent()]);

    await runSuccess(interceptor, executionContext, { name: 'no id here' });

    expect(recordBestEffort).toHaveBeenCalledWith(expect.objectContaining({ targetId: null, targetLabel: null }));
  });

  it('lets an AuditAction extractor override the target', async () => {
    const options: AuditActionOptions = {
      actionKey: 'member.invited',
      resource: 'invitation',
      action: 'create',
      target: () => ({ id: 'inv-1', label: 'invitee@example.com' }),
    };
    const { interceptor, executionContext, recordBestEffort } = buildHarness([intent()], options);

    await runSuccess(interceptor, executionContext, { id: TARGET_UUID });

    expect(recordBestEffort).toHaveBeenCalledWith(
      expect.objectContaining({ targetId: 'inv-1', targetLabel: 'invitee@example.com' }),
    );
  });

  it('lets an AuditAction override the mechanical action key', async () => {
    const options: AuditActionOptions = { actionKey: 'member.invited', resource: 'invitation', action: 'create' };
    const { interceptor, executionContext, recordBestEffort } = buildHarness([intent()], options);

    await runSuccess(interceptor, executionContext);

    expect(recordBestEffort).toHaveBeenCalledWith(expect.objectContaining({ actionKey: 'member.invited' }));
  });

  it('mints a synthetic intent for a decorated endpoint whose gate records nothing', async () => {
    const options: AuditActionOptions = {
      actionKey: 'circuit-type.created',
      resource: 'circuit-type',
      action: 'create',
    };
    const { interceptor, executionContext, recordBestEffort } = buildHarness([], options);

    await runSuccess(interceptor, executionContext);

    expect(recordBestEffort).toHaveBeenCalledWith(
      expect.objectContaining({ actionKey: 'circuit-type.created', outcome: 'SUCCEEDED' }),
    );
  });

  it('mints nothing for a decorated endpoint whose gate intent a tier 1 emit superseded', async () => {
    const options: AuditActionOptions = { actionKey: 'role.created', resource: 'role', action: 'create' };
    const { interceptor, executionContext, recordBestEffort } = buildHarness([], options, {}, true);

    await runSuccess(interceptor, executionContext);

    expect(recordBestEffort).not.toHaveBeenCalled();
  });

  it('writes nothing for an undecorated endpoint with no intents', async () => {
    const { interceptor, executionContext, recordBestEffort } = buildHarness([]);

    await runSuccess(interceptor, executionContext);

    expect(recordBestEffort).not.toHaveBeenCalled();
  });

  it('writes nothing when no organization is in scope', async () => {
    const { interceptor, executionContext, recordBestEffort, contextService } = buildHarness([intent()]);
    contextService.organizationIdOrUndefined = undefined as never;

    await runSuccess(interceptor, executionContext);

    expect(recordBestEffort).not.toHaveBeenCalled();
  });

  it('records provenance from the request', async () => {
    const { interceptor, executionContext, recordBestEffort } = buildHarness([intent()]);

    await runSuccess(interceptor, executionContext);

    expect(recordBestEffort).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'req-1',
        method: 'PATCH',
        path: '/api/v1/devices/x',
        ipAddress: '203.0.113.9',
        userAgent: 'vitest',
      }),
    );
  });

  it('leaves metadata null without an extractor', async () => {
    const { interceptor, executionContext, recordBestEffort } = buildHarness([intent()]);

    await runSuccess(interceptor, executionContext);

    expect(recordBestEffort).toHaveBeenCalledWith(expect.objectContaining({ metadata: null }));
  });

  it('never rejects when a metadata extractor throws', async () => {
    const options: AuditActionOptions = {
      actionKey: 'device.update',
      resource: 'device',
      action: 'update',
      metadata: () => {
        throw new Error('extractor blew up');
      },
    };
    const { interceptor, executionContext, logger } = buildHarness([intent()], options);

    await runSuccess(interceptor, executionContext);

    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('extractor blew up'));
  });

  it('never rejects when a target extractor throws', async () => {
    const options: AuditActionOptions = {
      actionKey: 'device.update',
      resource: 'device',
      action: 'update',
      target: () => {
        throw new Error('target blew up');
      },
    };
    const { interceptor, executionContext, logger } = buildHarness([intent()], options);

    await runSuccess(interceptor, executionContext);

    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('target blew up'));
  });

  it('re-raises the original error to the caller', async () => {
    const { interceptor, executionContext } = buildHarness([intent()]);
    const error = new NotFoundException('gone');
    let caught: unknown;

    await new Promise<void>((resolve) =>
      interceptor.intercept(executionContext as never, { handle: () => throwError(() => error) }).subscribe({
        error: (received: unknown) => {
          caught = received;
          resolve();
        },
      }),
    );

    expect(caught).toBe(error);
  });
});
