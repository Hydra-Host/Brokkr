import { Module, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';

import { getErrorMessage } from '../common/error-utils.js';
import { NIL_JOB_ID } from '../constants.js';
import { logError, logInfo, logWarning } from '../logger/logger.service.js';

import { buildTftpServerDeps } from '../composition/tftp-server-factory.js';
import type { TftpServerLike } from '../startup/startup-services.js';

// startServer blocks for the daemon's lifetime — never await it during bootstrap.
@Module({})
export class TftpServerModule implements OnApplicationBootstrap, OnApplicationShutdown {
  private manager: TftpServerLike | null = null;
  private alive = false;
  private shuttingDown = false;

  exit: (code: number) => void = (code: number): void => process.exit(code);

  async onApplicationBootstrap(): Promise<void> {
    const deps = buildTftpServerDeps();
    if (!deps.config.tftpEnabled) {
      void logInfo('TFTP server disabled via configuration', { jobId: NIL_JOB_ID });
      return;
    }
    this.manager = deps.createManager(NIL_JOB_ID);
    void logInfo('Initiating TFTP server for network boot operations', { jobId: NIL_JOB_ID });
    this.alive = true;
    void this.manager
      .startServer()
      .then(() => this.onDaemonStopped(undefined))
      .catch((error: unknown) => this.onDaemonStopped(error))
      .finally(() => {
        this.alive = false;
      });
  }

  private onDaemonStopped(error: unknown): void {
    if (this.shuttingDown) {
      void logInfo('TFTP server background task stopped', { jobId: NIL_JOB_ID });
      return;
    }
    const detail = error instanceof Error ? error.message : error !== undefined ? String(error) : 'task exited';
    void logError(`TFTP server daemon exited unexpectedly; terminating bridge for supervised restart: ${detail}`, {
      jobId: NIL_JOB_ID,
    });
    this.exit(1);
  }

  // fail-soft: a throw here would abort the rest of Nest's shutdown sweep, including the closers
  // that release the Redis sockets keeping the process alive.
  async onApplicationShutdown(): Promise<void> {
    this.shuttingDown = true;
    if (this.alive) void logInfo('Gracefully stopping TFTP server', { jobId: NIL_JOB_ID });
    try {
      if (this.manager !== null) await this.manager.stopServer();
    } catch (error) {
      void logWarning(`TFTP server stop failed during shutdown: ${getErrorMessage(error)}`, { jobId: NIL_JOB_ID });
    }
  }
}
