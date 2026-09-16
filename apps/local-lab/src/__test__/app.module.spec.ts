import { UnauthorizedException } from '@nestjs/common';
import { ApplicationConfig } from '@nestjs/core';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host';
import { Test } from '@nestjs/testing';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { firstValueFrom, of } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppModule } from '../app.module';
import { AuditController } from '../audit/audit.controller';
import { AuditService } from '../audit/audit.service';
import { AuditInterceptor } from '../common/audit.interceptor';
import { LabAuthGuard } from '../common/lab-auth';
import { HealthController } from '../health/health.controller';
import { AuditStore } from '../ledger/audit-store';
import { RunLedgerService } from '../ledger/run-ledger.service';
import { QueuesController } from '../queues/queues.controller';
import { HubController } from '../hub/hub.controller';
import { RuntimeController } from '../runtime/runtime.controller';
import { RunCapabilityGuard } from '../runs/run-capability.guard';
import { RUN_SINK } from '../runner/run-sink';
import { RunnerService } from '../runner/runner.service';
import { RunsController } from '../runs/runs.controller';
import { RunsService } from '../runs/runs.service';
import { TestService } from '../test/test.service';

vi.mock('../results-root', async (importOriginal) => {
  vi.stubEnv('LOCAL_BROKKR_ALLURE', mkdtempSync(join(tmpdir(), 'lab-app-results-')));
  return importOriginal<typeof import('../results-root')>();
});

let stateDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'lab-app-state-'));
  vi.stubEnv('LOCAL_STATE', stateDir);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(stateDir, { recursive: true, force: true });
});

describe('AppModule', () => {
  it('compiles the dependency graph', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    expect(moduleRef).toBeDefined();
  });

  it('opens no sqlite database until the lifecycle hooks run', async () => {
    await Test.createTestingModule({ imports: [AppModule] }).compile();
    expect(existsSync(join(stateDir, 'lab'))).toBe(false);
  });

  it('resolves the run sink to the ledger and hands it to the runner', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

    const ledger = moduleRef.get(RunLedgerService);
    expect(moduleRef.get(RUN_SINK)).toBe(ledger);
    expect(moduleRef.get(RunnerService)).toBeInstanceOf(RunnerService);

    const onCreate = vi.spyOn(ledger, 'onCreate').mockImplementation(() => undefined);
    moduleRef.get(RunnerService).create({ section: 'test', opId: 'smoke', label: 'wiring' });
    expect(onCreate).toHaveBeenCalledTimes(1);
  });

  it('mounts the runs controller', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    expect(moduleRef.get(RunsController)).toBeInstanceOf(RunsController);
  });

  it('mounts the queues controller', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    expect(moduleRef.get(QueuesController)).toBeInstanceOf(QueuesController);
  });

  it('mounts the runtime controller', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    expect(moduleRef.get(RuntimeController)).toBeInstanceOf(RuntimeController);
  });

  it('mounts the hub controller', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    expect(moduleRef.get(HubController)).toBeInstanceOf(HubController);
  });

  it('resolves the per-run guard from the runs module injector', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    expect(moduleRef.get(RunCapabilityGuard, { strict: false })).toBeInstanceOf(RunCapabilityGuard);
  });

  it('mounts the health controller', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    expect(moduleRef.get(HealthController)).toBeInstanceOf(HealthController);
  });

  it('mounts the audit controller and hands its service the shared audit store', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

    expect(moduleRef.get(AuditController)).toBeInstanceOf(AuditController);

    const list = vi.spyOn(moduleRef.get(AuditStore), 'list').mockReturnValue({ rows: [], skipped: 0 });
    moduleRef.get(AuditService).list({ limit: 10, offset: 0 });

    expect(list.mock.calls).toEqual([[{ limit: 10, offset: 0 }]]);
  });

  it('exports the audit store so a root-injector consumer can inject it', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    expect(moduleRef.get(AuditStore)).toBeInstanceOf(AuditStore);
  });

  it('binds the audit interceptor globally and hands it the shared audit store', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

    const interceptor = moduleRef
      .get(ApplicationConfig)
      .getGlobalInterceptors()
      .find((candidate) => candidate instanceof AuditInterceptor);
    expect(interceptor).toBeInstanceOf(AuditInterceptor);
    if (!(interceptor instanceof AuditInterceptor)) throw new Error('no audit interceptor bound');

    const insert = vi.spyOn(moduleRef.get(AuditStore), 'insert').mockImplementation(() => undefined);
    const ctx = new ExecutionContextHost(
      [{ method: 'POST', path: '/api/probe', body: {}, params: {}, query: {} }, { statusCode: 201 }],
      AppModule,
      function probe() {},
    );
    await firstValueFrom(interceptor.intercept(ctx, { handle: () => of({ ok: true }) }));

    expect(insert).toHaveBeenCalledTimes(1);
  });

  it('binds the auth guard globally and hands it the shared audit store', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

    const guard = moduleRef
      .get(ApplicationConfig)
      .getGlobalGuards()
      .find((candidate) => candidate instanceof LabAuthGuard);
    expect(guard).toBeInstanceOf(LabAuthGuard);
    if (!(guard instanceof LabAuthGuard)) throw new Error('no lab auth guard bound');

    vi.stubEnv('LAB_API_TOKEN', 'sekret-token');
    const insert = vi.spyOn(moduleRef.get(AuditStore), 'insert').mockImplementation(() => undefined);
    const ctx = new ExecutionContextHost(
      [
        {
          method: 'POST',
          path: '/api/probe',
          ip: '10.0.0.5',
          socket: { remoteAddress: '10.0.0.5' },
          headers: {},
          query: {},
        },
      ],
      AppModule,
      function probe() {},
    );
    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);

    expect(insert).toHaveBeenCalledTimes(1);
  });

  it('hands the test section the one run facade', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

    const active = vi.spyOn(moduleRef.get(RunsService), 'active').mockReturnValue([]);
    moduleRef.get(TestService).purge('wiring-probe');

    expect(active.mock.calls).toEqual([['test']]);
  });
});
