import { logError, logInfo } from '../logger/logger.service.js';
import type { TftpServerLike as OrchestratorTftpServerLike, TftpServerDeps } from '../startup/startup-services.js';
import { TftpContextServer } from '../tftp/tftp-contexts.js';
import { createIpxeFallbackFunc } from '../tftp/tftp-dyn-file.js';
import { logServerStatus, setTftpJobId } from '../tftp/tftp-log-handler.js';
import { TFTPServerManager, type TftpManagerConfig, type TftpServerWrapperLike } from '../tftp/tftp-manager.service.js';
import {
  TftpServer,
  type DynFileFunc as ServerDynFileFunc,
  type TftpSession,
  type TftpSessionFactory,
  type TftpSessionState,
} from '../tftp/tftp-server.js';
import {
  TftpStateServerStart,
  type DynFileFunc as StateDynFileFunc,
  type TftpStateContext,
} from '../tftp/tftp-states.js';
import {
  AsyncTftpyServerWrapper,
  type RunningSignal,
  type TftpServerFactory,
  type TftpListenOptions as WrapperListenOptions,
  type TftpServerLike as WrapperTftpServerLike,
} from '../tftp/tftp-wrapper.js';
import { getTftpConfig, type TftpConfig } from '../tftp/tftp.config.js';

export function buildTftpServerDeps(): TftpServerDeps {
  const config = getTftpConfig();
  return {
    config,
    createManager: (jobId: string): OrchestratorTftpServerLike => buildTftpServerManager(jobId, config),
  };
}

function buildTftpServerManager(jobId: string, config: TftpConfig): TFTPServerManager {
  const managerConfig: TftpManagerConfig = {
    tftpRootDir: config.tftpRootDir,
    host: config.host,
    port: config.port,
  };
  return new TFTPServerManager({
    jobId,
    config: managerConfig,
    createWrapper: (wrapperConfig, wrapperJobId): TftpServerWrapperLike =>
      new AsyncTftpyServerWrapper({ tftpRootDir: wrapperConfig.tftpRootDir, port: wrapperConfig.port }, wrapperJobId, {
        serverFactory: buildTftpServerFactory(),
        logServerStatus,
        dynFileFunc: createIpxeFallbackFunc(() => wrapperConfig.tftpRootDir),
      }),
    logger: {
      info: logInfo,
      error: logError,
    },
    logServerStatus,
    setJobId: setTftpJobId,
  });
}

function buildTftpServerFactory(): TftpServerFactory {
  return (_jobId, dynFileFunc, tftproot): WrapperTftpServerLike =>
    adaptTftpServer(buildTftpServerInstance(tftproot, dynFileFunc));
}

function buildTftpServerInstance(tftproot: string, dynFileFunc: StateDynFileFunc | null): TftpServer {
  const serverDynFileFunc: ServerDynFileFunc | null =
    dynFileFunc === null ? null : (dynFileFunc as unknown as ServerDynFileFunc);
  return new TftpServer({
    tftproot,
    dynFileFunc: serverDynFileFunc,
    flock: true,
    sessionFactory: buildTftpSessionFactory(),
  });
}

function buildTftpSessionFactory(): TftpSessionFactory {
  return ({ host, port, timeout, root, dynFileFunc, retries }): TftpSession => {
    const contextDynFileFunc: ServerDynFileFunc | null = dynFileFunc;
    const context = new TftpContextServer(
      host,
      port,
      timeout,
      root,
      (ctx): TftpStateServerStart => new TftpStateServerStart(ctx as unknown as TftpStateContext),
      contextDynFileFunc,
      { retries, flock: true },
    );
    return adaptTftpContextServerToSession(context);
  };
}

function adaptTftpServer(server: TftpServer): WrapperTftpServerLike {
  const isRunning: RunningSignal = { isSet: () => server.isRunning };
  return {
    isRunning,
    get sock() {
      const dgramSock = server.sock;
      if (dgramSock === null) return null;
      return { getsockname: () => dgramSock.address() };
    },
    listen: (options: WrapperListenOptions): Promise<void> =>
      server.listen({
        listenip: options.listenip,
        listenport: options.listenport,
        timeout: options.timeout,
        retries: options.retries,
      }),
    stop: ({ now }): void => server.stop(now),
  };
}

function adaptTftpContextServerToSession(context: TftpContextServer): TftpSession {
  return {
    get sock() {
      return context.sock;
    },
    get host() {
      return context.host;
    },
    get state(): TftpSessionState | null {
      const s = context.state;
      return s === null ? null : (s as unknown as TftpSessionState);
    },
    set state(value: TftpSessionState | null) {
      context.state = value as never;
    },
    get timeoutExpectACK() {
      return context.timeoutExpectACK;
    },
    set timeoutExpectACK(value: boolean) {
      context.timeoutExpectACK = value;
    },
    get retryCount() {
      return context.retryCount;
    },
    set retryCount(value: number) {
      context.retryCount = value;
    },
    get retries() {
      return context.retries;
    },
    get metrics() {
      return context.metrics;
    },
    start: (buffer) => context.start(buffer),
    deliverFromRemote: (buffer, rinfo) => context.deliverFromRemote(buffer, rinfo),
    cycle: () => context.cycle(),
    checkTimeout: (now) => context.checkTimeout(now),
    end: () => context.end(),
  };
}
