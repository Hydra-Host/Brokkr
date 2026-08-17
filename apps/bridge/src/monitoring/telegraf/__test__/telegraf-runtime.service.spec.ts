import { describe, expect, it, vi } from 'vitest';

import type { LoggerLike } from '../../../logger/logger.service';
import {
  gatherAsyncio,
  readTelegrafRuntimeConfigFromEnv,
  TelegrafRuntimeService,
  type TelegrafBmcCredentialsLookupLike,
  type TelegrafConfigWriterLike,
  type TelegrafPartitionerLike,
  type TelegrafRuntimeConfig,
} from '../telegraf-runtime.service';

function makeDeferred<T = void>(): {
  promise: Promise<T>;
  resolve: (v: T | PromiseLike<T>) => void;
  reject: (e: unknown) => void;
} {
  let resolve!: (v: T | PromiseLike<T>) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function defaultConfig(): TelegrafRuntimeConfig {
  return {
    outputPath: '/local/telegraf.d/owned.conf',
    renderConfig: {
      bridgeApiUrl: 'http://127.0.0.1:80',
      pollInterval: '30s',
      timeout: '10s',
    },
    debounceSeconds: 30,
    pollIntervalSeconds: 10,
  };
}

describe('TelegrafRuntimeService', () => {
  it('installs partitioner, logs start, then runs partitioner and writer in parallel', async () => {
    const events: string[] = [];
    const partStart = makeDeferred();
    const writerStart = makeDeferred();
    const partitioner: TelegrafPartitionerLike = {
      start: vi.fn().mockImplementation(async () => {
        events.push('partitioner.start');
        await partStart.promise;
      }),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const writer: TelegrafConfigWriterLike = {
      start: vi.fn().mockImplementation(async () => {
        events.push('writer.start');
        await writerStart.promise;
      }),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const credsLookup: TelegrafBmcCredentialsLookupLike = {
      close: vi.fn().mockResolvedValue(undefined),
    };
    const logger: LoggerLike = {
      debug: vi.fn().mockResolvedValue(undefined),
      info: vi.fn().mockResolvedValue(undefined),
      warning: vi.fn().mockResolvedValue(undefined),
      error: vi.fn().mockResolvedValue(undefined),
    };
    const installPartitioner = vi.fn();

    const service = new TelegrafRuntimeService(
      partitioner,
      writer,
      credsLookup,
      defaultConfig(),
      'job-1',
      logger,
      installPartitioner,
    );

    await service.onApplicationBootstrap();
    await new Promise((r) => setImmediate(r));

    expect(installPartitioner).toHaveBeenCalledWith(partitioner);
    expect(logger.info).toHaveBeenCalledWith('telegraf runtime starting; output=/local/telegraf.d/owned.conf', {
      appClassName: 'telegraf-runtime',
      jobId: 'job-1',
    });
    expect(partitioner.start).toHaveBeenCalled();
    expect(writer.start).toHaveBeenCalled();

    partStart.resolve();
    writerStart.resolve();
    await service.onApplicationShutdown();

    expect(credsLookup.close).toHaveBeenCalledTimes(1);
  });

  it('closes creds lookup once on combined error+shutdown path', async () => {
    const partStart = makeDeferred();
    const writerStart = makeDeferred();
    const partitioner: TelegrafPartitionerLike = {
      start: vi.fn().mockImplementation(async () => {
        await partStart.promise;
      }),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const writer: TelegrafConfigWriterLike = {
      start: vi.fn().mockImplementation(async () => {
        await writerStart.promise;
        throw new Error('writer boom');
      }),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const credsLookup: TelegrafBmcCredentialsLookupLike = {
      close: vi.fn().mockResolvedValue(undefined),
    };

    const service = new TelegrafRuntimeService(partitioner, writer, credsLookup, defaultConfig());

    await service.onApplicationBootstrap();
    writerStart.resolve();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    partStart.resolve();
    await service.onApplicationShutdown();

    expect(credsLookup.close).toHaveBeenCalledTimes(1);
  });

  it('tolerates a creds lookup without a close method', async () => {
    const partitioner: TelegrafPartitionerLike = {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const writer: TelegrafConfigWriterLike = {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const credsLookup: TelegrafBmcCredentialsLookupLike = {};

    const service = new TelegrafRuntimeService(partitioner, writer, credsLookup, defaultConfig());

    await service.onApplicationBootstrap();
    await service.onApplicationShutdown();
  });
});

describe('gatherAsyncio', () => {
  it('returns all values when every promise resolves', async () => {
    expect(await gatherAsyncio([Promise.resolve(1), Promise.resolve(2)])).toEqual([1, 2]);
  });

  it('returns immediately on empty input', async () => {
    expect(await gatherAsyncio<number>([])).toEqual([]);
  });

  it('re-raises first rejection without waiting for siblings', async () => {
    const slowResolved = { value: false };
    const slow = new Promise<number>((resolve) =>
      setTimeout(() => {
        slowResolved.value = true;
        resolve(42);
      }, 50),
    );
    const fastFail = new Promise<number>((_, reject) => setTimeout(() => reject(new Error('fail fast')), 5));

    const t0 = Date.now();
    await expect(gatherAsyncio([slow, fastFail])).rejects.toThrow('fail fast');
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(40);
    expect(slowResolved.value).toBe(false);
  });
});

describe('readTelegrafRuntimeConfigFromEnv', () => {
  it('returns defaults when env is empty', () => {
    const cfg = readTelegrafRuntimeConfigFromEnv({});
    expect(cfg.outputPath).toBe('/local/telegraf.d/owned.conf');
    expect(cfg.renderConfig.bridgeApiUrl).toBe('http://127.0.0.1:80');
    expect(cfg.renderConfig.pollInterval).toBe('30s');
    expect(cfg.renderConfig.timeout).toBe('10s');
    expect(cfg.debounceSeconds).toBe(30);
    expect(cfg.pollIntervalSeconds).toBe(10);
  });

  it('reads from env overrides', () => {
    const cfg = readTelegrafRuntimeConfigFromEnv({
      TELEGRAF_OWNED_CONF_PATH: '/tmp/owned.conf',
      BRIDGE_API_URL: 'http://1.2.3.4:8080',
      TELEGRAF_POLL_INTERVAL: '15s',
      TELEGRAF_HTTP_TIMEOUT: '5s',
      TELEGRAF_WRITER_DEBOUNCE: '12.5',
      TELEGRAF_WRITER_POLL_INTERVAL: '3.25',
    });
    expect(cfg.outputPath).toBe('/tmp/owned.conf');
    expect(cfg.renderConfig.bridgeApiUrl).toBe('http://1.2.3.4:8080');
    expect(cfg.renderConfig.pollInterval).toBe('15s');
    expect(cfg.renderConfig.timeout).toBe('5s');
    expect(cfg.debounceSeconds).toBe(12.5);
    expect(cfg.pollIntervalSeconds).toBe(3.25);
  });

  it('accepts IEEE 754 specials (case-insensitive inf/-inf/nan)', () => {
    expect(readTelegrafRuntimeConfigFromEnv({ TELEGRAF_WRITER_DEBOUNCE: 'inf' }).debounceSeconds).toBe(
      Number.POSITIVE_INFINITY,
    );
    expect(readTelegrafRuntimeConfigFromEnv({ TELEGRAF_WRITER_DEBOUNCE: '-Infinity' }).debounceSeconds).toBe(
      Number.NEGATIVE_INFINITY,
    );
    expect(Number.isNaN(readTelegrafRuntimeConfigFromEnv({ TELEGRAF_WRITER_DEBOUNCE: 'NaN' }).debounceSeconds)).toBe(
      true,
    );
  });

  it('rejects malformed float env values', () => {
    expect(() => readTelegrafRuntimeConfigFromEnv({ TELEGRAF_WRITER_DEBOUNCE: 'abc' })).toThrow(
      /could not convert string to float/,
    );
    expect(() => readTelegrafRuntimeConfigFromEnv({ TELEGRAF_WRITER_POLL_INTERVAL: '' })).toThrow(
      /could not convert string to float/,
    );
  });

  it('accepts PEP 515 underscore separators', () => {
    expect(readTelegrafRuntimeConfigFromEnv({ TELEGRAF_WRITER_DEBOUNCE: '1_000.5' }).debounceSeconds).toBe(1000.5);
  });
});
