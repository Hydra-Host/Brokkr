import { isAppRoute } from '@ts-rest/core';
import { describe, expect, it } from 'vitest';
import { contract } from './index';
import { AuditEventSchema, AuditOutcomeSchema } from './schemas/audit';

const event = (over: Record<string, unknown> = {}) => ({
  id: 1,
  ts: 1_700_000_000_000,
  method: 'POST',
  path: '/api/datastore/pg/query',
  handler: 'runPgQuery',
  outcome: 'ok',
  statusCode: 200,
  durationMs: 12,
  runId: null,
  origin: { ip: '127.0.0.1', loopback: true, tokenAuth: false },
  params: '{"sql":"select 1"}',
  error: null,
  ...over,
});

const listQuery = () => {
  const route = contract.listAuditEvents;
  if (!isAppRoute(route) || !route.query) throw new Error('listAuditEvents query missing');
  return route.query;
};

describe('AuditEventSchema', () => {
  it('parses an ok event carrying its origin and redacted params', () => {
    const parsed = AuditEventSchema.parse(event());
    expect(parsed.origin).toEqual({ ip: '127.0.0.1', loopback: true, tokenAuth: false });
    expect(parsed.params).toBe('{"sql":"select 1"}');
  });

  it('parses a denial with no status, duration, params or origin', () => {
    const parsed = AuditEventSchema.parse(
      event({ outcome: 'denied', statusCode: null, durationMs: null, params: null, origin: null, error: 'no token' }),
    );
    expect(parsed).toMatchObject({ outcome: 'denied', statusCode: null, durationMs: null, error: 'no token' });
  });

  it('requires every origin flag once an origin is present', () => {
    expect(() => AuditEventSchema.parse(event({ origin: { ip: '127.0.0.1', loopback: true } }))).toThrow();
    expect(() => AuditEventSchema.parse(event({ origin: {} }))).toThrow();
  });

  it('accepts every declared outcome and rejects an undeclared one', () => {
    for (const outcome of AuditOutcomeSchema.options) {
      expect(AuditEventSchema.parse(event({ outcome })).outcome).toBe(outcome);
    }
    expect(() => AuditEventSchema.parse(event({ outcome: 'throttled' }))).toThrow();
  });

  it('rejects a missing id, ts, method, path, handler or outcome rather than defaulting it', () => {
    for (const key of ['id', 'ts', 'method', 'path', 'handler', 'outcome'] as const) {
      const { [key]: _dropped, ...missing } = event();
      expect(() => AuditEventSchema.parse(missing), `${key} should be required`).toThrow();
    }
  });

  it('rejects a missing nullable field rather than defaulting it to null', () => {
    const { statusCode: _statusCode, ...noStatus } = event();
    const { error: _error, ...noError } = event();
    expect(() => AuditEventSchema.parse(noStatus)).toThrow();
    expect(() => AuditEventSchema.parse(noError)).toThrow();
  });

  it('rejects a fractional id, statusCode or durationMs', () => {
    expect(() => AuditEventSchema.parse(event({ id: 1.5 }))).toThrow();
    expect(() => AuditEventSchema.parse(event({ statusCode: 200.5 }))).toThrow();
    expect(() => AuditEventSchema.parse(event({ durationMs: 12.5 }))).toThrow();
  });
});

describe('listAuditEvents query', () => {
  it('defaults limit and offset on an empty query', () => {
    expect(listQuery().parse({})).toEqual({
      outcome: undefined,
      method: undefined,
      since: undefined,
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

  it('coerces since and rejects a negative or fractional bound', () => {
    expect(listQuery().parse({ since: '1700000000000' }).since).toBe(1_700_000_000_000);
    expect(() => listQuery().parse({ since: '-1' })).toThrow();
    expect(() => listQuery().parse({ since: '10.5' })).toThrow();
  });

  it('narrows outcome and method', () => {
    expect(listQuery().parse({ outcome: 'denied', method: 'POST' })).toMatchObject({
      outcome: 'denied',
      method: 'POST',
    });
    expect(() => listQuery().parse({ outcome: 'throttled' })).toThrow();
  });
});

describe('audit routes', () => {
  it('listAuditEvents declares only a 200 answering with an array of events', () => {
    const route = contract.listAuditEvents;
    if (!isAppRoute(route)) throw new Error('listAuditEvents not a route');
    expect(Object.keys(route.responses)).toEqual(['200']);
    expect(route.responses[200].parse([event(), event({ id: 2, outcome: 'error', error: 'boom' })])).toHaveLength(2);
    expect(() => route.responses[200].parse([{ id: 1, handler: 'runPgQuery' }])).toThrow();
  });

  it('listAuditEvents is a read-only GET with no body', () => {
    const route = contract.listAuditEvents;
    if (!isAppRoute(route)) throw new Error('listAuditEvents not a route');
    expect(route.method).toBe('GET');
    expect(route.path).toBe('/api/audit');
    expect(route).not.toHaveProperty('body');
  });
});
