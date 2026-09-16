// Shutdown contract: startServer's signal handlers own shutdown. Never call app.enableShutdownHooks() — Nest's hooks install competing SIGTERM/SIGINT listeners and process.exit(0), racing the explicit `await shutdownTrigger; await app.close()` sequence below.
import 'reflect-metadata';

// OTel init MUST be the first app import: require-patch instrumentation only covers modules loaded after it, and SWC hoists all static imports. Guarded by telemetry-import-order.spec.ts.
import './telemetry/init';

import { applyEnvPreboot } from './startup/env-preboot';
applyEnvPreboot();

// Must run before AppModule loads: TelegrafModule.forRoot reads the factory handle at @Module decorator time. AppModule is dynamically imported in startProductionServer so SWC's require-hoisting can't evaluate it before this call.
import { configureTelegrafForBridge } from './composition/telegraf-wiring';
configureTelegrafForBridge();

import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { shutdownTelemetry } from '@repo/telemetry';

import { getErrorMessage } from './common/error-utils';
import { buildStartupArgs } from './composition/startup-args';
import { NIL_JOB_ID } from './constants';
import { logError, logInfo } from './logger/logger.service';
import { syncLogError, syncLogInfo } from './logger/sync-log';

import { activeResourceCount, describeActiveHandles } from './startup/active-handles';
import type { StartupOrchestrator } from './startup/orchestrator';
import { setupProcessExceptionHandler } from './startup/process-exception-handler';
import type { RunStartupArgs } from './startup/run-startup';
import { runStartup } from './startup/run-startup';
import { startServer, type SyncLogger } from './startup/start-server';
import { VrrpReconcilerService } from './vrrp/vrrp-reconciler.service';

import { resolveListenHost, resolveListenPort } from './startup/listen-target';
export { DEFAULT_HOST, DEFAULT_PORT, resolveListenHost, resolveListenPort } from './startup/listen-target';

export type OrchestratorGateDecision = 'enabled' | 'degraded' | 'unset';

export function orchestratorGateDecision(env: NodeJS.ProcessEnv = process.env): OrchestratorGateDecision {
  const raw = env.BRIDGE_ORCHESTRATOR_ENABLED;
  if (raw === undefined) return 'unset';
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'true') return 'enabled';
  if (normalized === 'false') return 'degraded';
  return 'unset';
}

export function isOrchestratorEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return orchestratorGateDecision(env) === 'enabled';
}

export class OrchestratorGateUnsetError extends Error {
  constructor(rawValue: string | undefined) {
    const observed = rawValue === undefined ? '(unset)' : JSON.stringify(rawValue);
    super(
      `BRIDGE_ORCHESTRATOR_ENABLED is ${observed} — the production entrypoint requires an ` +
        'explicit decision. Set =true to run Phase 1 + Phase 2 startup tasks, or =false for ' +
        'degraded HTTP-only mode (no leader-election / BullMQ / gRPC / SNMP / TFTP / cron / ' +
        'telegraf / agent-unit-render / sync-config validation).',
    );
    this.name = 'OrchestratorGateUnsetError';
  }
}

export async function startProductionServer(
  shutdownTrigger: Promise<void>,
  deps: {
    createApp?: () => Promise<INestApplication>;
    env?: NodeJS.ProcessEnv;
    startupArgsFactory?: (env: NodeJS.ProcessEnv) => RunStartupArgs;
    runStartup?: (jobId: string, args: RunStartupArgs) => Promise<StartupOrchestrator>;
  } = {},
): Promise<void> {
  const jobId = NIL_JOB_ID;
  const env = deps.env ?? process.env;

  const gate = orchestratorGateDecision(env);
  if (gate === 'unset') {
    throw new OrchestratorGateUnsetError(env.BRIDGE_ORCHESTRATOR_ENABLED);
  }

  const runStartupFn = deps.runStartup ?? runStartup;

  let orchestrator: StartupOrchestrator | null = null;
  if (gate === 'enabled') {
    const startupArgsFactory = deps.startupArgsFactory ?? buildStartupArgs;
    const args = startupArgsFactory(env);
    orchestrator = await runStartupFn(jobId, args);
    await logInfo('Startup tasks completed', { jobId });
  } else {
    await logInfo(
      'Startup orchestrator running in degraded HTTP-only mode via BRIDGE_ORCHESTRATOR_ENABLED=false (Phase 1 / Phase 2 tasks NOT executed)',
      { jobId },
    );
  }

  const createApp =
    deps.createApp ??
    (async (): Promise<INestApplication> => {
      const { AppModule } = await import('./app.module');
      const rootModule = await AppModule.withPluginBackends();
      // trustProxy so req.ip is the client's real IP from nginx's X-Forwarded-For, not the loopback
      // peer — bridge-IP resolution keys off it, and the REST surface only listens behind nginx.
      return NestFactory.create<NestFastifyApplication>(rootModule, new FastifyAdapter({ trustProxy: true }), {
        bufferLogs: false,
      });
    });
  const app = await createApp();
  // Do NOT call app.enableShutdownHooks() — see file-level comment.

  const host = resolveListenHost(env);
  const port = resolveListenPort(env);
  await app.listen(port, host);
  await logInfo(`bridge-ts listening on ${host}:${port}`, { jobId, appClassName: 'main' });
  await logInfo('Brokkr Bridge application ready', { jobId });

  await shutdownTrigger;

  await logInfo('Initiating graceful shutdown', { jobId });

  try {
    await app.get(VrrpReconcilerService, { strict: false }).detachAll();
  } catch (exc) {
    await logError(`VRRP detach on shutdown failed: ${getErrorMessage(exc)}`, { jobId });
  }

  if (orchestrator !== null) {
    try {
      await orchestrator.stopAll(jobId);
    } catch (exc) {
      await logError(`Orchestrator stopAll failed: ${exc instanceof Error ? exc.message : String(exc)}`, { jobId });
    }
  }
  try {
    await app.close();
  } catch (exc) {
    await logError(`Graceful shutdown failed: ${exc instanceof Error ? exc.message : String(exc)}`, { jobId });
  }
  // Flush spans LAST so a slow OTLP backend can't widen the duplicate-IP window. Bounded (3s), fail-soft, no signal listeners.
  await shutdownTelemetry();
}

const signalLogger: SyncLogger = {
  info: (message: string): void => syncLogInfo(message, NIL_JOB_ID, 'main'),
  error: (message: string): void => syncLogError(message, NIL_JOB_ID, 'main'),
};

const HANDLE_PROBE_DELAY_MS = 2_000;
const SHUTDOWN_WATCHDOG_MS = 5_000;

// both unref'd: a drained loop exits before either fires, so an armed probe costs nothing and a
// fired one always names a real leak. No signal listeners here — startServer owns those.
function armPostShutdownWatchdog(): void {
  const probe = setTimeout(() => {
    syncLogError(`shutdown-probe: ${describeActiveHandles()}`, NIL_JOB_ID, 'main');
  }, HANDLE_PROBE_DELAY_MS);
  probe.unref();

  // exit 0, not non-zero: the spoke's process-compose unit restarts on_failure, so a non-zero
  // forced exit would turn a leak into a restart loop.
  const watchdog = setTimeout(() => {
    syncLogError(
      `shutdown-watchdog: forced exit, ${activeResourceCount()} handles still referenced — ${describeActiveHandles()}`,
      NIL_JOB_ID,
      'main',
    );
    process.exit(0);
  }, SHUTDOWN_WATCHDOG_MS);
  watchdog.unref();
}

async function bootstrap(): Promise<void> {
  // Late-bound so uncaughtException/unhandledRejection drives the same graceful shutdown as signals, then fails fast non-zero.
  let requestShutdown: (() => void) | null = null;

  setupProcessExceptionHandler(
    {
      error: (message: string): void => syncLogError(message, NIL_JOB_ID, 'process'),
    },
    {
      requestShutdown: (): void => requestShutdown?.(),
    },
  );

  await startServer({
    startProductionServer: (shutdownTrigger) => startProductionServer(shutdownTrigger),
    logger: signalLogger,
    onShutdownReady: (request) => {
      requestShutdown = request;
    },
  });

  armPostShutdownWatchdog();
}

if (require.main === module) {
  bootstrap().catch((exc: unknown) => {
    syncLogError(
      `Application failed to start: ${exc instanceof Error ? exc.message : String(exc)}`,
      NIL_JOB_ID,
      'main',
    );
    process.exit(1);
  });
}
