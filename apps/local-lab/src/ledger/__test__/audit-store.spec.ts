import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type AuditEventRow, closeDb, getDb } from '../../db/db';
import { AuditStore } from '../audit-store';

let stateDir: string;
let audit: AuditStore;
let now: number;

function auditRow(over: Partial<Omit<AuditEventRow, 'id'>> = {}): Omit<AuditEventRow, 'id'> {
  return {
    ts: now,
    method: 'POST',
    path: '/api/stack/ops',
    handler: 'StackController.runOp',
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

function paths(rows: AuditEventRow[]): string[] {
  return rows.map((row) => row.path);
}

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'lab-audit-store-'));
  vi.stubEnv('LOCAL_STATE', stateDir);
  now = Date.now();
  audit = new AuditStore();
});

afterEach(() => {
  vi.restoreAllMocks();
  closeDb();
  vi.unstubAllEnvs();
  rmSync(stateDir, { recursive: true, force: true });
});

describe('AuditStore insert', () => {
  it('round-trips every column of a mutating request', () => {
    audit.insert(
      auditRow({
        run_id: 'run-7',
        params: '{"password":"***"}',
        origin_ip: '10.0.0.5',
        origin_loopback: 0,
        origin_token: 1,
      }),
    );

    const read = audit.list({ limit: 10, offset: 0 });

    expect(read.skipped).toBe(0);
    expect(read.rows).toHaveLength(1);
    expect(read.rows[0]).toMatchObject({
      ts: now,
      method: 'POST',
      path: '/api/stack/ops',
      handler: 'StackController.runOp',
      outcome: 'ok',
      status_code: 201,
      duration_ms: 12,
      run_id: 'run-7',
      origin_ip: '10.0.0.5',
      origin_loopback: 0,
      origin_token: 1,
      params: '{"password":"***"}',
      error: null,
    });
    expect(read.rows[0]!.id).toBeGreaterThan(0);
  });

  it('accepts an error outcome carrying a status code and a message', () => {
    audit.insert(auditRow({ outcome: 'error', status_code: 404, error: "unknown run 'nope'" }));

    expect(audit.list({ limit: 10, offset: 0 }).rows[0]).toMatchObject({
      outcome: 'error',
      status_code: 404,
      error: "unknown run 'nope'",
    });
  });

  it('keeps a run_id whose run row no longer exists', () => {
    audit.insert(auditRow({ run_id: 'already-pruned' }));

    expect(audit.list({ limit: 10, offset: 0 }).rows[0]!.run_id).toBe('already-pruned');
  });
});

describe('AuditStore list filters', () => {
  beforeEach(() => {
    audit.insert(auditRow({ ts: now - 3_000, path: '/api/one', outcome: 'ok', method: 'POST' }));
    audit.insert(auditRow({ ts: now - 2_000, path: '/api/two', outcome: 'error', method: 'POST' }));
    audit.insert(auditRow({ ts: now - 1_000, path: '/api/three', outcome: 'denied', method: 'DELETE' }));
  });

  it('returns every row newest first with no filter', () => {
    expect(paths(audit.list({ limit: 10, offset: 0 }).rows)).toEqual(['/api/three', '/api/two', '/api/one']);
  });

  it('filters by outcome', () => {
    expect(paths(audit.list({ outcome: 'error', limit: 10, offset: 0 }).rows)).toEqual(['/api/two']);
    expect(paths(audit.list({ outcome: 'denied', limit: 10, offset: 0 }).rows)).toEqual(['/api/three']);
  });

  it('filters by method', () => {
    expect(paths(audit.list({ method: 'POST', limit: 10, offset: 0 }).rows)).toEqual(['/api/two', '/api/one']);
  });

  it('filters by since, inclusive of the boundary', () => {
    expect(paths(audit.list({ since: now - 2_000, limit: 10, offset: 0 }).rows)).toEqual(['/api/three', '/api/two']);
  });

  it('combines outcome, method and since', () => {
    expect(paths(audit.list({ outcome: 'ok', method: 'POST', since: now - 3_000, limit: 10, offset: 0 }).rows)).toEqual([
      '/api/one',
    ]);
    expect(audit.list({ outcome: 'ok', method: 'DELETE', limit: 10, offset: 0 }).rows).toEqual([]);
  });
});

describe('AuditStore list paging', () => {
  it('pages through the newest-first ordering without repeating a row', () => {
    for (const offset of [4_000, 3_000, 2_000, 1_000]) audit.insert(auditRow({ ts: now - offset, path: `/api/${offset}` }));

    expect(paths(audit.list({ limit: 2, offset: 0 }).rows)).toEqual(['/api/1000', '/api/2000']);
    expect(paths(audit.list({ limit: 2, offset: 2 }).rows)).toEqual(['/api/3000', '/api/4000']);
    expect(audit.list({ limit: 2, offset: 4 }).rows).toEqual([]);
  });

  it('breaks a tie on the same timestamp by id, newest first', () => {
    audit.insert(auditRow({ ts: now, path: '/api/first' }));
    audit.insert(auditRow({ ts: now, path: '/api/second' }));

    expect(paths(audit.list({ limit: 10, offset: 0 }).rows)).toEqual(['/api/second', '/api/first']);
  });

  it('applies the limit under a filter too', () => {
    for (const offset of [3_000, 2_000, 1_000]) {
      audit.insert(auditRow({ ts: now - offset, path: `/api/${offset}`, outcome: 'error' }));
    }

    expect(paths(audit.list({ outcome: 'error', limit: 1, offset: 1 }).rows)).toEqual(['/api/2000']);
  });
});

describe('AuditStore lenient read', () => {
  it('skips a row this build cannot read instead of throwing', () => {
    audit.insert(auditRow({ path: '/api/readable' }));
    getDb()
      .prepare(
        `INSERT INTO audit_events (ts, method, path, handler, outcome)
         VALUES ('not-a-number', 'POST', '/api/unreadable', 'X.y', 'ok')`,
      )
      .run();

    const read = audit.list({ limit: 10, offset: 0 });

    expect(read.skipped).toBe(1);
    expect(paths(read.rows)).toEqual(['/api/readable']);
  });

  it('leaves the unreadable row in the table for a newer build to read', () => {
    getDb()
      .prepare(
        `INSERT INTO audit_events (ts, method, path, handler, outcome)
         VALUES ('not-a-number', 'POST', '/api/unreadable', 'X.y', 'ok')`,
      )
      .run();

    audit.list({ limit: 10, offset: 0 });

    expect(getDb().prepare<[], { c: number }>(`SELECT COUNT(*) AS c FROM audit_events`).get()!.c).toBe(1);
  });
});

describe('AuditStore prune', () => {
  it('evicts rows over the cap and past the ttl through the store', () => {
    audit.insert(auditRow({ ts: now - 100 * 24 * 60 * 60 * 1000, path: '/api/ancient' }));
    audit.insert(auditRow({ ts: now - 2_000, path: '/api/old' }));
    audit.insert(auditRow({ ts: now - 1_000, path: '/api/new' }));

    expect(audit.prune({ keep: 1, deniedKeep: 1, before: now - 90 * 24 * 60 * 60 * 1000 })).toBe(2);

    expect(paths(audit.list({ limit: 10, offset: 0 }).rows)).toEqual(['/api/new']);
  });

  it('applies the two caps to their own outcome class only', () => {
    for (const offset of [4_000, 3_000]) audit.insert(auditRow({ ts: now - offset, path: `/api/ok-${offset}` }));
    for (const offset of [2_000, 1_000]) {
      audit.insert(auditRow({ ts: now - offset, path: `/api/denied-${offset}`, outcome: 'denied' }));
    }

    expect(audit.prune({ keep: 2, deniedKeep: 1, before: now - 90 * 24 * 60 * 60 * 1000 })).toBe(1);

    expect(paths(audit.list({ limit: 10, offset: 0 }).rows)).toEqual([
      '/api/denied-1000',
      '/api/ok-3000',
      '/api/ok-4000',
    ]);
  });

  it('keeps the newest rows of each class when both are over their cap', () => {
    for (const offset of [4_000, 3_000]) audit.insert(auditRow({ ts: now - offset, path: `/api/ok-${offset}` }));
    for (const offset of [2_000, 1_000]) {
      audit.insert(auditRow({ ts: now - offset, path: `/api/denied-${offset}`, outcome: 'denied' }));
    }

    expect(audit.prune({ keep: 1, deniedKeep: 1, before: now - 90 * 24 * 60 * 60 * 1000 })).toBe(2);

    expect(paths(audit.list({ limit: 10, offset: 0 }).rows)).toEqual(['/api/denied-1000', '/api/ok-3000']);
  });
});
