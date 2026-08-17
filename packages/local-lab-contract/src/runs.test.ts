import { isAppRoute } from '@ts-rest/core';
import { describe, expect, it } from 'vitest';
import { contract } from './index';
import { RequestOriginSchema } from './schemas/common';
import { RunSchema, RunStatusSchema } from './schemas/runs';

const run = (over: Record<string, unknown> = {}) => ({
  runId: 'r1',
  section: 'stack',
  opId: 'reconcile',
  label: 'reconcile',
  status: 'running',
  startedAt: 1_700_000_000_000,
  finishedAt: null,
  exitCode: null,
  nodeIndex: null,
  origin: null,
  hasLog: false,
  hasResult: false,
  ...over,
});

const listQuery = () => {
  const route = contract.listRuns;
  if (!isAppRoute(route) || !route.query) throw new Error('listRuns query missing');
  return route.query;
};

describe('RunSchema', () => {
  it('parses a running run with no origin and no results', () => {
    expect(RunSchema.parse(run())).toMatchObject({ origin: null, finishedAt: null, exitCode: null });
  });

  it('parses a finished run carrying its origin', () => {
    const parsed = RunSchema.parse(
      run({
        status: 'passed',
        finishedAt: 1_700_000_005_000,
        exitCode: 0,
        origin: { ip: '127.0.0.1', loopback: true, tokenAuth: false },
        hasLog: true,
      }),
    );
    expect(parsed.origin).toEqual({ ip: '127.0.0.1', loopback: true, tokenAuth: false });
    expect(parsed.hasLog).toBe(true);
  });

  it('requires every origin flag once an origin is present', () => {
    expect(() => RunSchema.parse(run({ origin: { ip: '127.0.0.1', loopback: true } }))).toThrow();
    expect(() => RunSchema.parse(run({ origin: {} }))).toThrow();
  });

  it('allows a null origin ip but not a missing one', () => {
    expect(RequestOriginSchema.parse({ ip: null, loopback: false, tokenAuth: true }).ip).toBeNull();
    expect(() => RequestOriginSchema.parse({ loopback: false, tokenAuth: true })).toThrow();
  });

  it('rejects an unknown status and accepts every declared one', () => {
    for (const status of RunStatusSchema.options) {
      expect(RunSchema.parse(run({ status })).status).toBe(status);
    }
    expect(() => RunSchema.parse(run({ status: 'flaky' }))).toThrow();
  });

  it('rejects a section outside the enum', () => {
    expect(() => RunSchema.parse(run({ section: 'wormhole' }))).toThrow();
  });

  it('rejects a fractional nodeIndex but accepts null', () => {
    expect(RunSchema.parse(run({ nodeIndex: null })).nodeIndex).toBeNull();
    expect(RunSchema.parse(run({ nodeIndex: 3 })).nodeIndex).toBe(3);
    expect(() => RunSchema.parse(run({ nodeIndex: 1.5 }))).toThrow();
  });

  it('rejects a missing hasLog/hasResult rather than defaulting them', () => {
    const { hasLog: _hasLog, ...noLog } = run();
    const { hasResult: _hasResult, ...noResult } = run();
    expect(() => RunSchema.parse(noLog)).toThrow();
    expect(() => RunSchema.parse(noResult)).toThrow();
  });
});

describe('listRuns query', () => {
  it('defaults limit and offset on an empty query', () => {
    expect(listQuery().parse({})).toEqual({
      section: undefined,
      status: undefined,
      opId: undefined,
      limit: 100,
      offset: 0,
    });
  });

  it('coerces the string limit/offset an http query always carries', () => {
    expect(listQuery().parse({ limit: '25', offset: '50' })).toMatchObject({ limit: 25, offset: 50 });
  });

  it('rejects a limit outside 1..500', () => {
    expect(listQuery().parse({ limit: '500' }).limit).toBe(500);
    expect(() => listQuery().parse({ limit: '501' })).toThrow();
    expect(() => listQuery().parse({ limit: '0' })).toThrow();
    expect(() => listQuery().parse({ limit: '-1' })).toThrow();
  });

  it('rejects a fractional limit and a negative offset', () => {
    expect(() => listQuery().parse({ limit: '10.5' })).toThrow();
    expect(() => listQuery().parse({ offset: '-1' })).toThrow();
  });

  it('narrows section, status and opId', () => {
    expect(listQuery().parse({ section: 'test', status: 'failed', opId: 'smoke' })).toMatchObject({
      section: 'test',
      status: 'failed',
      opId: 'smoke',
    });
    expect(() => listQuery().parse({ section: 'wormhole' })).toThrow();
    expect(() => listQuery().parse({ status: 'flaky' })).toThrow();
  });
});

describe('run routes', () => {
  it('getRun declares a 404 and returns a full run', () => {
    const route = contract.getRun;
    if (!isAppRoute(route)) throw new Error('getRun not a route');
    expect(route.responses[404].parse({ error: 'unknown run' })).toEqual({ error: 'unknown run' });
    expect(route.responses[200].parse(run()).runId).toBe('r1');
  });

  it('cancelRun 200 carries only the delivered flag', () => {
    const route = contract.cancelRun;
    if (!isAppRoute(route)) throw new Error('cancelRun not a route');
    expect(route.responses[200].parse({ cancelled: false })).toEqual({ cancelled: false });
    expect(() => route.responses[200].parse({})).toThrow();
  });

  it('cancelRun declares both 404 and 409', () => {
    const route = contract.cancelRun;
    if (!isAppRoute(route)) throw new Error('cancelRun not a route');
    expect(route.responses[404]).toBeDefined();
    expect(route.responses[409].parse({ error: 'already terminal' })).toEqual({ error: 'already terminal' });
  });

  it('listRuns answers with an array of the unified run shape', () => {
    const route = contract.listRuns;
    if (!isAppRoute(route)) throw new Error('listRuns not a route');
    expect(route.responses[200].parse([run({ section: 'test' }), run({ section: 'stack' })])).toHaveLength(2);
    expect(() => route.responses[200].parse([{ runId: 'r1', opId: 'x' }])).toThrow();
  });
});
