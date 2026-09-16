import { Logger } from '@nestjs/common';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type AuditEvent } from '../../contract';
import { type AuditEventRow, closeDb, getDb } from '../../db/db';
import { AuditStore } from '../../ledger/audit-store';
import { AuditService } from '../audit.service';

const PAGE = { limit: 100, offset: 0 };

let stateDir: string;
let store: AuditStore;
let svc: AuditService;
let now: number;

function auditRow(over: Partial<Omit<AuditEventRow, 'id'>> = {}): Omit<AuditEventRow, 'id'> {
  return {
    ts: now,
    method: 'POST',
    path: '/api/stack/ops',
    handler: 'startStackRun',
    outcome: 'ok',
    status_code: 201,
    duration_ms: 12,
    run_id: null,
    origin_ip: '127.0.0.1',
    origin_loopback: 1,
    origin_token: 0,
    origin_principal: null,
    params: '{"opId":"nuke"}',
    error: null,
    ...over,
  };
}

function unreadableRow(path: string): void {
  getDb()
    .prepare(
      `INSERT INTO audit_events (ts, method, path, handler, outcome)
       VALUES ('not-a-number', 'POST', @path, 'X.y', 'ok')`,
    )
    .run({ path });
}

function paths(events: AuditEvent[]): string[] {
  return events.map((event) => event.path);
}

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'lab-audit-svc-'));
  vi.stubEnv('LOCAL_STATE', stateDir);
  now = Date.now();
  store = new AuditStore();
  svc = new AuditService(store);
});

afterEach(() => {
  vi.restoreAllMocks();
  closeDb();
  vi.unstubAllEnvs();
  rmSync(stateDir, { recursive: true, force: true });
});

describe('AuditService row mapping', () => {
  it('renames every snake_case column to its contract field', () => {
    store.insert(auditRow({ outcome: 'error', status_code: 404, duration_ms: 3, run_id: 'run-7', error: 'nope' }));

    const [event] = svc.list(PAGE);

    expect(event).toEqual({
      id: expect.any(Number),
      ts: now,
      method: 'POST',
      path: '/api/stack/ops',
      handler: 'startStackRun',
      outcome: 'error',
      statusCode: 404,
      durationMs: 3,
      runId: 'run-7',
      origin: { ip: '127.0.0.1', loopback: true, tokenAuth: false },
      params: '{"opId":"nuke"}',
      error: 'nope',
    });
  });

  it('carries the rowid through as the tiebreaker id', () => {
    store.insert(auditRow());

    expect(svc.list(PAGE)[0]!.id).toBeGreaterThan(0);
  });

  it('decodes a token-authorized remote origin triple', () => {
    store.insert(auditRow({ origin_ip: '10.0.0.5', origin_loopback: 0, origin_token: 1 }));

    expect(svc.list(PAGE)[0]!.origin).toEqual({ ip: '10.0.0.5', loopback: false, tokenAuth: true });
  });

  it('reads an all-null origin triple as a system-issued call', () => {
    store.insert(auditRow({ origin_ip: null, origin_loopback: null, origin_token: null }));

    expect(svc.list(PAGE)[0]!.origin).toBeNull();
  });

  it('keeps a null status code, duration, run id and params null', () => {
    store.insert(auditRow({ status_code: null, duration_ms: null, run_id: null, params: null, error: null }));

    expect(svc.list(PAGE)[0]).toMatchObject({
      statusCode: null,
      durationMs: null,
      runId: null,
      params: null,
      error: null,
    });
  });
});

describe('AuditService list', () => {
  beforeEach(() => {
    store.insert(auditRow({ ts: now - 3_000, path: '/api/one', outcome: 'ok', method: 'POST' }));
    store.insert(auditRow({ ts: now - 2_000, path: '/api/two', outcome: 'error', method: 'POST' }));
    store.insert(auditRow({ ts: now - 1_000, path: '/api/three', outcome: 'denied', method: 'DELETE' }));
  });

  it('returns the page newest first', () => {
    expect(paths(svc.list(PAGE))).toEqual(['/api/three', '/api/two', '/api/one']);
  });

  it('passes the outcome filter through', () => {
    expect(paths(svc.list({ ...PAGE, outcome: 'error' }))).toEqual(['/api/two']);
  });

  it('passes the method filter through', () => {
    expect(paths(svc.list({ ...PAGE, method: 'POST' }))).toEqual(['/api/two', '/api/one']);
  });

  it('passes the since bound through, inclusive of the boundary', () => {
    expect(paths(svc.list({ ...PAGE, since: now - 2_000 }))).toEqual(['/api/three', '/api/two']);
  });

  it('hands the store the query verbatim rather than re-deriving it', () => {
    const list = vi.spyOn(store, 'list');

    svc.list({ outcome: 'denied', method: 'DELETE', since: now - 1_000, limit: 5, offset: 2 });

    expect(list.mock.calls).toEqual([[{ outcome: 'denied', method: 'DELETE', since: now - 1_000, limit: 5, offset: 2 }]]);
  });

  it('honours limit and offset', () => {
    expect(paths(svc.list({ limit: 2, offset: 0 }))).toEqual(['/api/three', '/api/two']);
    expect(paths(svc.list({ limit: 2, offset: 2 }))).toEqual(['/api/one']);
    expect(svc.list({ limit: 2, offset: 3 })).toEqual([]);
  });

  it('returns an empty page rather than throwing when nothing matches', () => {
    expect(svc.list({ ...PAGE, method: 'PATCH' })).toEqual([]);
  });
});

describe('AuditService lenient read', () => {
  it('warns with the skipped count and still serves the readable rows', () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    store.insert(auditRow({ path: '/api/readable' }));
    unreadableRow('/api/unreadable');

    const events = svc.list(PAGE);

    expect(paths(events)).toEqual(['/api/readable']);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain('1');
  });

  it('stays quiet when every row reads', () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    store.insert(auditRow());

    expect(svc.list(PAGE)).toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it('does not throw when every row of the page is unreadable', () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    unreadableRow('/api/unreadable');

    expect(svc.list(PAGE)).toEqual([]);
  });
});
