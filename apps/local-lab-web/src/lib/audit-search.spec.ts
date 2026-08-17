import { describe, expect, it } from 'vitest';

import { AuditOutcomeSchema, contract } from '@/contract';

import type { AuditSearch } from './audit-search';
import {
  AUDIT_METHODS,
  AUDIT_OUTCOMES,
  isAuditMethod,
  isAuditOutcome,
  matchesAuditQuery,
  validateAuditSearch,
} from './audit-search';

const defaults: AuditSearch = {
  outcome: undefined,
  method: undefined,
  q: undefined,
  page: undefined,
};

describe('validateAuditSearch', () => {
  it('shows the unfiltered newest page when the url carries nothing', () => {
    expect(validateAuditSearch({})).toEqual(defaults);
  });

  it('drops wrong-typed params back to the defaults instead of throwing', () => {
    expect(validateAuditSearch({ outcome: 1, method: true, q: {}, page: 'two' })).toEqual(defaults);
  });

  it('treats empty strings as absent', () => {
    expect(validateAuditSearch({ q: '', method: '', outcome: '' })).toEqual(defaults);
  });

  it('keeps only an outcome the contract defines', () => {
    expect(validateAuditSearch({ outcome: 'denied' }).outcome).toBe('denied');
    expect(validateAuditSearch({ outcome: 'ok' }).outcome).toBe('ok');
    expect(validateAuditSearch({ outcome: 'error' }).outcome).toBe('error');
    expect(validateAuditSearch({ outcome: 'failed' }).outcome).toBeUndefined();
    expect(validateAuditSearch({ outcome: 'OK' }).outcome).toBeUndefined();
  });

  it('upper-cases a method the table can hold and drops one it cannot', () => {
    expect(validateAuditSearch({ method: 'Put' }).method).toBe('PUT');
    expect(validateAuditSearch({ method: 'POST' }).method).toBe('POST');
    expect(validateAuditSearch({ method: 'ws' }).method).toBe('WS');
    expect(validateAuditSearch({ method: 'TRACE' }).method).toBeUndefined();
    expect(validateAuditSearch({ method: 'GET /api/audit' }).method).toBeUndefined();
  });

  it('drops a hand-edited read method rather than passing it through to an always-empty view', () => {
    expect(validateAuditSearch({ method: 'GET' }).method).toBeUndefined();
    expect(validateAuditSearch({ method: 'get' }).method).toBeUndefined();
    expect(validateAuditSearch({ method: 'HEAD' }).method).toBeUndefined();
    expect(validateAuditSearch({ method: 'OPTIONS' }).method).toBeUndefined();
  });

  it('accepts only a non-negative integer page', () => {
    expect(validateAuditSearch({ page: 0 }).page).toBe(0);
    expect(validateAuditSearch({ page: 4 }).page).toBe(4);
    expect(validateAuditSearch({ page: -1 }).page).toBeUndefined();
    expect(validateAuditSearch({ page: 1.5 }).page).toBeUndefined();
    expect(validateAuditSearch({ page: Number.POSITIVE_INFINITY }).page).toBeUndefined();
    expect(validateAuditSearch({ page: Number.NaN }).page).toBeUndefined();
  });

  it('round-trips a fully specified view', () => {
    const search: AuditSearch = { outcome: 'error', method: 'POST', q: 'runPgQuery', page: 2 };
    expect(validateAuditSearch({ ...search })).toEqual(search);
  });

  it('ignores params the route does not own', () => {
    expect(validateAuditSearch({ q: 'sql', bogus: 'x' })).toEqual({ ...defaults, q: 'sql' });
  });
});

describe('isAuditOutcome', () => {
  it('accepts the contract outcomes and rejects everything else', () => {
    expect(isAuditOutcome('ok')).toBe(true);
    expect(isAuditOutcome('error')).toBe(true);
    expect(isAuditOutcome('denied')).toBe(true);
    expect(isAuditOutcome('failed')).toBe(false);
    expect(isAuditOutcome('')).toBe(false);
    expect(isAuditOutcome(undefined)).toBe(false);
    expect(isAuditOutcome(7)).toBe(false);
  });
});

describe('isAuditMethod', () => {
  it('accepts the recordable methods and rejects everything else', () => {
    expect(isAuditMethod('POST')).toBe(true);
    expect(isAuditMethod('PUT')).toBe(true);
    expect(isAuditMethod('DELETE')).toBe(true);
    expect(isAuditMethod('WS')).toBe(true);
    expect(isAuditMethod('GET')).toBe(false);
    expect(isAuditMethod('HEAD')).toBe(false);
    expect(isAuditMethod('OPTIONS')).toBe(false);
    expect(isAuditMethod('post')).toBe(false);
    expect(isAuditMethod(null)).toBe(false);
  });
});

describe('the audit filter options', () => {
  const SAFE_METHODS = ['GET', 'HEAD', 'OPTIONS'];
  const recordable = [...new Set(Object.values(contract).map((route) => route.method))].filter(
    (method) => !SAFE_METHODS.includes(method),
  );

  it('offers every outcome the contract schema carries', () => {
    expect([...AUDIT_OUTCOMES].sort()).toEqual([...AuditOutcomeSchema.options].sort());
  });

  it('offers every unsafe verb the contract serves plus the websocket upgrade marker', () => {
    expect([...AUDIT_METHODS].sort()).toEqual([...recordable, 'WS'].sort());
  });

  it('offers no method the interceptor and the auth guard refuse to record', () => {
    for (const safe of SAFE_METHODS) expect(AUDIT_METHODS).not.toContain(safe);
  });
});

describe('matchesAuditQuery', () => {
  const event = { path: '/api/pg/query', handler: 'runPgQuery' };

  it('keeps every row when the box is empty or blank', () => {
    expect(matchesAuditQuery(event, '')).toBe(true);
    expect(matchesAuditQuery(event, '   ')).toBe(true);
  });

  it('matches the path and the handler case-insensitively', () => {
    expect(matchesAuditQuery(event, 'pg/query')).toBe(true);
    expect(matchesAuditQuery(event, 'RUNPG')).toBe(true);
    expect(matchesAuditQuery(event, '  runpgquery  ')).toBe(true);
  });

  it('rejects a needle in neither field', () => {
    expect(matchesAuditQuery(event, 'redis')).toBe(false);
  });

  it('does not match across the path/handler boundary', () => {
    expect(matchesAuditQuery(event, 'query runPgQuery')).toBe(false);
  });
});
