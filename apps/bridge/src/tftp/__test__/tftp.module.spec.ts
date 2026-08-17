
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { buildTftpServerDeps } from '../../composition/tftp-server-factory.js';
import { logError, logInfo, logWarning } from '../../logger/logger.service.js';
import type { TftpServerLike } from '../../startup/startup-services.js';
import type { TftpConfig } from '../tftp.config.js';
import { TftpServerModule } from '../tftp.module.js';

vi.mock('../../composition/tftp-server-factory.js', () => ({ buildTftpServerDeps: vi.fn() }));
vi.mock('../../logger/logger.service.js', () => ({
  logInfo: vi.fn(async () => {}),
  logError: vi.fn(async () => {}),
  logWarning: vi.fn(async () => {}),
}));

function makeConfig(tftpEnabled: boolean): TftpConfig {
  return {
    tftpEnabled,
    tftpRootDir: '/tftp/root',
    port: 69,
    host: '0.0.0.0',
    logTransfers: true,
    allowedExtensions: ['.efi'],
    maxFileSize: 1024,
    enableWrite: false,
  };
}

function makeManager(startServer: () => Promise<void>): TftpServerLike & {
  startServer: ReturnType<typeof vi.fn>;
  stopServer: ReturnType<typeof vi.fn>;
} {
  return {
    startServer: vi.fn(startServer),
    stopServer: vi.fn(async () => {}),
  };
}

function makeModule(): { module: TftpServerModule; exit: ReturnType<typeof vi.fn> } {
  const module = new TftpServerModule();
  const exit = vi.fn();
  module.exit = exit;
  return { module, exit };
}

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

const mockedBuildDeps = vi.mocked(buildTftpServerDeps);
const mockedLogInfo = vi.mocked(logInfo);
const mockedLogError = vi.mocked(logError);
const mockedLogWarning = vi.mocked(logWarning);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('TftpServerModule lifecycle', () => {
  it('disabled gate: never builds a manager, logs disabled, shutdown is a no-op', async () => {
    const createManager = vi.fn();
    mockedBuildDeps.mockReturnValue({ config: makeConfig(false), createManager });

    const { module, exit } = makeModule();
    await module.onApplicationBootstrap();

    expect(createManager).not.toHaveBeenCalled();
    expect(mockedLogInfo).toHaveBeenCalledWith('TFTP server disabled via configuration', expect.anything());
    await expect(module.onApplicationShutdown()).resolves.toBeUndefined();
    expect(exit).not.toHaveBeenCalled();
  });

  it('enabled success: builds the manager, runs without exiting, and shutdown awaits stopServer', async () => {
    let releaseStart!: () => void;
    const manager = makeManager(() => new Promise<void>((resolve) => (releaseStart = resolve)));
    manager.stopServer = vi.fn(async () => releaseStart());
    const createManager = vi.fn(() => manager);
    mockedBuildDeps.mockReturnValue({ config: makeConfig(true), createManager });

    const { module, exit } = makeModule();
    await module.onApplicationBootstrap();
    await flush();

    expect(createManager).toHaveBeenCalledTimes(1);
    expect(manager.startServer).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();

    await module.onApplicationShutdown();
    await flush();
    expect(manager.stopServer).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();
  });

  it('enabled failure: bootstrap still resolves (boot not aborted), logs an error, and exits for restart', async () => {
    const manager = makeManager(() => Promise.reject(new Error('readiness never observed')));
    mockedBuildDeps.mockReturnValue({ config: makeConfig(true), createManager: () => manager });

    const { module, exit } = makeModule();
    await expect(module.onApplicationBootstrap()).resolves.toBeUndefined();
    await flush();

    expect(mockedLogError).toHaveBeenCalledWith(
      expect.stringContaining('TFTP server daemon exited unexpectedly'),
      expect.anything(),
    );
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('unexpected daemon exit while running logs an error and exits for restart', async () => {
    const manager = makeManager(() => Promise.resolve());
    mockedBuildDeps.mockReturnValue({ config: makeConfig(true), createManager: () => manager });

    const { module, exit } = makeModule();
    await module.onApplicationBootstrap();
    await flush();

    expect(mockedLogError).toHaveBeenCalledWith(
      expect.stringContaining('TFTP server daemon exited unexpectedly'),
      expect.anything(),
    );
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('startServer settling during shutdown is not treated as a crash (no exit)', async () => {
    let releaseStart!: () => void;
    const manager = makeManager(() => new Promise<void>((resolve) => (releaseStart = resolve)));
    manager.stopServer = vi.fn(async () => releaseStart());
    mockedBuildDeps.mockReturnValue({ config: makeConfig(true), createManager: () => manager });

    const { module, exit } = makeModule();
    await module.onApplicationBootstrap();
    await flush();
    await module.onApplicationShutdown();
    await flush();

    expect(exit).not.toHaveBeenCalled();
    expect(mockedLogInfo).toHaveBeenCalledWith('TFTP server background task stopped', expect.anything());
  });

  it('stops the server on shutdown even when startup failed', async () => {
    const manager = makeManager(() => Promise.reject(new Error('readiness never observed')));
    mockedBuildDeps.mockReturnValue({ config: makeConfig(true), createManager: () => manager });

    const { module } = makeModule();
    await module.onApplicationBootstrap();
    await flush();

    await module.onApplicationShutdown();
    expect(manager.stopServer).toHaveBeenCalledTimes(1);
  });

  it('resolves instead of throwing when stopServer rejects, so the shutdown sweep continues', async () => {
    let releaseStart!: () => void;
    const manager = makeManager(() => new Promise<void>((resolve) => (releaseStart = resolve)));
    manager.stopServer = vi.fn(async () => {
      releaseStart();
      throw new Error('stopServer exploded');
    });
    mockedBuildDeps.mockReturnValue({ config: makeConfig(true), createManager: () => manager });

    const { module } = makeModule();
    await module.onApplicationBootstrap();
    await flush();

    await expect(module.onApplicationShutdown()).resolves.toBeUndefined();
    expect(mockedLogWarning).toHaveBeenCalledWith(
      expect.stringContaining('TFTP server stop failed during shutdown'),
      expect.anything(),
    );
  });
});
