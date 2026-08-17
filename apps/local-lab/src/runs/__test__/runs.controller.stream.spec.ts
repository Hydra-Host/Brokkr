import { NotFoundException } from '@nestjs/common';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { firstValueFrom, toArray } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { streamPaths } from '../../contract';
import { closeDb } from '../../db/db';
import { RunLedgerService } from '../../ledger/run-ledger.service';
import { RunLogStore } from '../../ledger/run-log-store';
import { RunStore } from '../../ledger/run-store';
import { RunnerService } from '../../runner/runner.service';
import { RunsController } from '../runs.controller';
import { RunsService } from '../runs.service';

vi.mock('../../results-root', async (importOriginal) => {
  vi.stubEnv('LOCAL_BROKKR_ALLURE', mkdtempSync(join(tmpdir(), 'lab-runs-ctrl-results-')));
  return importOriginal<typeof import('../../results-root')>();
});

let stateDir: string;
let logs: RunLogStore;
let runner: RunnerService;
let ctrl: RunsController;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'lab-runs-ctrl-'));
  vi.stubEnv('LOCAL_STATE', stateDir);
  const rows = new RunStore();
  logs = new RunLogStore();
  runner = new RunnerService(new RunLedgerService(rows, logs));
  ctrl = new RunsController(new RunsService(runner, rows, logs));
});

afterEach(() => {
  logs.onApplicationShutdown();
  closeDb();
  vi.unstubAllEnvs();
  rmSync(stateDir, { recursive: true, force: true });
});

describe('GET /api/runs/:runId/stream', () => {
  it('replays the persisted log of a run the runner no longer holds, then sends the done sentinel', async () => {
    const run = runner.create({ section: 'fleet', opId: 'reset', label: 'reset cpu-1' });
    runner.emit(run, 'wiping cpu-1\r\n');
    runner.finalize(run, 0);
    await vi.waitFor(() => expect(logs.read(run.runId)).toContain('wiping cpu-1'));
    runner.remove(run.runId);

    const frames = await firstValueFrom(ctrl.stream(run.runId).pipe(toArray()));

    expect(frames).toEqual([{ data: { line: 'wiping cpu-1\r\n' } }, { data: { done: true } }]);
  });

  it('404s the traversal that express hands the route once it decodes %2F', () => {
    writeFileSync(join(stateDir, 'secret.log'), 'secret');
    const path = streamPaths.run('../../secret');

    expect(path).toBe('/api/runs/..%2F..%2Fsecret/stream');
    const decoded = decodeURIComponent(path.slice('/api/runs/'.length, -'/stream'.length));

    expect(decoded).toBe('../../secret');
    expect(() => ctrl.stream(decoded)).toThrow(NotFoundException);
  });
});
