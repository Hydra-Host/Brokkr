import { beforeEach, describe, expect, it, vi } from 'vitest';

import { EVENT_READ_CAP } from '../hub-sql';
import { LifecycleJobsReaderService } from '../lifecycle-jobs.reader';

const NOW = new Date('2026-01-02T03:04:05.000Z');

const jobRow = (over: Record<string, unknown> = {}) => ({
  id: 'plan-1',
  jobType: 'Provision',
  phase: 'AWAITING_PHONE_HOME',
  deviceId: 'dev-1',
  deploymentId: null,
  source: 'API',
  performedBy: null,
  error: null,
  scheduledAt: null,
  phoneHomeDeadline: NOW,
  linkedJobId: null,
  createdAt: NOW,
  updatedAt: NOW,
  ...over,
});

const eventRow = (over: Record<string, unknown> = {}) => ({
  id: 'evt-1',
  sagaName: 'provision',
  stepName: 'wipe',
  eventType: 'step',
  status: 'complete',
  attempt: 0,
  error: null,
  occurredAt: NOW,
  recordedAt: NOW,
  ...over,
});

let jobRows: Record<string, unknown>[];
let eventRows: Record<string, unknown>[];
let censusRows: { phase: string; count: number }[];
let censusError: Error | null;
let jobError: Error | null;
let eventError: Error | null;

function makePg() {
  return {
    readTyped: vi.fn(
      (
        sql: string,
        _params: unknown[],
        schema: { safeParse: (v: unknown) => { success: boolean; data?: unknown } },
      ) => {
        const kind = sql.includes('count(*)')
          ? 'census'
          : sql.includes('FROM "LifecycleJobEvent" WHERE')
            ? 'events'
            : 'jobs';
        if (kind === 'events' && eventError) return Promise.reject(eventError);
        if (kind === 'jobs' && jobError) return Promise.reject(jobError);
        if (kind === 'census') {
          return censusError ? Promise.reject(censusError) : Promise.resolve({ rows: censusRows, skipped: 0 });
        }
        const raws = kind === 'events' ? eventRows : jobRows;
        const rows: unknown[] = [];
        let skipped = 0;
        for (const raw of raws) {
          const parsed = schema.safeParse(raw);
          if (parsed.success) rows.push(parsed.data);
          else skipped += 1;
        }
        return Promise.resolve({ rows, skipped });
      },
    ),
  };
}

let pg: ReturnType<typeof makePg>;
const makeReader = () => new LifecycleJobsReaderService(pg as never);

beforeEach(() => {
  jobRows = [jobRow()];
  eventRows = [eventRow()];
  censusRows = [{ phase: 'AWAITING_PHONE_HOME', count: 1 }];
  censusError = null;
  jobError = null;
  eventError = null;
  pg = makePg();
});

describe('LifecycleJobsReaderService.list', () => {
  it('reports jobs with their engine phase intact', async () => {
    const page = await makeReader().list({ phases: [], deviceId: null, limit: 50, offset: 0 });

    expect(page.rows[0]).toMatchObject({ id: 'plan-1', phase: 'AWAITING_PHONE_HOME' });
    expect(page.rows[0].phoneHomeDeadlineMs).toBe(NOW.getTime());
  });

  it('reports an empty list as unknown rather than none when the read fails', async () => {
    jobError = new Error('pg down');

    const page = await makeReader().list({ phases: [], deviceId: null, limit: 50, offset: 0 });

    expect(page.rows).toEqual([]);
    expect(page.readError).toContain('pg down');
  });

  it('binds the phase filter rather than receiving it pre-interpolated', async () => {
    await makeReader().list({ phases: ['FAILED'], deviceId: 'dev-9', limit: 10, offset: 20 });

    const listCall = pg.readTyped.mock.calls.find(([sql]) => sql.includes('LEFT JOIN LATERAL'));
    expect(listCall?.[1]).toEqual([['FAILED'], 'dev-9', 10, 20]);
    expect(listCall?.[0]).not.toContain('FAILED');
  });
});

describe('LifecycleJobsReaderService.get', () => {
  it('redacts the os password hash the stored request carries for replay', async () => {
    jobRows = [{ ...jobRow(), payload: { request: { passwordHash: 'super-secret-hash', hostname: 'cpu-1' } } }];

    const detail = await makeReader().get('plan-1');

    expect(JSON.stringify(detail.payload)).not.toContain('super-secret-hash');
    expect(JSON.stringify(detail.payload)).toContain('cpu-1');
  });

  it('returns a null job rather than throwing when the id matches nothing', async () => {
    jobRows = [];

    const detail = await makeReader().get('missing');

    expect(detail.job).toBeNull();
    expect(detail.events).toEqual([]);
    expect(detail.eventsReadError).toBeNull();
  });

  it('presents the timeline oldest first, from a read the statement orders newest first', async () => {
    jobRows = [{ ...jobRow(), payload: {} }];
    eventRows = [eventRow({ id: 'evt-newest', stepName: 'install' }), eventRow({ id: 'evt-oldest' })];

    const detail = await makeReader().get('plan-1');

    expect(detail.events.map((event) => event.id)).toEqual(['evt-oldest', 'evt-newest']);
    expect(detail.eventsTruncated).toBe(false);
  });

  it('keeps the newest end of an over-cap timeline and says the oldest end is missing', async () => {
    jobRows = [{ ...jobRow(), payload: {} }];
    eventRows = Array.from({ length: EVENT_READ_CAP + 40 }, (_, index) => eventRow({ id: `evt-${index}` }));

    const detail = await makeReader().get('plan-1');

    expect(detail.events).toHaveLength(EVENT_READ_CAP);
    expect(detail.eventsTruncated).toBe(true);
    expect(detail.events.at(-1)?.id).toBe('evt-0');
    expect(detail.events.map((event) => event.id)).not.toContain(`evt-${EVENT_READ_CAP + 39}`);
  });

  it('asks for one row past the cap, so a job with exactly the cap is not reported as cut', async () => {
    jobRows = [{ ...jobRow(), payload: {} }];
    eventRows = Array.from({ length: EVENT_READ_CAP }, (_, index) => eventRow({ id: `evt-${index}` }));

    const detail = await makeReader().get('plan-1');

    const eventCall = pg.readTyped.mock.calls.find(([sql]) => sql.includes('FROM "LifecycleJobEvent" WHERE'));
    expect(eventCall?.[1]).toEqual(['plan-1', EVENT_READ_CAP + 1]);
    expect(detail.eventsTruncated).toBe(false);
    expect(detail.events).toHaveLength(EVENT_READ_CAP);
  });

  it('keeps the job when only its timeline could not be read', async () => {
    jobRows = [{ ...jobRow(), payload: {} }];
    eventError = new Error('timeline down');

    const detail = await makeReader().get('plan-1');

    expect(detail.job?.id).toBe('plan-1');
    expect(detail.events).toEqual([]);
    expect(detail.eventsReadError).toContain('timeline down');
  });
});

describe('LifecycleJobsReaderService latest step', () => {
  it('reports the newest event on the row, so a phase is not the only thing it says', async () => {
    jobRows = [
      jobRow({
        stepId: 'evt-9',
        sagaName: 'provision',
        stepName: 'install',
        eventType: 'step',
        stepStatus: 'running',
        attempt: 1,
        stepError: null,
        occurredAt: NOW,
        recordedAt: NOW,
      }),
    ];

    const page = await makeReader().list({ phases: [], deviceId: null, limit: 50, offset: 0 });

    expect(page.rows[0].latestStep).toMatchObject({ sagaName: 'provision', stepName: 'install', attempt: 1 });
  });

  it('reports a job with no events as null rather than inventing a step', async () => {
    const page = await makeReader().list({ phases: [], deviceId: null, limit: 50, offset: 0 });

    expect(page.rows[0].latestStep).toBeNull();
  });

  it.each([
    ['stepName', { stepId: 'evt-9', sagaName: 'provision', stepName: null }],
    ['eventType', { stepId: 'evt-9', sagaName: 'provision', stepName: 'wipe', eventType: null }],
    ['stepStatus', { stepId: 'evt-9', sagaName: 'provision', stepName: 'wipe', eventType: 'step', stepStatus: null }],
    [
      'recordedAt',
      { stepId: 'evt-9', sagaName: 'provision', stepName: 'wipe', eventType: 'step', stepStatus: 'ok', recordedAt: null },
    ],
  ])('keeps the job and reports no step when the lateral join is missing %s', async (_field, over) => {
    jobRows = [jobRow(over)];

    const page = await makeReader().list({ phases: [], deviceId: null, limit: 50, offset: 0 });

    expect(page.rows).toHaveLength(1);
    expect(page.rows[0].latestStep).toBeNull();
  });
});

describe('LifecycleJobsReaderService.get latest step', () => {
  it('reports the newest step on the detail too, not a null that would read as no events', async () => {
    jobRows = [
      {
        ...jobRow({
          stepId: 'evt-9',
          sagaName: 'provision',
          stepName: 'install',
          eventType: 'step',
          stepStatus: 'running',
          attempt: 0,
          stepError: null,
          occurredAt: NOW,
          recordedAt: NOW,
        }),
        payload: {},
      },
    ];

    const detail = await makeReader().get('plan-1');

    expect(detail.job?.latestStep).toMatchObject({ sagaName: 'provision', stepName: 'install' });
  });

  it('asks for the newest step in the by-id read, so the detail cannot disagree with its own timeline', async () => {
    jobRows = [{ ...jobRow(), payload: {} }];

    await makeReader().get('plan-1');

    const byId = pg.readTyped.mock.calls.find(([sql]) => sql.includes('WHERE j.id = $1'));
    expect(byId?.[0]).toContain('LEFT JOIN LATERAL');
  });
});

describe('LifecycleJobsReaderService phase census', () => {
  it('counts over the whole table rather than the returned page', async () => {
    censusRows = [
      { phase: 'RUNNING', count: 12 },
      { phase: 'FAILED', count: 3 },
    ];

    const page = await makeReader().list({ phases: ['RUNNING'], deviceId: null, limit: 1, offset: 0 });

    expect(page.counts).toEqual([
      { phase: 'RUNNING', count: 12 },
      { phase: 'FAILED', count: 3 },
    ]);
  });

  it('censuses without the phase filter, so the totals do not collapse to the selected phase', async () => {
    await makeReader().list({ phases: ['RUNNING'], deviceId: 'dev-9', limit: 50, offset: 0 });

    const censusCall = pg.readTyped.mock.calls.find(([sql]) => sql.includes('count(*)'));
    expect(censusCall?.[1]).toEqual(['dev-9']);
    expect(censusCall?.[0]).not.toMatch(/phase[^\n]*=/);
  });

  it('still reports the jobs when only the census failed', async () => {
    censusError = new Error('census down');

    const page = await makeReader().list({ phases: [], deviceId: null, limit: 50, offset: 0 });

    expect(page.rows).toHaveLength(1);
    expect(page.counts).toEqual([]);
    expect(page.countsReadError).toContain('census down');
    expect(page.readError).toBeNull();
  });

  it('still reports the census when only the listing failed', async () => {
    jobError = new Error('pg down');
    censusRows = [{ phase: 'FAILED', count: 4 }];

    const page = await makeReader().list({ phases: [], deviceId: null, limit: 50, offset: 0 });

    expect(page.rows).toEqual([]);
    expect(page.readError).toContain('pg down');
    expect(page.counts).toEqual([{ phase: 'FAILED', count: 4 }]);
  });
});
