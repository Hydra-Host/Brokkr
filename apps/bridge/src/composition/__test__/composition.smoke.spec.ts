import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { withEnv } from '../../__test__/env-guard.js';
import { AgentServicer } from '../../agent/gateway/agent.servicer.js';
import type { AgentServicerDeps } from '../../agent/gateway/agent.servicer.types.js';
import {
  DeviceAuthInterceptor,
  type AuthContextBinder,
  type AuthInterceptorLogger,
  type TokenVerifierPort,
} from '../../agent/gateway/auth.interceptor.js';
import {
  GrpcServerService,
  type AgentServicerFactory,
  type AuthInterceptorFactory,
  type GrpcTransportFactory,
} from '../../agent/gateway/grpc-server.service.js';
import { resetGrpcConfigForTests } from '../../agent/gateway/grpc.config.js';
import { AppModule } from '../../app.module.js';
import { JOB_NAME } from '../../bullmq/bullmq.types.js';
import type { JobHandler } from '../../bullmq/handlers.service.js';
import { BullmqRegistryService } from '../../bullmq/registry.service.js';
import { NIL_JOB_ID } from '../../constants.js';
import { resetForTests as resetCronRegistry } from '../../crons/cron-registry.js';
import { runStartup } from '../../startup/run-startup.js';
import { resetTftpConfigForTests } from '../../tftp/tftp.config.js';
import { buildStartupArgs } from '../startup-args.js';

withEnv('BROKKR_ZONE_ID', '11111111-2222-3333-4444-555555555555');
const TEST_AT_REST_KEY = Buffer.alloc(32, 0x42).toString('base64');

describe('composition root smoke', () => {
  let priorTftpEnabled: string | undefined;
  let priorGrpcPort: string | undefined;

  beforeEach(() => {
    resetCronRegistry();
    priorTftpEnabled = process.env.TFTP_ENABLED;
    process.env.TFTP_ENABLED = 'false';
    resetTftpConfigForTests();
    priorGrpcPort = process.env.GRPC_INTERNAL_PORT;
    process.env.GRPC_INTERNAL_PORT = '0';
    resetGrpcConfigForTests();
  });

  afterEach(() => {
    resetCronRegistry();
    if (priorTftpEnabled === undefined) delete process.env.TFTP_ENABLED;
    else process.env.TFTP_ENABLED = priorTftpEnabled;
    resetTftpConfigForTests();
    if (priorGrpcPort === undefined) delete process.env.GRPC_INTERNAL_PORT;
    else process.env.GRPC_INTERNAL_PORT = priorGrpcPort;
    resetGrpcConfigForTests();
  });

  it('AppModule compiles end-to-end with all imported subsystem modules resolvable', { timeout: 30000 }, async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    expect(moduleRef).toBeDefined();
    await moduleRef.close();
  });

  it('AppModule boots a Nest HTTP application and GET /api/health responds 200', { timeout: 30000 }, async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    try {
      const res = await app.inject({ method: 'GET', url: '/api/health' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(['OK', 'degraded']).toContain(body.status);
      expect(typeof body.bridge_version).toBe('string');
      expect(body).toHaveProperty('snmp_engine');
      expect(body).toHaveProperty('redis');
      expect(body).toHaveProperty('grpc');
    } finally {
      await app.close();
    }
  });

  it("BullmqRegistryService.getHandler('saga.run') returns the registered handler", () => {
    const registry = new BullmqRegistryService();
    const sagaHandler: JobHandler = async () => ({ ok: 'saga' });
    registry.register(JOB_NAME.SAGA_RUN, sagaHandler);

    const resolved = registry.getHandler('saga.run');
    expect(resolved).toBe(sagaHandler);
    expect(resolved).toBeDefined();
  });

  it(
    "AppModule wires BullmqModule.forRoot so getHandler('saga.run') yields the real SagaJobHandler (acceptance)",
    { timeout: 30000 },
    async () => {
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
      try {
        const registry = moduleRef.get(BullmqRegistryService);
        const resolved = registry.getHandler('saga.run');
        expect(resolved).toBeDefined();
        expect(typeof resolved).toBe('function');
      } finally {
        await moduleRef.close();
      }
    },
  );

  it('GrpcServerService is constructible with stubbed deps', () => {
    const tokenService: TokenVerifierPort = { verify: vi.fn().mockResolvedValue(null) };
    const binder: AuthContextBinder = {
      bind: vi.fn().mockImplementation(async <T>(_s: unknown, fn: () => Promise<T>) => fn()),
    };
    const authLogger: AuthInterceptorLogger = { warning: vi.fn().mockResolvedValue(undefined) };
    const authInterceptorFactory: AuthInterceptorFactory = {
      build: () => new DeviceAuthInterceptor(tokenService, binder, authLogger),
    };
    const servicerFactory: AgentServicerFactory = {
      build: () => new AgentServicer({} as unknown as AgentServicerDeps),
    };
    const transportFactory: GrpcTransportFactory = {
      startServer: vi.fn().mockResolvedValue({ close: vi.fn() }),
    };

    const service = new GrpcServerService({
      authInterceptorFactory,
      servicerFactory,
      transportFactory,
    });
    expect(service).toBeDefined();
    expect(service).toBeInstanceOf(GrpcServerService);
  });

  it('runStartup composes against buildStartupArgs and registers Phase 2 background tasks', async () => {
    const args = buildStartupArgs({
      BRIDGE_SYNC_ENABLED: 'false',
      GRPC_ENABLED: 'false',
      TFTP_ENABLED: 'false',
      TELEGRAF_ENABLED: 'false',
      BROKKR_ZONE_ID: '00000000-0000-0000-0000-000000000001',
      BRIDGE_AT_REST_KEY: TEST_AT_REST_KEY,
    });
    const orchestrator = await runStartup(NIL_JOB_ID, args);
    expect(orchestrator).toBeDefined();
    await new Promise((res) => setImmediate(res));
    await orchestrator.stopAll(NIL_JOB_ID);
  });

  it('startup args honour config gates (sync default true)', () => {
    const args = buildStartupArgs({});
    expect(args.sync.appConfig.bridgeSyncEnabled).toBe(true);
  });
});
