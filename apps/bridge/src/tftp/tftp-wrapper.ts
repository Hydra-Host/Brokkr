import { getErrorMessage } from '../common/error-utils';
import type { LoggerLike } from '../logger/logger.service.js';
import type { DynFileFunc } from './tftp-states.js';

export interface TftpWrapperConfig {
  tftpRootDir: string;
  port: number;
}

export interface TftpListenOptions {
  listenip: string;
  listenport: number;
  timeout: number;
  retries: number;
}

export interface RunningSignal {
  isSet(): boolean;
}

export interface SocketLike {
  getsockname(): unknown;
}

export interface TftpServerLike {
  isRunning: RunningSignal;
  sock: SocketLike | null;
  listen(options: TftpListenOptions): Promise<void>;
  stop(options: { now: boolean }): void;
}

// Factory must accept dynFileFunc (null disables): without it the iPXE fallback resolver is dead code and PXE boot breaks under commit-hash drift.
export type TftpServerFactory = (jobId: string, dynFileFunc: DynFileFunc | null, tftproot: string) => TftpServerLike;
export type LogServerStatus = (message: string, level?: 'info' | 'warning' | 'error' | 'debug') => Promise<void>;

const POLL_ATTEMPTS = 10;
const POLL_INTERVAL_MS = 100;
const SOCKET_FALLBACK_AFTER_ATTEMPTS = 5;
const STOP_JOIN_TIMEOUT_MS = 10_000;

function isShutdownSocketError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as { code?: unknown }).code;
  const errno = (error as { errno?: unknown }).errno;
  return code === 'EBADF' || errno === 9 || errno === -9;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class AsyncTftpyServerWrapper {
  readonly tftpConfig: TftpWrapperConfig;
  readonly jobId: string;
  server: TftpServerLike | null = null;
  serverTask: Promise<void> | null = null;
  running = false;

  private readonly serverFactory: TftpServerFactory;
  private readonly logServerStatus: LogServerStatus;
  private readonly dynFileFunc: DynFileFunc | null;
  private serverTaskAlive = false;

  constructor(
    tftpConfig: TftpWrapperConfig,
    jobId: string,
    deps: {
      serverFactory: TftpServerFactory;
      logServerStatus: LogServerStatus;
      dynFileFunc?: DynFileFunc | null;
      logger?: LoggerLike;
    },
  ) {
    void deps.logger;
    this.tftpConfig = tftpConfig;
    this.jobId = jobId;
    this.serverFactory = deps.serverFactory;
    this.logServerStatus = deps.logServerStatus;
    this.dynFileFunc = deps.dynFileFunc ?? null;
  }

  async startServerThread(): Promise<void> {
    try {
      this.server = this.serverFactory(this.jobId, this.dynFileFunc, this.tftpConfig.tftpRootDir);

      try {
        await this.logServerStatus(
          `TFTP server starting on 0.0.0.0:${this.tftpConfig.port} serving ${this.tftpConfig.tftpRootDir}`,
        );
      } catch (error) {
        void error;
      }

      try {
        await this.server.listen({
          listenip: '',
          listenport: this.tftpConfig.port,
          timeout: 1,
          retries: 3,
        });
      } catch (error) {
        if (isShutdownSocketError(error)) {
          return;
        }
        throw error;
      }
    } catch (error) {
      this.running = false;
      try {
        await this.logServerStatus(`TFTP server failed: ${getErrorMessage(error)}`, 'error');
      } catch (logExc) {
        void logExc;
      }
      throw error;
    }
  }

  async start(): Promise<void> {
    this.serverTaskAlive = true;
    this.serverTask = (async () => {
      try {
        await this.startServerThread();
      } catch (error) {
        try {
          await this.logServerStatus(`TFTP server thread failed: ${getErrorMessage(error)}`, 'error');
        } catch (logExc) {
          void logExc;
        }
        this.running = false;
      } finally {
        this.serverTaskAlive = false;
      }
    })();

    for (let i = 0; i < POLL_ATTEMPTS; i++) {
      await delay(POLL_INTERVAL_MS);

      if (!this.serverTaskAlive) {
        throw new Error('TFTP server thread died unexpectedly - check logs for errors');
      }

      if (this.server && this.server.isRunning && this.server.isRunning.isSet()) {
        this.running = true;
        break;
      }

      if (this.server && this.server.sock) {
        try {
          this.server.sock.getsockname();
          if (i >= SOCKET_FALLBACK_AFTER_ATTEMPTS) {
            this.running = true;
            break;
          }
        } catch (error) {
          void this.logServerStatus(`TFTP socket poll getsockname failed: ${getErrorMessage(error)}`, 'debug').catch(
            () => undefined,
          );
        }
      }
    }

    if (!this.running) {
      let errorMsg = 'TFTP server failed to start';
      if (this.server) {
        if (this.server.sock) {
          errorMsg += ' - socket exists but server loop not running';
        } else {
          errorMsg += ' - socket not created';
        }
      } else {
        errorMsg += ' - server object not created';
      }
      throw new Error(errorMsg);
    }
  }

  isAlive(): boolean {
    return this.serverTaskAlive;
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.server !== null) {
      this.server.stop({ now: true });
    }
    if (this.serverTask && this.serverTaskAlive) {
      let joinTimer: ReturnType<typeof setTimeout> | undefined;
      const joinTimeout = new Promise<void>((resolve) => {
        joinTimer = setTimeout(resolve, STOP_JOIN_TIMEOUT_MS);
        joinTimer.unref?.();
      });
      try {
        await Promise.race([this.serverTask.catch(() => undefined), joinTimeout]);
      } finally {
        if (joinTimer) clearTimeout(joinTimer);
      }
    }
  }
}
