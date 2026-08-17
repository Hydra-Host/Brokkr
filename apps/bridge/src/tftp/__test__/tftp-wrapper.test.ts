import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { createIpxeFallbackFunc } from '../tftp-dyn-file.js';
import type { DynFileFunc, TftpFileObject } from '../tftp-states.js';
import {
  AsyncTftpyServerWrapper,
  type RunningSignal,
  type SocketLike,
  type TftpListenOptions,
  type TftpServerLike,
  type TftpWrapperConfig,
} from '../tftp-wrapper.js';

function makeConfig(overrides: Partial<TftpWrapperConfig> = {}): TftpWrapperConfig {
  return {
    tftpRootDir: '/test/tftp/root',
    port: 69,
    ...overrides,
  };
}

interface FakeServerOptions {
  runningWhenChecked?: boolean;
  hasSocket?: boolean;
  listenError?: Error & { code?: string; errno?: number };
}

interface FakeServer extends TftpServerLike {
  listen: import('vitest').Mock<(options: TftpListenOptions) => Promise<void>>;
  stop: import('vitest').Mock<() => void>;
  releaseListen(): void;
}

function makeFakeServer(opts: FakeServerOptions = {}): FakeServer {
  const sockShape: SocketLike | null = opts.hasSocket ? ({ getsockname: () => ({}) } as SocketLike) : null;
  const isRunning: RunningSignal = {
    isSet: () => opts.runningWhenChecked === true,
  };
  let releaseFn: () => void = () => {};
  const listenGate = new Promise<void>((resolve) => {
    releaseFn = resolve;
  });
  const server: FakeServer = {
    isRunning,
    sock: sockShape,
    listen: vi.fn(async (_opts: TftpListenOptions) => {
      if (opts.listenError) throw opts.listenError;
      await listenGate;
    }),
    stop: vi.fn(() => {
      releaseFn();
    }),
    releaseListen: () => {
      releaseFn();
    },
  };
  return server;
}

describe('AsyncTftpyServerWrapper', () => {
  it('initializes with running=false and no server/task yet', () => {
    const wrapper = new AsyncTftpyServerWrapper(makeConfig(), 'test-job', {
      serverFactory: () => makeFakeServer(),
      logServerStatus: vi.fn(async () => {}),
    });
    expect(wrapper.jobId).toBe('test-job');
    expect(wrapper.tftpConfig).toEqual(makeConfig());
    expect(wrapper.server).toBeNull();
    expect(wrapper.serverTask).toBeNull();
    expect(wrapper.running).toBe(false);
  });

  it('start() invokes the server factory and listen()', async () => {
    const server = makeFakeServer({ runningWhenChecked: true });
    const wrapper = new AsyncTftpyServerWrapper(makeConfig(), 'thread-job', {
      serverFactory: () => server,
      logServerStatus: vi.fn(async () => {}),
    });
    await wrapper.start();
    expect(wrapper.server).toBe(server);
    expect(server.listen).toHaveBeenCalledOnce();
    expect(wrapper.running).toBe(true);
    await wrapper.stop();
  });

  it('start() swallows EBADF / errno 9 socket errors during shutdown races', async () => {
    const ebadf = Object.assign(new Error('Bad file descriptor'), { errno: 9, code: 'EBADF' });
    const server = makeFakeServer({ listenError: ebadf });
    const wrapper = new AsyncTftpyServerWrapper(makeConfig(), 'error-job', {
      serverFactory: () => server,
      logServerStatus: vi.fn(async () => {}),
    });
    await expect(wrapper.startServerThread()).resolves.toBeUndefined();
  });

  it('startServerThread re-raises non-shutdown socket errors', async () => {
    const eaddrinuse = Object.assign(new Error('Address already in use'), { errno: 98, code: 'EADDRINUSE' });
    const server = makeFakeServer({ listenError: eaddrinuse });
    const wrapper = new AsyncTftpyServerWrapper(makeConfig(), 'error-job', {
      serverFactory: () => server,
      logServerStatus: vi.fn(async () => {}),
    });
    await expect(wrapper.startServerThread()).rejects.toThrow(/Address already in use/);
  });

  it('startServerThread propagates serverFactory exceptions', async () => {
    const wrapper = new AsyncTftpyServerWrapper(makeConfig(), 'exception-job', {
      serverFactory: () => {
        throw new Error('Factory failed');
      },
      logServerStatus: vi.fn(async () => {}),
    });
    await expect(wrapper.startServerThread()).rejects.toThrow(/Factory failed/);
    expect(wrapper.running).toBe(false);
  });

  it('start() resolves once isRunning.isSet() returns true', async () => {
    let signalled = false;
    let releaseFn: () => void = () => {};
    const listenGate = new Promise<void>((resolve) => {
      releaseFn = resolve;
    });
    const isRunning: RunningSignal = { isSet: () => signalled };
    const server: TftpServerLike = {
      isRunning,
      sock: null,
      listen: vi.fn(async () => {
        signalled = true;
        await listenGate;
      }),
      stop: vi.fn(() => {
        releaseFn();
      }),
    };
    const wrapper = new AsyncTftpyServerWrapper(makeConfig(), 'wrapper-job', {
      serverFactory: () => server,
      logServerStatus: vi.fn(async () => {}),
    });
    await wrapper.start();
    expect(wrapper.running).toBe(true);
    await wrapper.stop();
  });

  it('start() throws when the server thread dies before signalling ready', async () => {
    const server = makeFakeServer({
      listenError: Object.assign(new Error('addr in use'), { errno: 98, code: 'EADDRINUSE' }),
    });
    const wrapper = new AsyncTftpyServerWrapper(makeConfig(), 'wrapper-fail-job', {
      serverFactory: () => server,
      logServerStatus: vi.fn(async () => {}),
    });
    await expect(wrapper.start()).rejects.toThrow(/TFTP server thread died unexpectedly/);
  });

  it('stop() invokes server.stop({ now: true }) and joins the task', async () => {
    const server = makeFakeServer({ runningWhenChecked: true });
    const wrapper = new AsyncTftpyServerWrapper(makeConfig(), 'stop-job', {
      serverFactory: () => server,
      logServerStatus: vi.fn(async () => {}),
    });
    await wrapper.start();
    await wrapper.stop();
    expect(wrapper.running).toBe(false);
    expect(server.stop).toHaveBeenCalledWith({ now: true });
  });

  it('stop() before start() is a no-op (no thread to join)', async () => {
    const wrapper = new AsyncTftpyServerWrapper(makeConfig(), 'stop-job', {
      serverFactory: () => makeFakeServer(),
      logServerStatus: vi.fn(async () => {}),
    });
    await expect(wrapper.stop()).resolves.toBeUndefined();
    expect(wrapper.running).toBe(false);
  });
});

describe('AsyncTftpyServerWrapper iPXE fallback wiring', () => {
  it('forwards dynFileFunc + tftpRootDir to the server factory', async () => {
    const server = makeFakeServer({ runningWhenChecked: true });
    const stubFile: TftpFileObject = {
      read: () => Buffer.alloc(0),
      seekEnd: () => {},
      seekStart: () => {},
      tell: () => 0,
      close: () => {},
      closed: false,
    };
    const dynFileFunc: DynFileFunc = () => stubFile;
    const factory = vi.fn((_jobId: string, _dynFileFunc: DynFileFunc | null, _tftproot: string) => server);
    const config = makeConfig({ tftpRootDir: '/tftp/root/wire' });
    const wrapper = new AsyncTftpyServerWrapper(config, 'wire-job', {
      serverFactory: factory,
      logServerStatus: vi.fn(async () => {}),
      dynFileFunc,
    });
    await wrapper.start();
    expect(factory).toHaveBeenCalledOnce();
    const [jobIdArg, dynFileArg, tftprootArg] = factory.mock.calls[0]!;
    expect(jobIdArg).toBe('wire-job');
    expect(dynFileArg).toBe(dynFileFunc);
    expect(tftprootArg).toBe('/tftp/root/wire');
    await wrapper.stop();
  });

  it('passes null dynFileFunc when none supplied', async () => {
    const server = makeFakeServer({ runningWhenChecked: true });
    const factory = vi.fn((_jobId: string, _dynFileFunc: DynFileFunc | null, _tftproot: string) => server);
    const wrapper = new AsyncTftpyServerWrapper(makeConfig(), 'null-dyn-job', {
      serverFactory: factory,
      logServerStatus: vi.fn(async () => {}),
    });
    await wrapper.start();
    expect(factory.mock.calls[0]![1]).toBeNull();
    await wrapper.stop();
  });

  it('forwarded resolver maps stale-commit-hash filename to the prebuilt iPXE binary', () => {
    const workDir = mkdtempSync(join(tmpdir(), 'tftp-wire-'));
    const ipxeRoot = join(workDir, 'ipxe-builds');
    mkdirSync(join(ipxeRoot, 'amd64'), { recursive: true });
    const payload = Buffer.from('IPXE-BINARY');
    writeFileSync(join(ipxeRoot, 'amd64', 'snponly.efi'), payload);
    try {
      const dynFileFunc = createIpxeFallbackFunc(() => ipxeRoot);
      const fileObj = dynFileFunc('snponly-amd64-deadbeef.efi', '127.0.0.1', 0);
      expect(fileObj).not.toBeNull();
      expect(fileObj!.read(payload.length).equals(payload)).toBe(true);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });
});
