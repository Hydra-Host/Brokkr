import { createSocket } from 'node:dgram';
import { mkdir, stat } from 'node:fs/promises';
import { getErrorMessage, hasErrnoCode } from '../common/error-utils';
import { logDebug } from '../logger/logger.service.js';

export interface TftpManagerConfig {
  tftpRootDir: string;
  host: string;
  port: number;
}

export interface TftpServerWrapperLike {
  start(): Promise<void>;
  stop(): Promise<void>;
  isAlive(): boolean;
}

export interface TftpManagerLogger {
  info(message: string, context?: { jobId?: string; appClassName?: string }): Promise<void>;
  error(message: string, context?: { jobId?: string; appClassName?: string }): Promise<void>;
}

export interface TftpManagerStatusLogger {
  (message: string, level?: 'info' | 'warning' | 'error' | 'debug'): Promise<void>;
}

export interface TftpManagerDeps {
  jobId: string;
  config: TftpManagerConfig;
  createWrapper(config: TftpManagerConfig, jobId: string): TftpServerWrapperLike;
  logger: TftpManagerLogger;
  logServerStatus: TftpManagerStatusLogger;
  setJobId(jobId: string): void;
  sleepMs?: (ms: number) => Promise<void>;
}

const KEEPALIVE_INTERVAL_MS = 1000;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function probeUdpPort(host: string, port: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const socket = createSocket('udp4');
    const cleanup = (): void => {
      try {
        socket.close();
      } catch (error) {
        void logDebug(`TFTP port probe socket close failed: ${getErrorMessage(error)}`);
      }
    };
    socket.once('error', (err) => {
      cleanup();
      reject(err);
    });
    socket.bind({ address: host, port }, () => {
      cleanup();
      resolve();
    });
  });
}

export class TFTPServerManager {
  readonly jobId: string;
  readonly tftpConfig: TftpManagerConfig;
  private wrapper: TftpServerWrapperLike | null = null;
  private running = false;
  private stopRequested = false;
  private readonly deps: TftpManagerDeps;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(deps: TftpManagerDeps) {
    this.jobId = deps.jobId;
    this.tftpConfig = deps.config;
    this.deps = deps;
    this.sleep = deps.sleepMs ?? defaultSleep;
    deps.setJobId(deps.jobId);
  }

  async validateConfiguration(): Promise<boolean> {
    try {
      const rootDir = this.tftpConfig.tftpRootDir;
      let rootExists = true;
      try {
        await stat(rootDir);
      } catch (exc) {
        if (hasErrnoCode(exc) && exc.code === 'ENOENT') {
          rootExists = false;
        } else {
          throw exc;
        }
      }
      if (!rootExists) {
        await this.deps.logger.info(`TFTP root directory does not exist, creating: ${rootDir}`, { jobId: this.jobId });
        await mkdir(rootDir, { recursive: true });
      }

      try {
        await probeUdpPort(this.tftpConfig.host, this.tftpConfig.port);
      } catch (exc) {
        if (!hasErrnoCode(exc)) throw exc;
        await this.deps.logger.error(`TFTP port ${this.tftpConfig.port} is not available: ${getErrorMessage(exc)}`, {
          jobId: this.jobId,
        });
        return false;
      }

      await this.deps.logger.info(`TFTP configuration validated - Root: ${rootDir}, Port: ${this.tftpConfig.port}`, {
        jobId: this.jobId,
      });

      return true;
    } catch (exc) {
      await this.deps.logger.error(`TFTP configuration validation failed: ${getErrorMessage(exc)}`, {
        jobId: this.jobId,
      });
      return false;
    }
  }

  async startServer(): Promise<void> {
    try {
      if (!(await this.validateConfiguration())) {
        throw new Error('TFTP configuration validation failed');
      }

      await this.deps.logServerStatus(`Starting TFTP server on 0.0.0.0:${this.tftpConfig.port}`);

      this.wrapper = this.deps.createWrapper(this.tftpConfig, this.jobId);

      await this.wrapper.start();

      this.running = true;

      await this.deps.logServerStatus(
        `TFTP server started successfully - Serving files from ${this.tftpConfig.tftpRootDir}`,
      );
    } catch (exc) {
      await this.deps.logger.error(`TFTP server failed to start: ${getErrorMessage(exc)}`, {
        jobId: this.jobId,
        appClassName: 'tftp',
      });
      throw exc;
    }

    try {
      while (this.running && !this.stopRequested && this.wrapper.isAlive()) {
        await this.sleep(KEEPALIVE_INTERVAL_MS);
      }
      if (!this.stopRequested && !this.wrapper.isAlive()) {
        // stopServer() can flip stopRequested during the awaited log; re-check AFTER the await so only the graceful-stop race is suppressed.
        await this.deps.logServerStatus('TFTP server thread exited unexpectedly', 'error');
        if (this.stopRequested) return;
        throw new Error('TFTP server thread exited unexpectedly');
      }
    } finally {
      if (this.wrapper) {
        await this.wrapper.stop();
      }
    }
  }

  async stopServer(): Promise<void> {
    try {
      await this.deps.logServerStatus('Stopping TFTP server');

      this.running = false;
      this.stopRequested = true;

      if (this.wrapper) {
        await this.wrapper.stop();
        this.wrapper = null;
      }

      await this.deps.logServerStatus('TFTP server stopped successfully');
    } catch (exc) {
      await this.deps.logger.error(`Error stopping TFTP server: ${getErrorMessage(exc)}`, {
        jobId: this.jobId,
        appClassName: 'tftp',
      });
    }
  }
}
