import { createSocket as mockedCreateSocket } from 'node:dgram';
import { mkdir as mockedMkdir, stat as mockedStat } from 'node:fs/promises';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import {
  TFTPServerManager,
  type TftpManagerConfig,
  type TftpManagerDeps,
  type TftpServerWrapperLike,
} from '../tftp-manager.service.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    stat: vi.fn(),
    mkdir: vi.fn(),
  };
});

vi.mock('node:dgram', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:dgram')>();
  return {
    ...actual,
    createSocket: vi.fn(),
  };
});

function makeConfig(overrides: Partial<TftpManagerConfig> = {}): TftpManagerConfig {
  return {
    host: '0.0.0.0',
    port: 69,
    tftpRootDir: '/test/tftp/root',
    ...overrides,
  };
}

function makeWrapper(): TftpServerWrapperLike & {
  start: Mock<(...args: any[]) => any>;
  stop: Mock<(...args: any[]) => any>;
  isAlive: Mock<(...args: any[]) => any>;
} {
  return {
    start: vi.fn(async () => {}),
    stop: vi.fn(),
    isAlive: vi.fn(() => true),
  };
}

interface MockSocket {
  once: Mock<(...args: any[]) => any>;
  bind: Mock<(...args: any[]) => any>;
  close: Mock<(...args: any[]) => any>;
}

function makeBindOkSocket(): MockSocket {
  const sock: MockSocket = {
    once: vi.fn(),
    bind: vi.fn((_opts, cb: () => void) => {
      cb();
    }),
    close: vi.fn(),
  };
  return sock;
}

function makeBindErrSocket(err: Error & { code?: string }): MockSocket {
  const sock: MockSocket = {
    once: vi.fn((event: string, handler: (e: Error) => void) => {
      if (event === 'error') {
        queueMicrotask(() => handler(err));
      }
    }),
    bind: vi.fn(),
    close: vi.fn(),
  };
  return sock;
}

function makeDeps(
  overrides: Partial<TftpManagerDeps> = {},
  wrapper: TftpServerWrapperLike = makeWrapper(),
): TftpManagerDeps {
  return {
    jobId: 'test-job',
    config: makeConfig(),
    createWrapper: vi.fn(() => wrapper),
    logger: {
      info: vi.fn(async () => {}),
      error: vi.fn(async () => {}),
    },
    logServerStatus: vi.fn(async () => {}),
    setJobId: vi.fn(),
    sleepMs: async () => {},
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('TFTPServerManager', () => {
  it('initializes from config and registers global job id', () => {
    const deps = makeDeps();
    const manager = new TFTPServerManager(deps);
    expect(manager.jobId).toBe('test-job');
    expect(manager.tftpConfig).toEqual(makeConfig());
    expect(deps.setJobId).toHaveBeenCalledWith('test-job');
  });

  it('validates configuration when the root directory exists and the port is free', async () => {
    vi.mocked(mockedStat).mockResolvedValueOnce({} as Awaited<ReturnType<typeof mockedStat>>);
    vi.mocked(mockedCreateSocket).mockReturnValueOnce(
      makeBindOkSocket() as unknown as ReturnType<typeof mockedCreateSocket>,
    );

    const manager = new TFTPServerManager(makeDeps());
    expect(await manager.validateConfiguration()).toBe(true);
  });

  it('creates the root directory when missing instead of failing', async () => {
    const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    vi.mocked(mockedStat).mockRejectedValueOnce(enoent);
    vi.mocked(mockedMkdir).mockResolvedValueOnce(undefined);
    vi.mocked(mockedCreateSocket).mockReturnValueOnce(
      makeBindOkSocket() as unknown as ReturnType<typeof mockedCreateSocket>,
    );

    const manager = new TFTPServerManager(makeDeps());
    expect(await manager.validateConfiguration()).toBe(true);
    expect(mockedMkdir).toHaveBeenCalledWith('/test/tftp/root', { recursive: true });
  });

  it('returns false when the UDP port is unavailable', async () => {
    vi.mocked(mockedStat).mockResolvedValueOnce({} as Awaited<ReturnType<typeof mockedStat>>);
    const bindError = Object.assign(new Error('Address already in use'), { code: 'EADDRINUSE' });
    vi.mocked(mockedCreateSocket).mockReturnValueOnce(
      makeBindErrSocket(bindError) as unknown as ReturnType<typeof mockedCreateSocket>,
    );

    const manager = new TFTPServerManager(makeDeps());
    expect(await manager.validateConfiguration()).toBe(false);
  });

  it('returns false when an unexpected stat error escapes', async () => {
    vi.mocked(mockedStat).mockRejectedValueOnce(new Error('Path error'));
    const manager = new TFTPServerManager(makeDeps());
    expect(await manager.validateConfiguration()).toBe(false);
  });

  it('startServer awaits wrapper.start and enters the keepalive loop', async () => {
    vi.mocked(mockedStat).mockResolvedValueOnce({} as Awaited<ReturnType<typeof mockedStat>>);
    vi.mocked(mockedCreateSocket).mockReturnValueOnce(
      makeBindOkSocket() as unknown as ReturnType<typeof mockedCreateSocket>,
    );

    const wrapper = makeWrapper();
    let manager: TFTPServerManager | null = null;
    let sleepCount = 0;
    const deps = makeDeps(
      {
        sleepMs: async () => {
          sleepCount += 1;
          if (sleepCount === 1 && manager) await manager.stopServer();
        },
      },
      wrapper,
    );
    manager = new TFTPServerManager(deps);
    await manager.startServer();
    expect(wrapper.start).toHaveBeenCalledOnce();
  });

  it('startServer surfaces and rethrows when the wrapper task dies unexpectedly', async () => {
    vi.mocked(mockedStat).mockResolvedValueOnce({} as Awaited<ReturnType<typeof mockedStat>>);
    vi.mocked(mockedCreateSocket).mockReturnValueOnce(
      makeBindOkSocket() as unknown as ReturnType<typeof mockedCreateSocket>,
    );

    const wrapper = makeWrapper();
    wrapper.isAlive.mockReturnValueOnce(true).mockReturnValue(false);
    const deps = makeDeps({}, wrapper);
    const manager = new TFTPServerManager(deps);
    await expect(manager.startServer()).rejects.toThrow(/exited unexpectedly/);
    expect(deps.logServerStatus).toHaveBeenCalledWith('TFTP server thread exited unexpectedly', 'error');
    expect(wrapper.stop).toHaveBeenCalled();
  });

  it('startServer suppresses the throw when a stop is requested during the exit-status await', async () => {
    vi.mocked(mockedStat).mockResolvedValueOnce({} as Awaited<ReturnType<typeof mockedStat>>);
    vi.mocked(mockedCreateSocket).mockReturnValueOnce(
      makeBindOkSocket() as unknown as ReturnType<typeof mockedCreateSocket>,
    );

    const wrapper = makeWrapper();
    wrapper.isAlive.mockReturnValueOnce(true).mockReturnValue(false);

    let manager: TFTPServerManager | null = null;
    const deps = makeDeps(
      {
        logServerStatus: vi.fn(async (message: string) => {
          if (message.includes('exited unexpectedly') && manager) await manager.stopServer();
        }),
      },
      wrapper,
    );
    manager = new TFTPServerManager(deps);
    await expect(manager.startServer()).resolves.toBeUndefined();
  });

  it('startServer throws when validation fails', async () => {
    vi.mocked(mockedStat).mockResolvedValueOnce({} as Awaited<ReturnType<typeof mockedStat>>);
    const bindError = Object.assign(new Error('Address already in use'), { code: 'EADDRINUSE' });
    vi.mocked(mockedCreateSocket).mockReturnValueOnce(
      makeBindErrSocket(bindError) as unknown as ReturnType<typeof mockedCreateSocket>,
    );

    const manager = new TFTPServerManager(makeDeps());
    await expect(manager.startServer()).rejects.toThrow(/TFTP configuration validation failed/);
  });

  it('stopServer halts the loop and tears down the wrapper', async () => {
    vi.mocked(mockedStat).mockResolvedValueOnce({} as Awaited<ReturnType<typeof mockedStat>>);
    vi.mocked(mockedCreateSocket).mockReturnValueOnce(
      makeBindOkSocket() as unknown as ReturnType<typeof mockedCreateSocket>,
    );

    const wrapper = makeWrapper();
    let manager: TFTPServerManager | null = null;
    let sleepTicks = 0;
    const deps = makeDeps(
      {
        sleepMs: async () => {
          sleepTicks += 1;
          if (sleepTicks === 1 && manager) await manager.stopServer();
        },
      },
      wrapper,
    );
    manager = new TFTPServerManager(deps);
    await manager.startServer();
    expect(wrapper.stop).toHaveBeenCalled();
  });

  it('stopServer awaits the wrapper join before resolving and logging success', async () => {
    vi.mocked(mockedStat).mockResolvedValueOnce({} as Awaited<ReturnType<typeof mockedStat>>);
    vi.mocked(mockedCreateSocket).mockReturnValueOnce(
      makeBindOkSocket() as unknown as ReturnType<typeof mockedCreateSocket>,
    );

    let releaseStop!: () => void;
    const stopGate = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    const wrapper = makeWrapper();
    wrapper.stop = vi.fn(async () => {
      await stopGate;
    });

    let reachedKeepalive!: () => void;
    const keepaliveReached = new Promise<void>((resolve) => {
      reachedKeepalive = resolve;
    });
    let releaseKeepalive!: () => void;
    const parkGate = new Promise<void>((resolve) => {
      releaseKeepalive = resolve;
    });
    let keepaliveParked = false;
    const deps = makeDeps(
      {
        sleepMs: async () => {
          if (!keepaliveParked) {
            keepaliveParked = true;
            reachedKeepalive();
            await parkGate;
          }
        },
      },
      wrapper,
    );
    const manager = new TFTPServerManager(deps);
    const startPromise = manager.startServer();
    await keepaliveReached;

    let stopResolved = false;
    const stopPromise = manager.stopServer().then(() => {
      stopResolved = true;
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(stopResolved).toBe(false);
    expect(deps.logServerStatus).toHaveBeenCalledWith('Stopping TFTP server');
    expect(deps.logServerStatus).not.toHaveBeenCalledWith('TFTP server stopped successfully');

    releaseStop();
    await stopPromise;
    expect(stopResolved).toBe(true);
    expect(deps.logServerStatus).toHaveBeenCalledWith('TFTP server stopped successfully');

    releaseKeepalive();
    await startPromise;
  });

  it('startServer surfaces wrapper construction errors', async () => {
    vi.mocked(mockedStat).mockResolvedValueOnce({} as Awaited<ReturnType<typeof mockedStat>>);
    vi.mocked(mockedCreateSocket).mockReturnValueOnce(
      makeBindOkSocket() as unknown as ReturnType<typeof mockedCreateSocket>,
    );

    const deps = makeDeps({
      createWrapper: () => {
        throw new Error('Wrapper failed');
      },
    });
    const manager = new TFTPServerManager(deps);
    await expect(manager.startServer()).rejects.toThrow(/Wrapper failed/);
  });

  it('stopServer swallows wrapper.stop exceptions', async () => {
    const wrapper = makeWrapper();
    wrapper.stop = vi.fn(() => {
      throw new Error('Stop failed');
    });
    const deps = makeDeps(
      {
        logServerStatus: vi.fn(async () => {
          throw new Error('Log error');
        }),
      },
      wrapper,
    );
    const manager = new TFTPServerManager(deps);
    await expect(manager.stopServer()).resolves.toBeUndefined();
  });
});
