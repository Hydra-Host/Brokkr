import { isAppRoute } from '@ts-rest/core';
import { describe, expect, it } from 'vitest';
import { contract } from './index';
import { QUEUE_JOB_STATES, QueueJobObservedStateSchema, QueueJobSchema, QueueJobStateSchema } from './schemas/queues';

const DEVICE = '11111111-2222-3333-4444-555555555555';
const PLAN = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const JOB_ID = `${DEVICE}-provision-${PLAN}`;

const job = (over: Record<string, unknown> = {}) => ({
  id: JOB_ID,
  name: 'saga.run',
  state: 'delayed',
  attemptsMade: 0,
  timestamp: 1_700_000_000_000,
  processedOn: null,
  finishedOn: null,
  delay: 30_000,
  failedReason: null,
  deviceId: DEVICE,
  sagaName: 'provision',
  planId: PLAN,
  sealed: false,
  zoneId: null,
  ...over,
});

const page = (over: Record<string, unknown> = {}) => ({
  queue: { prefix: 'zone-a', name: 'lifecycle', kind: 'saga' },
  states: ['delayed'],
  limit: 50,
  offset: 0,
  deviceId: null,
  deviceFilterSupported: true,
  cap: 200,
  jobs: [job()],
  truncated: false,
  discoveryCapped: false,
  ...over,
});

const aad = () => ({
  aad_v: 1,
  zone_id: 'zone-sealed',
  queue_name: 'lifecycle',
  direction: 'hub_to_bridge',
  job_id: JOB_ID,
  created_at: 1_700_000_000_001,
});

const detail = (over: Record<string, unknown> = {}) => ({
  ...job(),
  aad: null,
  payload: null,
  payloadTruncated: false,
  stacktrace: [],
  ...over,
});

const listQuery = () => {
  const route = contract.listQueueJobs;
  if (!isAppRoute(route) || !route.query) throw new Error('listQueueJobs query missing');
  return route.query;
};

const getParams = () => {
  const route = contract.getQueueJob;
  if (!isAppRoute(route) || !route.pathParams) throw new Error('getQueueJob pathParams missing');
  return route.pathParams;
};

describe('listQueueJobs query', () => {
  it('defaults states, limit and offset on an empty query', () => {
    expect(listQuery().parse({})).toEqual({ states: [], limit: 50, offset: 0, deviceId: undefined });
  });

  it('parses a comma-separated state filter', () => {
    expect(listQuery().parse({ states: 'failed,delayed' }).states).toEqual(['failed', 'delayed']);
    expect(listQuery().parse({ states: 'active' }).states).toEqual(['active']);
  });

  it('tolerates whitespace and empty segments around the state list', () => {
    expect(listQuery().parse({ states: ' failed , delayed ' }).states).toEqual(['failed', 'delayed']);
    expect(listQuery().parse({ states: 'failed,,delayed,' }).states).toEqual(['failed', 'delayed']);
    expect(listQuery().parse({ states: '' }).states).toEqual([]);
  });

  it('accepts every declared state', () => {
    expect(listQuery().parse({ states: QUEUE_JOB_STATES.join(',') }).states).toEqual([...QUEUE_JOB_STATES]);
  });

  it('rejects an unrecognised state rather than silently dropping it', () => {
    expect(() => listQuery().parse({ states: 'nonsense' })).toThrow();
    expect(() => listQuery().parse({ states: 'failed,nonsense' })).toThrow();
    expect(() => listQuery().parse({ states: 'waiting' })).toThrow();
    expect(() => listQuery().parse({ states: 'unknown' })).toThrow();
  });

  it('coerces the string limit/offset an http query always carries', () => {
    expect(listQuery().parse({ limit: '25', offset: '75' })).toMatchObject({ limit: 25, offset: 75 });
  });

  it('rejects a limit outside 1..200', () => {
    expect(listQuery().parse({ limit: '1' }).limit).toBe(1);
    expect(listQuery().parse({ limit: '200' }).limit).toBe(200);
    expect(() => listQuery().parse({ limit: '201' })).toThrow();
    expect(() => listQuery().parse({ limit: '0' })).toThrow();
    expect(() => listQuery().parse({ limit: '-1' })).toThrow();
  });

  it('rejects a fractional limit and a negative offset', () => {
    expect(() => listQuery().parse({ limit: '10.5' })).toThrow();
    expect(() => listQuery().parse({ offset: '-1' })).toThrow();
    expect(() => listQuery().parse({ offset: '1.5' })).toThrow();
  });

  it('accepts a uuid deviceId', () => {
    expect(listQuery().parse({ deviceId: DEVICE }).deviceId).toBe(DEVICE);
    expect(listQuery().parse({ deviceId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301' }).deviceId).toBe(
      '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
    );
  });

  it('rejects a non-uuid deviceId, since it is spliced into a redis scan pattern', () => {
    for (const deviceId of [
      '*',
      '?',
      `${DEVICE}*`,
      `*${DEVICE}`,
      'not-a-uuid',
      '11111111-2222-3333-4444-55555555555',
      '11111111222233334444555555555555',
      `${DEVICE}:meta`,
      '',
    ]) {
      expect(() => listQuery().parse({ deviceId }), deviceId).toThrow();
    }
  });
});

describe('getQueueJob path params', () => {
  it('accepts a saga-shaped and a hub-shaped job id', () => {
    const params = { prefix: 'zone-a', name: 'lifecycle' };
    expect(getParams().parse({ ...params, jobId: JOB_ID }).jobId).toBe(JOB_ID);
    expect(getParams().parse({ ...params, jobId: `device-${DEVICE}-provisioned-1700000000000` }).jobId).toBe(
      `device-${DEVICE}-provisioned-1700000000000`,
    );
    expect(getParams().parse({ ...params, jobId: '42' }).jobId).toBe('42');
  });

  it('accepts a repeatable job id, whose bullmq form carries key separators', () => {
    const params = { prefix: 'zone-a', name: 'lifecycle' };
    for (const jobId of [
      'repeat:device-data-reconcile-sweep:1785955080000',
      'repeat:lifecycle-stuck-sweep.sweep:1785955200000',
    ]) {
      expect(getParams().parse({ ...params, jobId }).jobId, jobId).toBe(jobId);
    }
  });

  it('rejects an empty job id', () => {
    const params = { prefix: 'zone-a', name: 'lifecycle' };
    expect(() => getParams().parse({ ...params, jobId: '' })).toThrow();
  });

  it('leaves a side-key or reserved-name id to the handler 404 rather than a transport 400', () => {
    const params = { prefix: 'zone-a', name: 'lifecycle' };
    for (const jobId of [`${JOB_ID}:logs`, `${JOB_ID}:processed`, 'meta', 'meta:x', ':meta', 'repeat:sweep']) {
      expect(getParams().parse({ ...params, jobId }).jobId, jobId).toBe(jobId);
    }
  });
});

describe('queue job state vocabulary', () => {
  it('exposes exactly the eight filterable states', () => {
    expect([...QUEUE_JOB_STATES]).toEqual([
      'wait',
      'active',
      'paused',
      'delayed',
      'prioritized',
      'waiting-children',
      'completed',
      'failed',
    ]);
  });

  it('keeps unknown out of the filter enum but inside the observed enum', () => {
    expect(() => QueueJobStateSchema.parse('unknown')).toThrow();
    expect(QueueJobObservedStateSchema.parse('unknown')).toBe('unknown');
  });

  it('rejects the raw bullmq waiting spelling on both enums', () => {
    expect(() => QueueJobStateSchema.parse('waiting')).toThrow();
    expect(() => QueueJobObservedStateSchema.parse('waiting')).toThrow();
  });
});

describe('QueueJobSchema', () => {
  it('parses a delayed job carrying an unchanged attempt count', () => {
    expect(QueueJobSchema.parse(job())).toMatchObject({ state: 'delayed', attemptsMade: 0, delay: 30_000 });
  });

  it('parses a sealed job whose id still yields device, saga and plan', () => {
    expect(QueueJobSchema.parse(job({ sealed: true, zoneId: 'zone-sealed' }))).toMatchObject({
      sealed: true,
      zoneId: 'zone-sealed',
      deviceId: DEVICE,
      sagaName: 'provision',
      planId: PLAN,
    });
  });

  it('allows null device, saga, plan and zone for a non-saga job', () => {
    const parsed = QueueJobSchema.parse(
      job({ id: 'device-status-effects-42', deviceId: null, sagaName: null, planId: null, zoneId: null }),
    );
    expect(parsed).toMatchObject({ deviceId: null, sagaName: null, planId: null, zoneId: null });
  });

  it('requires the nullable timing fields to be present rather than absent', () => {
    const { processedOn: _processedOn, ...noProcessedOn } = job();
    const { sealed: _sealed, ...noSealed } = job();
    expect(() => QueueJobSchema.parse(noProcessedOn)).toThrow();
    expect(() => QueueJobSchema.parse(noSealed)).toThrow();
  });

  it('rejects a state outside the observed enum and a fractional attempt count', () => {
    expect(() => QueueJobSchema.parse(job({ state: 'wormhole' }))).toThrow();
    expect(() => QueueJobSchema.parse(job({ attemptsMade: 1.5 }))).toThrow();
  });
});

describe('queue job routes', () => {
  it('listQueueJobs 200 round-trips a page and declares a 404', () => {
    const route = contract.listQueueJobs;
    if (!isAppRoute(route)) throw new Error('listQueueJobs not a route');
    expect(route.responses[200].parse(page())).toMatchObject({ cap: 200, truncated: false });
    expect(route.responses[200].parse(page({ truncated: true, deviceId: DEVICE })).deviceId).toBe(DEVICE);
    expect(route.responses[404].parse({ error: 'unknown queue: zone-a:nope' })).toEqual({
      error: 'unknown queue: zone-a:nope',
    });
  });

  it('listQueueJobs 200 rejects a page missing its truncation honesty flag', () => {
    const route = contract.listQueueJobs;
    if (!isAppRoute(route)) throw new Error('listQueueJobs not a route');
    const { truncated: _truncated, ...noTruncated } = page();
    const { cap: _cap, ...noCap } = page();
    expect(() => route.responses[200].parse(noTruncated)).toThrow();
    expect(() => route.responses[200].parse(noCap)).toThrow();
  });

  it('listQueueJobs 200 requires the unreachable-remainder flag', () => {
    const route = contract.listQueueJobs;
    if (!isAppRoute(route)) throw new Error('listQueueJobs not a route');
    const { discoveryCapped: _capped, ...noFlag } = page();
    expect(() => route.responses[200].parse(noFlag)).toThrow();
    expect(
      route.responses[200].parse(page({ deviceId: DEVICE, truncated: true, discoveryCapped: true })),
    ).toMatchObject({ truncated: true, discoveryCapped: true });
  });

  it('listQueueJobs 200 requires the device-filter applicability flag', () => {
    const route = contract.listQueueJobs;
    if (!isAppRoute(route)) throw new Error('listQueueJobs not a route');
    const { deviceFilterSupported: _supported, ...noFlag } = page();
    expect(() => route.responses[200].parse(noFlag)).toThrow();
    expect(
      route.responses[200].parse(
        page({
          queue: { prefix: 'results', name: 'inbox', kind: 'results' },
          deviceId: DEVICE,
          deviceFilterSupported: false,
          jobs: [],
        }),
      ),
    ).toMatchObject({ deviceFilterSupported: false, jobs: [] });
  });

  it('getQueueJob 200 round-trips an unsealed detail with a null aad and declares a 404', () => {
    const route = contract.getQueueJob;
    if (!isAppRoute(route)) throw new Error('getQueueJob not a route');
    const parsed = route.responses[200].parse(detail());
    expect(parsed).toMatchObject({ sealed: false, aad: null, payload: null, payloadTruncated: false, stacktrace: [] });
    expect(route.responses[404].parse({ error: 'unknown job' })).toEqual({ error: 'unknown job' });
  });

  it('getQueueJob 200 round-trips the redacted payload and its truncation flag', () => {
    const route = contract.getQueueJob;
    if (!isAppRoute(route)) throw new Error('getQueueJob not a route');
    const parsed = route.responses[200].parse(
      detail({ payload: { saga_name: 'provision', user_data: '***', pubkeys: '<redacted: 2 items>' } }),
    );
    expect(parsed).toMatchObject({
      payload: { saga_name: 'provision', user_data: '***', pubkeys: '<redacted: 2 items>' },
      payloadTruncated: false,
    });
    expect(route.responses[200].parse(detail({ payload: { dmi: 'x' }, payloadTruncated: true }))).toMatchObject({
      payloadTruncated: true,
    });
  });

  it('getQueueJob 200 carries a sealed job aad header', () => {
    const route = contract.getQueueJob;
    if (!isAppRoute(route)) throw new Error('getQueueJob not a route');
    const parsed = route.responses[200].parse(detail({ sealed: true, aad: aad() }));
    expect(parsed.aad).toEqual(aad());
    expect(parsed.sealed).toBe(true);
  });

  it('getQueueJob 200 strips an aad key outside the six frozen fields', () => {
    const route = contract.getQueueJob;
    if (!isAppRoute(route)) throw new Error('getQueueJob not a route');
    const parsed = route.responses[200].parse(
      detail({ sealed: true, aad: { ...aad(), ciphertext: 'bm90LWEtcmVhbC1jaXBoZXJ0ZXh0' } }),
    );
    expect(parsed.aad).toEqual(aad());
    expect(JSON.stringify(parsed)).not.toContain('ciphertext');
  });

  it('getQueueJob 200 rejects an aad missing a frozen field', () => {
    const route = contract.getQueueJob;
    if (!isAppRoute(route)) throw new Error('getQueueJob not a route');
    for (const key of ['aad_v', 'zone_id', 'queue_name', 'direction', 'job_id', 'created_at']) {
      const partial: Record<string, unknown> = aad();
      delete partial[key];
      expect(() => route.responses[200].parse(detail({ sealed: true, aad: partial })), key).toThrow();
    }
  });

  it('getQueueJob 200 requires aad, payloadTruncated and stacktrace to be present rather than absent', () => {
    const route = contract.getQueueJob;
    if (!isAppRoute(route)) throw new Error('getQueueJob not a route');
    const { aad: _aad, ...noAad } = detail();
    const { payloadTruncated: _truncated, ...noTruncated } = detail();
    const { stacktrace: _trace, ...noTrace } = detail();
    expect(() => route.responses[200].parse(noAad)).toThrow();
    expect(() => route.responses[200].parse(noTruncated)).toThrow();
    expect(() => route.responses[200].parse(noTrace)).toThrow();
  });

  it('both job routes are GET under the queue ref path', () => {
    const list = contract.listQueueJobs;
    const get = contract.getQueueJob;
    if (!isAppRoute(list) || !isAppRoute(get)) throw new Error('job routes missing');
    expect(list.method).toBe('GET');
    expect(get.method).toBe('GET');
    expect(list.path).toBe('/api/queues/:prefix/:name/jobs');
    expect(get.path).toBe('/api/queues/:prefix/:name/jobs/:jobId');
  });
});
