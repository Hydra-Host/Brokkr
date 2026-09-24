import { describe, expect, it } from 'vitest';
import {
  DeviceJobSchema,
  DeviceJobsResponseSchema,
  JobLogEntrySchema,
  JobLogsQuerySchema,
  JobLogsResponseSchema,
  JobSolLogEntrySchema,
  JobSolLogsQuerySchema,
  JobSolLogsResponseSchema,
} from '../job-logs';

describe('JobLogsQuerySchema.limit', () => {
  it('defaults to 500 when omitted', () => {
    expect(JobLogsQuerySchema.parse({}).limit).toBe(500);
  });

  it('coerces a numeric string, because query params arrive as strings', () => {
    expect(JobLogsQuerySchema.parse({ limit: '250' }).limit).toBe(250);
  });

  it.each([1, 1000])('accepts the bound %s', (limit) => {
    expect(JobLogsQuerySchema.parse({ limit }).limit).toBe(limit);
  });

  it.each([
    ['zero', '0'],
    ['negative', '-1'],
    ['non-integer', '1.5'],
    ['above the maximum', '1001'],
  ])('rejects %s', (_label, limit) => {
    expect(JobLogsQuerySchema.safeParse({ limit }).success).toBe(false);
  });
});

describe('JobLogsQuerySchema.cursor', () => {
  it('is optional', () => {
    expect(JobLogsQuerySchema.parse({}).cursor).toBeUndefined();
  });

  it('carries a stream ID through', () => {
    expect(JobLogsQuerySchema.parse({ cursor: '1700000000000-0' }).cursor).toBe('1700000000000-0');
  });
});

describe('JobLogEntrySchema', () => {
  const entry = {
    id: '1700000000000-0',
    timestamp: '2026-08-28T00:00:00.000Z',
    logLevel: 'info',
    message: 'saga step started',
    appName: 'bridge-api',
    appClassName: 'ProvisionSaga',
  };

  it('accepts a full entry', () => {
    expect(JobLogEntrySchema.parse(entry)).toEqual(entry);
  });
});

describe('JobLogsResponseSchema.nextCursor', () => {
  it('accepts null when the page was not full', () => {
    expect(JobLogsResponseSchema.parse({ entries: [], nextCursor: null }).nextCursor).toBeNull();
  });
});

describe('DeviceJobSchema.error', () => {
  const job = {
    id: 'plan-1',
    jobType: 'Provision',
    status: 'Failed',
    createdAt: '2026-08-28T00:00:00.000Z',
    error: 'timed out',
  };

  it('accepts a failure detail', () => {
    expect(DeviceJobSchema.parse(job).error).toBe('timed out');
  });

  it('accepts null for a non-failed job', () => {
    expect(DeviceJobSchema.parse({ ...job, status: 'Completed', error: null }).error).toBeNull();
  });
});

describe('DeviceJobsResponseSchema', () => {
  it('accepts an empty job list', () => {
    expect(DeviceJobsResponseSchema.parse({ jobs: [] }).jobs).toEqual([]);
  });
});

describe('JobSolLogsQuerySchema.cursor', () => {
  it('defaults to 0 when omitted', () => {
    expect(JobSolLogsQuerySchema.parse({}).cursor).toBe(0);
  });

  it('coerces a numeric string, because query params arrive as strings', () => {
    expect(JobSolLogsQuerySchema.parse({ cursor: '250' }).cursor).toBe(250);
  });

  it.each([
    ['negative', '-1'],
    ['non-integer', '1.5'],
  ])('rejects %s', (_label, cursor) => {
    expect(JobSolLogsQuerySchema.safeParse({ cursor }).success).toBe(false);
  });
});

describe('JobSolLogsQuerySchema.limit', () => {
  it('defaults to 500 when omitted', () => {
    expect(JobSolLogsQuerySchema.parse({}).limit).toBe(500);
  });

  it('rejects a limit above the maximum', () => {
    expect(JobSolLogsQuerySchema.safeParse({ limit: '1001' }).success).toBe(false);
  });
});

describe('JobSolLogEntrySchema', () => {
  const entry = {
    index: 0,
    timestamp: '2026-09-17T00:00:00.000',
    message: 'ubuntu login:',
  };

  it('accepts a full entry', () => {
    expect(JobSolLogEntrySchema.parse(entry)).toEqual(entry);
  });

  it('rejects a negative index', () => {
    expect(JobSolLogEntrySchema.safeParse({ ...entry, index: -1 }).success).toBe(false);
  });
});

describe('JobSolLogsResponseSchema', () => {
  it('accepts a full page with a numeric next cursor', () => {
    const page = {
      entries: [{ index: 0, timestamp: '2026-09-17T00:00:00.000', message: 'GRUB loading' }],
      nextCursor: 1,
      complete: false,
    };
    expect(JobSolLogsResponseSchema.parse(page)).toEqual(page);
  });

  it('accepts a completed capture with a null next cursor', () => {
    const page = { entries: [], nextCursor: null, complete: true };
    expect(JobSolLogsResponseSchema.parse(page)).toEqual(page);
  });
});
