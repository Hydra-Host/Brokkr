import { shutdownTelemetry } from '@repo/telemetry';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getErrorMessage } from './common/error-utils';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';

export const DEV_DEFAULTS: Readonly<Record<string, string>> = Object.freeze({
  ENVIRONMENT: 'dev',
  LOG_LEVEL: 'debug',
  ANALYTICS_ENABLED: 'false',
  BRIDGE_SYNC_ENABLED: 'false',
  TFTP_ENABLED: 'false',
  REDIS_URL: 'redis://localhost:6379/0',
  BROKKR_ZONE_ID: '',
  PERSISTENT_STORAGE_PATH: '/tmp/brokkr-dev',
});

const LINE_BOUNDARY_CLASS = '[\\n\\r\\v\\f\\x1c\\x1d\\x1e\\x85\\u2028\\u2029]';
const LINE_BOUNDARY_RE = new RegExp(`\\r\\n|${LINE_BOUNDARY_CLASS}`, 'g');
const LINE_BOUNDARY_END_RE = new RegExp(`(?:\\r\\n|${LINE_BOUNDARY_CLASS})$`);

function splitlines(text: string): string[] {
  const lines = text.split(LINE_BOUNDARY_RE);
  if (lines.length > 0 && lines[lines.length - 1] === '' && LINE_BOUNDARY_END_RE.test(text)) {
    lines.pop();
  }
  return lines;
}

export function parseEnvDev(contents: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of splitlines(contents)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) {
      if (!(line in out)) out[line] = '';
      continue;
    }
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (!(key in out)) out[key] = value;
  }
  return out;
}

export function applyEnvDefaults(env: NodeJS.ProcessEnv, defaults: Readonly<Record<string, string>>): void {
  for (const [key, value] of Object.entries(defaults)) {
    if (env[key] === undefined) {
      env[key] = value;
    }
  }
}

export function loadEnvDevFile(
  filePath: string,
  env: NodeJS.ProcessEnv = process.env,
  fs: { existsSync: typeof existsSync; readFileSync: typeof readFileSync } = {
    existsSync,
    readFileSync,
  },
): void {
  if (!fs.existsSync(filePath)) return;
  const contents = fs.readFileSync(filePath, 'utf-8');
  const parsed = parseEnvDev(contents);
  applyEnvDefaults(env, parsed);
}

export function ensureStorageDir(path: string, mkdir: typeof mkdirSync = mkdirSync): void {
  mkdir(path, { recursive: true });
}

const STRICT_INT_RE = /^[+-]?\p{Nd}(?:_?\p{Nd})*$/u;
const UNICODE_ND_RE = /\p{Nd}/u;

function normaliseIntLiteral(literal: string): string {
  let out = '';
  for (const ch of literal) {
    if (ch === '_') continue;
    if (ch === '+' || ch === '-') {
      out += ch;
      continue;
    }
    if (UNICODE_ND_RE.test(ch)) {
      const cp = ch.codePointAt(0) as number;
      out += unicodeDigitToAscii(cp);
      continue;
    }
    throw new Error(`unexpected character in int literal: ${JSON.stringify(ch)}`);
  }
  return out;
}

function unicodeDigitToAscii(cp: number): string {
  if (cp >= 0x30 && cp <= 0x39) return String.fromCharCode(cp);
  for (let offset = 0; offset <= 9; offset++) {
    const candidateZero = cp - offset;
    const ch = String.fromCodePoint(candidateZero);
    if (UNICODE_ND_RE.test(ch)) {
      const prev = candidateZero - 1;
      if (!UNICODE_ND_RE.test(String.fromCodePoint(prev))) {
        return String.fromCharCode(0x30 + offset);
      }
    }
  }
  throw new Error(`Unicode digit U+${cp.toString(16).toUpperCase()} did not map to ASCII`);
}

export function parseStrictInt(value: string, source: string): number {
  const trimmed = value.trim();
  if (trimmed === '' || !STRICT_INT_RE.test(trimmed)) {
    throw new Error(`invalid integer: ${JSON.stringify(value)} (source: ${source})`);
  }
  const ascii = normaliseIntLiteral(trimmed);
  const n = Number(ascii);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new Error(`invalid integer: ${JSON.stringify(value)} (source: ${source})`);
  }
  return n;
}

export function defaultEnvDevPath(): string {
  return resolve(__dirname, '..', '..', '..', '.env.dev');
}

export interface DevAppHandle {
  listen(host: string, port: number): Promise<void>;
  close(): Promise<void>;
}

export interface DevSupervisorHandle {
  requestShutdown(): void;
  waitForShutdown(): Promise<void>;
}

export interface DevAppFactory {
  create(): Promise<DevAppHandle>;
}

export interface DevSupervisorFactory {
  start(): DevSupervisorHandle;
}

export interface DevLogger {
  info(message: string): void;
  error(message: string): void;
}

export interface DevHostPort {
  host: string;
  port: number;
}

export interface RunDevDeps {
  appFactory: DevAppFactory;
  supervisorFactory: DevSupervisorFactory;
  hostPort: DevHostPort;
  logger: DevLogger;
  installSignalHandlers?: (handler: (signal: 'SIGTERM' | 'SIGINT') => void) => () => void;
}

export async function runDev(deps: RunDevDeps): Promise<void> {
  const installSignalHandlers = deps.installSignalHandlers ?? defaultInstallSignalHandlers;
  const app = await deps.appFactory.create();
  const supervisor = deps.supervisorFactory.start();

  let uninstall: (() => void) | null = null;
  const shutdownPromise = new Promise<void>((resolveShutdown) => {
    uninstall = installSignalHandlers(() => {
      supervisor.requestShutdown();
      resolveShutdown();
    });
  });

  try {
    await app.listen(deps.hostPort.host, deps.hostPort.port);
    deps.logger.info(`Bridge API ready — http://localhost:${deps.hostPort.port}`);
    await shutdownPromise;
  } catch (exc) {
    deps.logger.error(`Dev server failed: ${getErrorMessage(exc)}`);
    throw exc;
  } finally {
    if (uninstall !== null) uninstall();
    await safeClose(app, deps.logger);
    await safeWait(supervisor, deps.logger);
    await safeFlushTelemetry(deps.logger);
  }
}

async function safeFlushTelemetry(logger: DevLogger): Promise<void> {
  try {
    await shutdownTelemetry();
  } catch (exc) {
    logger.error(`Telemetry flush failed: ${getErrorMessage(exc)}`);
  }
}

async function safeClose(app: DevAppHandle, logger: DevLogger): Promise<void> {
  try {
    await app.close();
  } catch (exc) {
    logger.error(`Dev app close failed: ${getErrorMessage(exc)}`);
  }
}

async function safeWait(supervisor: DevSupervisorHandle, logger: DevLogger): Promise<void> {
  try {
    await supervisor.waitForShutdown();
  } catch (exc) {
    logger.error(`BullMQ supervisor join failed: ${getErrorMessage(exc)}`);
  }
}

function defaultInstallSignalHandlers(handler: (signal: 'SIGTERM' | 'SIGINT') => void): () => void {
  const onTerm = (): void => handler('SIGTERM');
  const onInt = (): void => handler('SIGINT');
  process.on('SIGTERM', onTerm);
  process.on('SIGINT', onInt);
  return (): void => {
    process.off('SIGTERM', onTerm);
    process.off('SIGINT', onInt);
  };
}

// Dynamic imports below: config modules read process.env at import time, so the env latch must precede any Nest import.

async function main(): Promise<number> {
  loadEnvDevFile(defaultEnvDevPath());
  applyEnvDefaults(process.env, DEV_DEFAULTS);
  const storagePath = process.env.PERSISTENT_STORAGE_PATH ?? '';
  ensureStorageDir(storagePath);

  // Must run before any Nest/fastify import loads the modules that instrumentation patches.
  const { initBridgeTelemetry } = await import('./telemetry/init-telemetry.js');
  initBridgeTelemetry();

  const { NestFactory } = await import('@nestjs/core');
  const { AppModule } = await import('./app.module.js');
  const { BullmqSupervisorService } = await import('./bullmq/bullmq-supervisor.service.js');
  const { getBullmqConfig } = await import('./bullmq/bullmq.config.js');
  const { createCollectionSweepQueue, createCollectionWorker, createLifecycleSweepQueue, createLifecycleWorker } =
    await import('./composition/bullmq-factories.js');

  const host = process.env.HOST ?? '0.0.0.0';
  const port = parseStrictInt(process.env.PORT ?? '8080', 'PORT');
  /* eslint-disable no-console -- dev-mode harness; no structured logger available */
  const logger: DevLogger = {
    info: (m) => console.log(`[dev] ${m}`),
    error: (m) => console.error(`[dev] ${m}`),
  };
  /* eslint-enable no-console */

  const appFactory: DevAppFactory = {
    async create() {
      const { FastifyAdapter } = await import('@nestjs/platform-fastify');
      const nest = await NestFactory.create<NestFastifyApplication>(
        await AppModule.withPluginBackends(),
        new FastifyAdapter(),
        {
          bufferLogs: false,
        },
      );
      return {
        async listen(h, p) {
          await nest.listen(p, h);
        },
        async close() {
          try {
            const { VrrpReconcilerService } = await import('./vrrp/vrrp-reconciler.service');
            await nest.get(VrrpReconcilerService, { strict: false }).detachAll();
          } catch (exc) {
            logger.error(`VRRP detach on shutdown failed: ${getErrorMessage(exc)}`);
          }
          await nest.close();
        },
      };
    },
  };

  const supervisorFactory: DevSupervisorFactory = {
    start() {
      const supervisor = new BullmqSupervisorService();
      supervisor.start(
        createLifecycleWorker,
        createCollectionWorker,
        createLifecycleSweepQueue(),
        createCollectionSweepQueue(),
        getBullmqConfig().delayedPromoteIntervalSeconds,
      );
      return {
        requestShutdown: () => supervisor.requestShutdown(),
        waitForShutdown: () => supervisor.waitForShutdown(),
      };
    },
  };

  try {
    await runDev({
      appFactory,
      supervisorFactory,
      hostPort: { host, port },
      logger,
    });
    return 0;
  } catch {
    return 1;
  }
}

if (require.main === module) {
  void main().then((code) => {
    if (code !== 0) process.exit(code);
  });
}
