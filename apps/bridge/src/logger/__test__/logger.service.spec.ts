import { AsyncLocalStorage } from 'node:async_hooks';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { JobIdPrefixFilter } from '../context/job-id-prefix-filter';
import { getJobId, runWithJobId } from '../context/job-id.context';
import { NIL_JOB_ID } from '../context/logging-context.constants';
import { parseSuppressJobIdPrefixes } from '../context/suppress-prefixes';
import {
  BridgeAsyncHandler,
  BridgeJsonFormatter,
  BridgeSyncHandler,
  ContextLogger,
  getLogger,
  getSuppressedJobIdPrefixes,
  resetLoggerForTests,
  type LogRecord,
} from '../logger.service';

function record(jobId: string, level: 'info' | 'debug' | 'warning' | 'error' = 'info'): LogRecord {
  return {
    level,
    message: 'msg',
    jobId,
    appClassName: 'bridge-api.test',
    appName: 'bridge-api',
  };
}

describe('getSuppressedJobIdPrefixes (env-driven)', () => {
  const originalRaw = process.env.LOG_SUPPRESS_JOB_ID_PREFIXES;

  afterEach(() => {
    if (originalRaw === undefined) {
      delete process.env.LOG_SUPPRESS_JOB_ID_PREFIXES;
    } else {
      process.env.LOG_SUPPRESS_JOB_ID_PREFIXES = originalRaw;
    }
  });

  it('defaults to health-cron- and heartbeat- when unset', () => {
    delete process.env.LOG_SUPPRESS_JOB_ID_PREFIXES;
    expect(getSuppressedJobIdPrefixes()).toEqual(['health-cron-', 'heartbeat-']);
  });

  it('parses comma-separated values with whitespace trimming', () => {
    expect(parseSuppressJobIdPrefixes('foo-, bar-,baz-')).toEqual(['foo-', 'bar-', 'baz-']);
  });

  it('returns empty when env is empty string', () => {
    expect(parseSuppressJobIdPrefixes('')).toEqual([]);
  });

  it('drops whitespace-only entries', () => {
    expect(parseSuppressJobIdPrefixes('foo-, , ,bar-')).toEqual(['foo-', 'bar-']);
  });
});

describe('JobIdPrefixFilter', () => {
  it('drops records matching a single prefix', () => {
    const f = new JobIdPrefixFilter(['health-cron-']);
    expect(f.accept({ jobId: 'health-cron-1234567890' })).toBe(false);
  });

  it('drops records matching any of multiple prefixes', () => {
    const f = new JobIdPrefixFilter(['health-cron-', 'heartbeat-']);
    expect(f.accept({ jobId: 'heartbeat-abc' })).toBe(false);
  });

  it('passes non-matching records', () => {
    const f = new JobIdPrefixFilter(['health-cron-']);
    expect(f.accept({ jobId: 'deploy-saga-abc' })).toBe(true);
  });

  it('passes empty job_id', () => {
    const f = new JobIdPrefixFilter(['health-cron-']);
    expect(f.accept({ jobId: '' })).toBe(true);
  });

  it('passes when job_id is null/undefined and context is empty', () => {
    const f = new JobIdPrefixFilter(['health-cron-']);
    expect(f.accept({})).toBe(true);
  });

  it('falls back to AsyncLocalStorage context job-id', () => {
    const f = new JobIdPrefixFilter(['health-cron-']);
    runWithJobId('health-cron-fallback', () => {
      expect(f.accept({})).toBe(false);
    });
  });

  it('passes everything when prefix list is empty', () => {
    const f = new JobIdPrefixFilter([]);
    expect(f.accept({ jobId: 'health-cron-1234' })).toBe(true);
    expect(f.accept({ jobId: 'anything' })).toBe(true);
  });

  it('matches strict startsWith, not substring', () => {
    const f = new JobIdPrefixFilter(['health-cron-']);
    expect(f.accept({ jobId: 'ok-health-cron-1' })).toBe(true);
  });
});

describe('handler filter integration', () => {
  it('async handler runs the filter and skips suppressed records', async () => {
    const writes: string[] = [];
    const handler = new BridgeAsyncHandler({ write: (s: string) => writes.push(s) }, new BridgeJsonFormatter());
    handler.setFilter(new JobIdPrefixFilter(['health-cron-']));

    await handler.emitAsync(record('health-cron-xyz'));
    expect(writes.length).toBe(0);

    await handler.emitAsync(record('deploy-saga-1'));
    expect(writes.length).toBe(1);
  });

  it('sync handler runs the filter and skips suppressed records', () => {
    const writes: string[] = [];
    const handler = new BridgeSyncHandler({ write: (s: string) => writes.push(s) }, new BridgeJsonFormatter());
    handler.setFilter(new JobIdPrefixFilter(['health-cron-']));

    handler.emit(record('health-cron-xyz'));
    expect(writes.length).toBe(0);

    handler.emit(record('deploy-saga-1'));
    expect(writes.length).toBe(1);
  });
});

describe('ContextLogger NIL_JOB_ID propagation', () => {
  beforeEach(() => {
    resetLoggerForTests();
  });

  afterEach(() => {
    resetLoggerForTests();
  });

  it('does not propagate NIL_JOB_ID into the context', async () => {
    const storage = new AsyncLocalStorage<{ jobId: string }>();
    await storage.run({ jobId: '' }, async () => {
      const logger = getLogger();
      await logger.log('info', 'app-level startup line', { jobId: NIL_JOB_ID, appClassName: 'startup' });
      expect(getJobId()).toBe('');
    });
  });

  it('propagates real job ids into the context for child operations', async () => {
    await runWithJobId('', async () => {
      const logger = getLogger();
      await logger.log('info', 'real job line', { jobId: 'deploy-saga-1', appClassName: 'service-x' });
      expect(getJobId()).toBe('deploy-saga-1');
    });
  });
});

describe('BridgeJsonFormatter output shape', () => {
  it('emits ordered JSON keys with default separators', () => {
    const f = new BridgeJsonFormatter();
    const fixed = new Date('2026-06-11T12:00:00.000Z');
    vi.useFakeTimers();
    try {
      vi.setSystemTime(fixed);
      const out = f.format({
        level: 'info',
        message: 'hello',
        jobId: 'job-1',
        appClassName: 'service-x',
        appName: 'bridge-api',
      });
      expect(out).toBe(
        '{"app_name": "bridge-api", "app_class_name": "service-x", "job_id": "job-1", "log_level": "info", "message": "hello", "timestamp": "2026-06-11T12:00:00+00:00"}',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('emits microsecond-padded fraction when millisecond component is non-zero', () => {
    const f = new BridgeJsonFormatter();
    const fixed = new Date('2026-06-11T12:00:00.500Z');
    vi.useFakeTimers();
    try {
      vi.setSystemTime(fixed);
      const out = f.format({
        level: 'info',
        message: 'hi',
        jobId: '',
        appClassName: 'svc',
        appName: 'bridge-api',
      });
      const obj = JSON.parse(out);
      expect(obj.timestamp).toBe('2026-06-11T12:00:00.500000+00:00');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('handler deduplication', () => {
  it('suppresses identical records within 100ms', async () => {
    const writes: string[] = [];
    const handler = new BridgeAsyncHandler({ write: (s: string) => writes.push(s) }, new BridgeJsonFormatter());

    await handler.emitAsync(record('job-1'));
    await handler.emitAsync(record('job-1'));
    expect(writes.length).toBe(1);
  });

  it('does not suppress records that differ only by appName within 100ms', async () => {
    const writes: string[] = [];
    const handler = new BridgeAsyncHandler({ write: (s: string) => writes.push(s) }, new BridgeJsonFormatter());

    await handler.emitAsync({ ...record('job-1'), appName: 'bridge-api' });
    await handler.emitAsync({ ...record('job-1'), appName: 'bridge-agent' });
    expect(writes.length).toBe(2);
  });

  it('sync handler does not suppress records that differ only by appName within 100ms', () => {
    const writes: string[] = [];
    const handler = new BridgeSyncHandler({ write: (s: string) => writes.push(s) }, new BridgeJsonFormatter());

    handler.emit({ ...record('job-1'), appName: 'bridge-api' });
    handler.emit({ ...record('job-1'), appName: 'bridge-agent' });
    expect(writes.length).toBe(2);
  });
});

describe('ContextLogger monitoring gate', () => {
  beforeEach(() => {
    resetLoggerForTests();
  });

  afterEach(() => {
    resetLoggerForTests();
  });

  it('skips emission when the monitoring gate says so', async () => {
    const writes: string[] = [];
    const fakeStdout = { write: (s: string) => writes.push(s) } as unknown as NodeJS.WriteStream;
    const originalWrite = process.stdout.write.bind(process.stdout);
    (process.stdout as any).write = fakeStdout.write;
    try {
      const logger = new ContextLogger({ shouldSkip: () => true });
      await logger.info('should-not-appear', { appClassName: 'monitoring' });
      expect(writes.length).toBe(0);
    } finally {
      (process.stdout as any).write = originalWrite;
    }
  });
});
