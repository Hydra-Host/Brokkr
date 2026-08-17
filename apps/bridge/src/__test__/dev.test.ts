import { describe, expect, it, vi } from 'vitest';

import {
  DEV_DEFAULTS,
  applyEnvDefaults,
  defaultEnvDevPath,
  ensureStorageDir,
  loadEnvDevFile,
  parseEnvDev,
  parseStrictInt,
  runDev,
  type DevAppFactory,
  type DevAppHandle,
  type DevLogger,
  type DevSupervisorFactory,
  type DevSupervisorHandle,
} from '../dev.js';

function makeLogger(): { logger: DevLogger; entries: Array<{ level: string; message: string }> } {
  const entries: Array<{ level: string; message: string }> = [];
  const logger: DevLogger = {
    info: (m) => {
      entries.push({ level: 'info', message: m });
    },
    error: (m) => {
      entries.push({ level: 'error', message: m });
    },
  };
  return { logger, entries };
}

describe('parseEnvDev', () => {
  it('parses simple KEY=value pairs', () => {
    expect(parseEnvDev('FOO=bar\nBAZ=qux')).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });

  it('trims whitespace around key and value', () => {
    expect(parseEnvDev('  FOO  =  bar  ')).toEqual({ FOO: 'bar' });
  });

  it('skips blank lines and comments', () => {
    const text = '\n# comment\n   # indented comment\nFOO=bar\n\n';
    expect(parseEnvDev(text)).toEqual({ FOO: 'bar' });
  });

  it('partitions on the first = so values may contain =', () => {
    expect(parseEnvDev('URL=postgres://u:p@h/db?x=1')).toEqual({
      URL: 'postgres://u:p@h/db?x=1',
    });
  });

  it('records empty value when line lacks =', () => {
    expect(parseEnvDev('BARE_KEY')).toEqual({ BARE_KEY: '' });
  });

  it('first duplicate key wins at parse time (setdefault semantics)', () => {
    expect(parseEnvDev('K=a\nK=b')).toEqual({ K: 'a' });
  });

  it('records empty key when line starts with =', () => {
    expect(parseEnvDev('=foo')).toEqual({ '': 'foo' });
  });

  it('splits on str.splitlines() boundaries (bare \\r, \\v, \\f, U+2028)', () => {
    expect(parseEnvDev('A=1\rB=2')).toEqual({ A: '1', B: '2' });
    expect(parseEnvDev('A=1\r\nB=2')).toEqual({ A: '1', B: '2' });
    expect(parseEnvDev('A=1 B=2')).toEqual({ A: '1', B: '2' });
    expect(parseEnvDev('A=1\fB=2')).toEqual({ A: '1', B: '2' });
  });
});

describe('parseStrictInt', () => {
  it('parses a plain integer', () => {
    expect(parseStrictInt('8080', 'PORT')).toBe(8080);
  });

  it('accepts a signed integer', () => {
    expect(parseStrictInt('-7', 'X')).toBe(-7);
    expect(parseStrictInt('+7', 'X')).toBe(7);
  });

  it('strips surrounding ASCII whitespace', () => {
    expect(parseStrictInt('  42  ', 'X')).toBe(42);
  });

  it('throws on empty string', () => {
    expect(() => parseStrictInt('', 'PORT')).toThrow(/invalid integer/);
  });

  it('throws on whitespace-only string', () => {
    expect(() => parseStrictInt('   ', 'PORT')).toThrow(/invalid integer/);
  });

  it('throws on non-numeric content', () => {
    expect(() => parseStrictInt('abc', 'PORT')).toThrow(/invalid integer/);
  });

  it('rejects decimals', () => {
    expect(() => parseStrictInt('1.5', 'PORT')).toThrow(/invalid integer/);
  });

  it('rejects exponent notation', () => {
    expect(() => parseStrictInt('1e3', 'PORT')).toThrow(/invalid integer/);
  });

  it('rejects hex (base 10 only)', () => {
    expect(() => parseStrictInt('0x10', 'PORT')).toThrow(/invalid integer/);
  });

  it('includes the source label in the error message', () => {
    expect(() => parseStrictInt('', 'PORT')).toThrow(/PORT/);
  });

  it('accepts PEP 515 underscore separators', () => {
    expect(parseStrictInt('1_000', 'PORT')).toBe(1000);
    expect(parseStrictInt('1_000_000', 'PORT')).toBe(1_000_000);
    expect(parseStrictInt('+1_000', 'PORT')).toBe(1000);
    expect(parseStrictInt('-1_000', 'PORT')).toBe(-1000);
  });

  it('rejects leading/trailing/doubled underscores', () => {
    expect(() => parseStrictInt('_100', 'PORT')).toThrow(/invalid integer/);
    expect(() => parseStrictInt('100_', 'PORT')).toThrow(/invalid integer/);
    expect(() => parseStrictInt('1__0', 'PORT')).toThrow(/invalid integer/);
    expect(() => parseStrictInt('+_1', 'PORT')).toThrow(/invalid integer/);
  });

  it('accepts Unicode decimal digits (Nd, e.g. Arabic-Indic U+0660)', () => {
    expect(parseStrictInt('٠٠٧', 'PORT')).toBe(7);
    expect(parseStrictInt('١٢٣', 'PORT')).toBe(123);
    expect(parseStrictInt('१२३', 'PORT')).toBe(123);
    expect(parseStrictInt('١2३', 'PORT')).toBe(123);
  });
});

describe('applyEnvDefaults', () => {
  it('sets keys absent from env (setdefault semantics)', () => {
    const env: NodeJS.ProcessEnv = {};
    applyEnvDefaults(env, { FOO: 'bar' });
    expect(env.FOO).toBe('bar');
  });

  it('does not overwrite an existing value', () => {
    const env: NodeJS.ProcessEnv = { FOO: 'keep' };
    applyEnvDefaults(env, { FOO: 'overwrite' });
    expect(env.FOO).toBe('keep');
  });

  it('treats empty string as present (does not overwrite)', () => {
    const env: NodeJS.ProcessEnv = { FOO: '' };
    applyEnvDefaults(env, { FOO: 'overwrite' });
    expect(env.FOO).toBe('');
  });

  it('applies multiple defaults independently', () => {
    const env: NodeJS.ProcessEnv = { A: '1' };
    applyEnvDefaults(env, { A: 'x', B: '2', C: '3' });
    expect(env).toEqual({ A: '1', B: '2', C: '3' });
  });
});

describe('DEV_DEFAULTS', () => {
  it('contains the expected defaults', () => {
    expect(DEV_DEFAULTS).toEqual({
      ENVIRONMENT: 'dev',
      LOG_LEVEL: 'debug',
      ANALYTICS_ENABLED: 'false',
      BRIDGE_SYNC_ENABLED: 'false',
      TFTP_ENABLED: 'false',
      REDIS_URL: 'redis://localhost:6379/0',
      BROKKR_ZONE_ID: '',
      PERSISTENT_STORAGE_PATH: '/tmp/brokkr-dev',
    });
  });

  it('is frozen', () => {
    expect(Object.isFrozen(DEV_DEFAULTS)).toBe(true);
  });
});

describe('loadEnvDevFile', () => {
  it('is a no-op when the file does not exist', () => {
    const env: NodeJS.ProcessEnv = { EXISTING: 'keep' };
    const fakeRead = (() => {
      throw new Error('should not read');
    }) as unknown as typeof import('node:fs').readFileSync;
    loadEnvDevFile('/no/such/path.env', env, {
      existsSync: () => false,
      readFileSync: fakeRead,
    });
    expect(env).toEqual({ EXISTING: 'keep' });
  });

  it('reads the file and applies setdefault semantics', () => {
    const env: NodeJS.ProcessEnv = { OVERRIDDEN: 'shell-wins' };
    const fakeRead = (() => 'OVERRIDDEN=loser\nNEW_KEY=fromfile') as unknown as typeof import('node:fs').readFileSync;
    loadEnvDevFile('/fake/.env.dev', env, {
      existsSync: () => true,
      readFileSync: fakeRead,
    });
    expect(env.OVERRIDDEN).toBe('shell-wins');
    expect(env.NEW_KEY).toBe('fromfile');
  });
});

describe('defaultEnvDevPath', () => {
  it('resolves to an absolute path', () => {
    const p = defaultEnvDevPath();
    expect(typeof p).toBe('string');
    expect(p.startsWith('/')).toBe(true);
    expect(p.endsWith('.env.dev')).toBe(true);
  });

  it('targets the repo root, not apps/bridge/ or apps/bridge/dist/', () => {
    const p = defaultEnvDevPath();
    expect(p).not.toMatch(/\/apps\/bridge\/\.env\.dev$/);
    expect(p).not.toMatch(/\/apps\/bridge\/dist\/.+\.env\.dev$/);
    expect(p.split('/').slice(-4).join('/')).toMatch(/^.+\.env\.dev$/);
  });
});

describe('ensureStorageDir', () => {
  it('forwards to mkdirSync with recursive: true', () => {
    const calls: Array<{ path: string; opts: unknown }> = [];
    const fakeMkdir = ((p: string, opts: unknown) => {
      calls.push({ path: p, opts });
      return undefined;
    }) as unknown as typeof import('node:fs').mkdirSync;
    ensureStorageDir('/tmp/brokkr-dev', fakeMkdir);
    expect(calls).toEqual([{ path: '/tmp/brokkr-dev', opts: { recursive: true } }]);
  });
});

function makeApp(): { factory: DevAppFactory; listens: Array<{ host: string; port: number }>; closeCalls: number } {
  const listens: Array<{ host: string; port: number }> = [];
  let closeCalls = 0;
  const factory: DevAppFactory = {
    async create(): Promise<DevAppHandle> {
      return {
        async listen(host, port) {
          listens.push({ host, port });
        },
        async close() {
          closeCalls += 1;
        },
      };
    },
  };
  return {
    factory,
    listens,
    get closeCalls() {
      return closeCalls;
    },
  } as ReturnType<typeof makeApp>;
}

function makeSupervisor(): {
  factory: DevSupervisorFactory;
  shutdownRequests: number;
  waitCalls: number;
} {
  let shutdownRequests = 0;
  let waitCalls = 0;
  let resolveWait: (() => void) | null = null;
  const waitPromise = new Promise<void>((r) => {
    resolveWait = r;
  });
  const handle: DevSupervisorHandle = {
    requestShutdown() {
      shutdownRequests += 1;
      if (resolveWait !== null) {
        resolveWait();
        resolveWait = null;
      }
    },
    async waitForShutdown() {
      waitCalls += 1;
      await waitPromise;
    },
  };
  const factory: DevSupervisorFactory = {
    start() {
      return handle;
    },
  };
  return {
    factory,
    get shutdownRequests() {
      return shutdownRequests;
    },
    get waitCalls() {
      return waitCalls;
    },
  } as ReturnType<typeof makeSupervisor>;
}

describe('runDev', () => {
  it('builds the app, starts the supervisor, listens, and tears down on signal', async () => {
    const { logger, entries } = makeLogger();
    const app = makeApp();
    const sup = makeSupervisor();
    const installSignalHandlers = (handler: (signal: 'SIGTERM' | 'SIGINT') => void): (() => void) => {
      queueMicrotask(() => handler('SIGTERM'));
      return () => undefined;
    };

    await runDev({
      appFactory: app.factory,
      supervisorFactory: sup.factory,
      hostPort: { host: '127.0.0.1', port: 3030 },
      logger,
      installSignalHandlers,
    });

    expect(app.listens).toEqual([{ host: '127.0.0.1', port: 3030 }]);
    expect(sup.shutdownRequests).toBe(1);
    expect(app.closeCalls).toBe(1);
    expect(sup.waitCalls).toBe(1);
    expect(entries.map((e) => e.message)).toContain('Bridge API ready — http://localhost:3030');
  });

  it('SIGINT also drives shutdown', async () => {
    const { logger } = makeLogger();
    const app = makeApp();
    const sup = makeSupervisor();
    const installSignalHandlers = (handler: (signal: 'SIGTERM' | 'SIGINT') => void): (() => void) => {
      queueMicrotask(() => handler('SIGINT'));
      return () => undefined;
    };

    await runDev({
      appFactory: app.factory,
      supervisorFactory: sup.factory,
      hostPort: { host: '0.0.0.0', port: 3002 },
      logger,
      installSignalHandlers,
    });

    expect(sup.shutdownRequests).toBe(1);
  });

  it('uninstalls signal handlers in the finally block', async () => {
    const { logger } = makeLogger();
    const app = makeApp();
    const sup = makeSupervisor();
    const uninstall = vi.fn();
    const installSignalHandlers = (handler: (signal: 'SIGTERM' | 'SIGINT') => void): (() => void) => {
      queueMicrotask(() => handler('SIGTERM'));
      return uninstall;
    };

    await runDev({
      appFactory: app.factory,
      supervisorFactory: sup.factory,
      hostPort: { host: 'h', port: 1 },
      logger,
      installSignalHandlers,
    });

    expect(uninstall).toHaveBeenCalledTimes(1);
  });

  it('logs and re-throws when listen fails, still closing app and joining supervisor', async () => {
    const { logger, entries } = makeLogger();
    const sup = makeSupervisor();
    const boom = new Error('listen failed');
    let closeCalls = 0;
    const appFactory: DevAppFactory = {
      async create() {
        return {
          async listen() {
            throw boom;
          },
          async close() {
            closeCalls += 1;
          },
        };
      },
    };

    const installSignalHandlers = (handler: (signal: 'SIGTERM' | 'SIGINT') => void): (() => void) => {
      queueMicrotask(() => handler('SIGTERM'));
      return () => undefined;
    };

    await expect(
      runDev({
        appFactory,
        supervisorFactory: sup.factory,
        hostPort: { host: 'h', port: 1 },
        logger,
        installSignalHandlers,
      }),
    ).rejects.toBe(boom);

    expect(closeCalls).toBe(1);
    expect(entries.some((e) => e.level === 'error' && e.message.includes('listen failed'))).toBe(true);
  });
});
