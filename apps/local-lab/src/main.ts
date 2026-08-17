import 'reflect-metadata';

import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module';
import { labBindHost, labCorsOrigins } from './common/lab-auth';
import { labOriginMiddleware } from './common/lab-context';
import { requireJsonMutation } from './common/require-json-mutation.middleware';
import { attachWebSockets } from './fleet/shell-server';
import { AuditStore } from './ledger/audit-store';
import { bootRunLedger } from './ledger/ledger-boot';
import { RunLedgerService } from './ledger/run-ledger.service';
import { RunRetentionService } from './ledger/run-retention.service';
import { StateDirLock } from './ledger/state-dir-lock';
import { PORTS } from './ports';
import { RunnerService } from './runner/runner.service';

const PORT = PORTS.lab;

async function bootstrap() {
  // Without forceCloseConnections, app.close() waits on the lab's long-lived SSE/WS streams, so SIGTERM
  // teardown hangs while a control-center tab is open and the shutdown hooks below never run.
  const app = await NestFactory.create(AppModule, { forceCloseConnections: true });
  // not a NestModule.configure() route: nest mounts those with `app.use(path, …)`, and express 5 moves
  // the matched wildcard into req.baseUrl, leaving req.path '/' on every request.
  app.use(labOriginMiddleware);
  // run each provider's OnApplicationShutdown on SIGTERM/SIGINT (unlike the bridge, the lab has no
  // hand-rolled signal handler to race, so Nest's hooks are the clean teardown path).
  app.enableShutdownHooks();
  const host = labBindHost();
  // Never `origin: true` — reflecting any Origin makes the destructive no-credential routes drive-by CSRF-callable.
  app.enableCors({ origin: labCorsOrigins() });
  // registered before listen() so it precedes Nest's own body parser — a refused request never allocates a body.
  app.use(requireJsonMutation(app.get(AuditStore)));
  await app.listen(PORT, host);
  bootRunLedger(app.get(StateDirLock), app.get(RunLedgerService), app.get(RunRetentionService));
  attachWebSockets(app.getHttpServer(), app.get(RunnerService), app.get(AuditStore));
  Logger.log(`lab api on http://${host}:${PORT}`, 'Bootstrap');
  Logger.log(`  swagger:  http://${host}:${PORT}/api/swagger`, 'Bootstrap');
  Logger.log(`  redoc:    http://${host}:${PORT}/api/redoc`, 'Bootstrap');
  Logger.log(`  openapi:  http://${host}:${PORT}/api/swagger-json`, 'Bootstrap');
}
void bootstrap();
