import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type AuditEvent } from '../../contract';
import { closeDb } from '../../db/db';
import { AuditStore } from '../../ledger/audit-store';
import { AuditController } from '../audit.controller';
import { AuditService } from '../audit.service';

const EVENT: AuditEvent = {
  id: 4,
  ts: 1_700_000_000_000,
  method: 'DELETE',
  path: '/api/runs/run-7',
  handler: 'deleteRun',
  outcome: 'denied',
  statusCode: 403,
  durationMs: null,
  runId: 'run-7',
  origin: { ip: '10.0.0.5', loopback: false, tokenAuth: true },
  params: null,
  error: 'loopback-only',
};

const QUERY = { outcome: 'denied', method: 'DELETE', since: 1_700_000_000_000, limit: 25, offset: 50 } as const;

let stateDir: string;
let store: AuditStore;
let svc: AuditService;
let ctrl: AuditController;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'lab-audit-ctrl-'));
  vi.stubEnv('LOCAL_STATE', stateDir);
  store = new AuditStore();
  svc = new AuditService(store);
  ctrl = new AuditController(svc);
});

afterEach(() => {
  vi.restoreAllMocks();
  closeDb();
  vi.unstubAllEnvs();
  rmSync(stateDir, { recursive: true, force: true });
});

describe('GET /api/audit', () => {
  it('hands the query to the service once and returns its result unchanged', async () => {
    const list = vi.spyOn(svc, 'list').mockReturnValue([EVENT]);

    const response = await ctrl.list()({ query: { ...QUERY }, headers: {} });

    expect(response).toEqual({ status: 200, body: [EVENT] });
    expect(list.mock.calls).toEqual([[{ ...QUERY }]]);
  });

  it('reads the store through the service rather than reaching past it', async () => {
    const storeList = vi.spyOn(store, 'list');

    await ctrl.list()({ query: { limit: 100, offset: 0 }, headers: {} });

    expect(storeList).toHaveBeenCalledTimes(1);
  });

  it('answers an empty log with an empty page', async () => {
    const response = await ctrl.list()({ query: { limit: 100, offset: 0 }, headers: {} });

    expect(response).toEqual({ status: 200, body: [] });
  });
});
