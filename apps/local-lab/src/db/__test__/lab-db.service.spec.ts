import { Test } from '@nestjs/testing';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DbModule } from '../db.module';
import { closeDb, getDb } from '../db';
import { LabDbService } from '../lab-db.service';

let stateDir: string;

function dbFile(): string {
  return join(stateDir, 'lab', 'test-tracking.db');
}

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'lab-db-service-'));
  vi.stubEnv('LOCAL_STATE', stateDir);
});

afterEach(() => {
  closeDb();
  vi.unstubAllEnvs();
  rmSync(stateDir, { recursive: true, force: true });
});

describe('LabDbService hooks', () => {
  it('opens a usable migrated database on init', () => {
    const service = new LabDbService();

    service.onModuleInit();

    expect(existsSync(dbFile())).toBe(true);
    const db = getDb();
    expect(db.open).toBe(true);
    expect(db.prepare<[], { c: number }>(`SELECT COUNT(*) AS c FROM runs`).get()).toEqual({ c: 0 });
  });

  it('closes the handle on shutdown', () => {
    const service = new LabDbService();
    service.onModuleInit();
    const db = getDb();

    service.onApplicationShutdown();

    expect(db.open).toBe(false);
  });
});

describe('LabDbService under the real nest lifecycle', () => {
  it('opens the database when the module initialises and closes it when it shuts down', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [DbModule] }).compile();
    expect(existsSync(dbFile())).toBe(false);

    await moduleRef.init();

    expect(existsSync(dbFile())).toBe(true);
    const db = getDb();
    expect(db.open).toBe(true);
    expect(db.prepare<[], { v: number }>(`SELECT 1 AS v`).get()).toEqual({ v: 1 });

    await moduleRef.close();

    expect(db.open).toBe(false);
  });

  it('exposes the one shared handle every ledger read goes through', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [DbModule] }).compile();
    await moduleRef.init();

    expect(moduleRef.get(LabDbService)).toBeInstanceOf(LabDbService);
    expect(getDb()).toBe(getDb());

    await moduleRef.close();
  });
});
