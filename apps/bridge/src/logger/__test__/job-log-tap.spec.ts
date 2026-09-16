import { afterEach, describe, expect, it } from 'vitest';

import { runWithJobId } from '../context/job-id.context';
import { NIL_JOB_ID } from '../context/logging-context.constants';
import { setJobLogSink, type JobLogSinkPort } from '../job-log-sink-registry';
import { ContextLogger, resetLoggerForTests } from '../logger.service';

class RecordingSink implements JobLogSinkPort {
  readonly entries: Array<{ jobId: string; fields: Record<string, string> }> = [];

  enqueue(jobId: string, fields: Record<string, string>): void {
    this.entries.push({ jobId, fields });
  }
}

const PLAN_JOB_ID = '0b0e8f7a-1c2d-4e5f-8a9b-0c1d2e3f4a5b';

function buildLogger(): ContextLogger {
  return new ContextLogger(null, { LOG_LEVEL: 'info' });
}

describe('job log tap', () => {
  afterEach(() => {
    setJobLogSink(null);
    resetLoggerForTests();
  });

  it('enqueues a record at the configured level when a job id is set', async () => {
    const sink = new RecordingSink();
    setJobLogSink(sink);
    const logger = buildLogger();

    await logger.info('x', { jobId: PLAN_JOB_ID, appClassName: 'Foo' });

    expect(sink.entries).toHaveLength(1);
    expect(sink.entries[0].jobId).toBe(PLAN_JOB_ID);
    expect(sink.entries[0].fields).toMatchObject({
      log_level: 'info',
      message: 'x',
      app_name: 'bridge-api',
      app_class_name: 'Foo',
    });
    expect(sink.entries[0].fields.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('enqueues debug records even when the console level suppresses them', async () => {
    const sink = new RecordingSink();
    setJobLogSink(sink);
    const logger = buildLogger();

    await logger.debug('x', { jobId: PLAN_JOB_ID, appClassName: 'Foo' });

    expect(sink.entries).toHaveLength(1);
    expect(sink.entries[0].fields.log_level).toBe('debug');
  });

  it('enqueues nothing for job ids that are not plan-shaped', async () => {
    const sink = new RecordingSink();
    setJobLogSink(sink);
    const logger = buildLogger();

    await logger.info('x', { jobId: 'cron-leader_heartbeat', appClassName: 'Foo' });
    await logger.info('x', { jobId: 'j1', appClassName: 'Foo' });

    expect(sink.entries).toHaveLength(0);
  });

  it('enqueues nothing without a job id', async () => {
    const sink = new RecordingSink();
    setJobLogSink(sink);
    const logger = buildLogger();

    await runWithJobId('', () => logger.debug('x', { appClassName: 'Foo' }));

    expect(sink.entries).toHaveLength(0);
  });

  it('enqueues nothing for the nil job id', async () => {
    const sink = new RecordingSink();
    setJobLogSink(sink);
    const logger = buildLogger();

    await logger.debug('x', { jobId: NIL_JOB_ID, appClassName: 'Foo' });

    expect(sink.entries).toHaveLength(0);
  });

  it('enqueues nothing for suppressed job id prefixes', async () => {
    const sink = new RecordingSink();
    setJobLogSink(sink);
    const logger = buildLogger();

    await logger.info('x', { jobId: 'health-cron-abc', appClassName: 'Foo' });
    await logger.info('x', { jobId: 'heartbeat-abc', appClassName: 'Foo' });

    expect(sink.entries).toHaveLength(0);
  });

  it('enqueues nothing for a plan-shaped job id matching a configured suppress prefix', async () => {
    const sink = new RecordingSink();
    setJobLogSink(sink);
    const logger = new ContextLogger(null, {
      LOG_LEVEL: 'info',
      LOG_SUPPRESS_JOB_ID_PREFIXES: PLAN_JOB_ID.slice(0, 8),
    });

    await logger.info('x', { jobId: PLAN_JOB_ID, appClassName: 'Foo' });

    expect(sink.entries).toHaveLength(0);
  });
});
