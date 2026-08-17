import { Test } from '@nestjs/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import { LoggerModule } from '../logger.module';
import { Logger, createLoggerProviders, loggerTokenFor, registeredLoggerNames } from '../logger.provider';
import { ContextLogger, type LogContext, type LoggerLike } from '../logger.service';

class StubLogger {
  calls: Array<{ level: string; message: string; context?: LogContext }> = [];

  debug = async (message: string, context?: LogContext) => {
    this.calls.push({ level: 'debug', message, context });
  };
  info = async (message: string, context?: LogContext) => {
    this.calls.push({ level: 'info', message, context });
  };
  warning = async (message: string, context?: LogContext) => {
    this.calls.push({ level: 'warning', message, context });
  };
  error = async (message: string, context?: LogContext) => {
    this.calls.push({ level: 'error', message, context });
  };
}

describe('loggerTokenFor', () => {
  it('namespaces by class name to keep tokens unique', () => {
    expect(loggerTokenFor('AdminService')).toBe('BridgeLogger:AdminService');
    expect(loggerTokenFor('')).toBe('BridgeLogger:');
  });
});

describe('@Logger registration side effect', () => {
  beforeEach(() => {
    registeredLoggerNames.length = 0;
  });

  it('records each unique name exactly once', () => {
    class A {
      constructor(@Logger('Foo') readonly l: LoggerLike) {}
    }
    class B {
      constructor(@Logger('Bar') readonly l: LoggerLike) {}
    }
    class C {
      constructor(@Logger('Foo') readonly l: LoggerLike) {}
    }
    void A;
    void B;
    void C;
    expect(registeredLoggerNames).toEqual(['Foo', 'Bar']);
  });
});

describe('createLoggerProviders', () => {
  beforeEach(() => {
    registeredLoggerNames.length = 0;
  });

  it('emits one provider per registered name with ContextLogger in the inject list', () => {
    class A {
      constructor(@Logger('Foo') readonly l: LoggerLike) {}
    }
    void A;
    const providers = createLoggerProviders();
    expect(providers).toHaveLength(1);
    const provider = providers[0];
    if (
      typeof provider !== 'object' ||
      provider === null ||
      !('provide' in provider) ||
      !('useFactory' in provider) ||
      !('inject' in provider)
    ) {
      throw new Error('expected a factory provider');
    }
    expect(provider.provide).toBe('BridgeLogger:Foo');
    expect(provider.inject).toEqual([ContextLogger]);
  });
});

describe('PrefixedLogger via Nest DI', () => {
  beforeEach(() => {
    registeredLoggerNames.length = 0;
  });

  it('pre-binds appClassName on every level method', async () => {
    class SvcA {
      constructor(@Logger('SvcA') readonly l: LoggerLike) {}
    }

    const stub = new StubLogger();
    const moduleRef = await Test.createTestingModule({
      imports: [LoggerModule.forRoot()],
      providers: [SvcA],
    })
      .overrideProvider(ContextLogger)
      .useValue(stub)
      .compile();

    const svc = moduleRef.get(SvcA);
    await svc.l.info('hello');
    await svc.l.warning('warn');
    await svc.l.error('err');
    await svc.l.debug('dbg');

    expect(stub.calls).toEqual([
      { level: 'info', message: 'hello', context: { appClassName: 'SvcA' } },
      { level: 'warning', message: 'warn', context: { appClassName: 'SvcA' } },
      { level: 'error', message: 'err', context: { appClassName: 'SvcA' } },
      { level: 'debug', message: 'dbg', context: { appClassName: 'SvcA' } },
    ]);
  });

  it('preserves caller-supplied appClassName when set, otherwise injects the bound prefix', async () => {
    class SvcB {
      constructor(@Logger('SvcB') readonly l: LoggerLike) {}
    }

    const stub = new StubLogger();
    const moduleRef = await Test.createTestingModule({
      imports: [LoggerModule.forRoot()],
      providers: [SvcB],
    })
      .overrideProvider(ContextLogger)
      .useValue(stub)
      .compile();

    const svc = moduleRef.get(SvcB);
    await svc.l.info('a', { jobId: 'j1' });
    await svc.l.info('b', { jobId: 'j2', appClassName: 'OverrideTag' });

    expect(stub.calls).toEqual([
      { level: 'info', message: 'a', context: { jobId: 'j1', appClassName: 'SvcB' } },
      { level: 'info', message: 'b', context: { jobId: 'j2', appClassName: 'OverrideTag' } },
    ]);
  });

  it('falls back to "unknown" when @Logger() is used with no name', async () => {
    class SvcC {
      constructor(@Logger() readonly l: LoggerLike) {}
    }

    const stub = new StubLogger();
    const moduleRef = await Test.createTestingModule({
      imports: [LoggerModule.forRoot()],
      providers: [SvcC],
    })
      .overrideProvider(ContextLogger)
      .useValue(stub)
      .compile();

    const svc = moduleRef.get(SvcC);
    await svc.l.info('msg');

    expect(stub.calls).toEqual([{ level: 'info', message: 'msg', context: { appClassName: 'unknown' } }]);
  });

  it('shares the underlying ContextLogger singleton across all decorated injectees', async () => {
    class SvcD {
      constructor(@Logger('SvcD') readonly l: LoggerLike) {}
    }
    class SvcE {
      constructor(@Logger('SvcE') readonly l: LoggerLike) {}
    }

    const stub = new StubLogger();
    const moduleRef = await Test.createTestingModule({
      imports: [LoggerModule.forRoot()],
      providers: [SvcD, SvcE],
    })
      .overrideProvider(ContextLogger)
      .useValue(stub)
      .compile();

    await moduleRef.get(SvcD).l.info('d');
    await moduleRef.get(SvcE).l.info('e');

    expect(stub.calls).toEqual([
      { level: 'info', message: 'd', context: { appClassName: 'SvcD' } },
      { level: 'info', message: 'e', context: { appClassName: 'SvcE' } },
    ]);
  });
});
