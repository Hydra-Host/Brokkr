import { type Redis } from 'ioredis';
import { type LoggerService } from 'src/logger/logger.service';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setJobLogSink, type JobLogSinkPort } from '../../../../bridge/src/logger/job-log-sink-registry';
import { ContextLogger, resetLoggerForTests } from '../../../../bridge/src/logger/logger.service';
import { JobLogWriterService } from '../../brokkr-bridge/job-logs/job-log-writer.service';
import { jobLogStreamEntrySchema } from '../job-logs.service';

const PLAN_JOB_ID = '0b0e8f7a-1c2d-4e5f-8a9b-0c1d2e3f4a5b';

const SCHEMA_FIELD_NAMES = Object.keys(jobLogStreamEntrySchema.shape).sort();

class RecordingSink implements JobLogSinkPort {
  readonly entries: Array<{ jobId: string; fields: Record<string, string> }> = [];

  enqueue(jobId: string, fields: Record<string, string>): void {
    this.entries.push({ jobId, fields });
  }
}

function pairsToRecord(pairs: string[]): Record<string, string> {
  const record: Record<string, string> = {};
  for (let i = 0; i + 1 < pairs.length; i += 2) {
    record[pairs[i]] = pairs[i + 1];
  }
  return record;
}

describe('job log stream field agreement (bridge sink + hub writer + hub reader)', () => {
  afterEach(() => {
    setJobLogSink(null);
    resetLoggerForTests();
  });

  it('bridge sink records carry exactly the hub reader schema fields and parse through it', async () => {
    const sink = new RecordingSink();
    setJobLogSink(sink);
    const logger = new ContextLogger(null, { LOG_LEVEL: 'info' });

    await logger.info('saga step started', { jobId: PLAN_JOB_ID, appClassName: 'ProvisionSaga' });

    expect(sink.entries).toHaveLength(1);
    const fields = sink.entries[0].fields;
    expect(Object.keys(fields).sort()).toEqual(SCHEMA_FIELD_NAMES);
    expect(jobLogStreamEntrySchema.parse(fields)).toEqual({
      timestamp: fields.timestamp,
      log_level: 'info',
      message: 'saga step started',
      app_name: 'bridge-api',
      app_class_name: 'ProvisionSaga',
    });
  });

  it('hub writer entries carry exactly the hub reader schema fields and parse through it', async () => {
    const xadd = vi.fn().mockResolvedValue('1-1');
    const redis = { xadd, expire: vi.fn().mockResolvedValue(1) } as unknown as Redis;
    const writer = new JobLogWriterService(redis, { warn: vi.fn() } as unknown as LoggerService);

    await writer.write('zone-1', PLAN_JOB_ID, 'error', 'saga step failed', 'BridgeResultsConsumer');

    expect(xadd).toHaveBeenCalledTimes(1);
    const args: string[] = xadd.mock.calls[0];
    const fields = pairsToRecord(args.slice(args.indexOf('*') + 1));
    expect(Object.keys(fields).sort()).toEqual(SCHEMA_FIELD_NAMES);
    expect(jobLogStreamEntrySchema.parse(fields)).toEqual({
      timestamp: fields.timestamp,
      log_level: 'error',
      message: 'saga step failed',
      app_name: 'brokkr-hub',
      app_class_name: 'BridgeResultsConsumer',
    });
  });
});
