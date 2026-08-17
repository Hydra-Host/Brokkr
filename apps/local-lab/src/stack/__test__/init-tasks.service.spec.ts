import { NotFoundException } from '@nestjs/common';
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProcessComposeClient } from '../../services/process-compose.client';
import { deriveInitTask, InitTasksService, type InitTaskFacts } from '../init-tasks.service';

const facts = (over: Partial<InitTaskFacts> = {}): InitTaskFacts => ({
  name: 'hub:init',
  logMtimeMs: 2_000,
  statusMtimeMs: null,
  statusCode: null,
  malformedStatus: false,
  ...over,
});

describe('deriveInitTask', () => {
  it('reports pending when both artifacts predate this bring-up', () => {
    const task = deriveInitTask(facts({ logMtimeMs: 500, statusMtimeMs: 600, statusCode: 0 }), 1_000);

    expect(task.state).toBe('pending');
    expect(task.exitCode).toBeNull();
  });

  it('reports running when the log is fresh and no result has landed', () => {
    expect(deriveInitTask(facts({ logMtimeMs: 2_000 }), 1_000).state).toBe('running');
  });

  it('reports completed on a fresh zero status', () => {
    const task = deriveInitTask(facts({ statusMtimeMs: 2_100, statusCode: 0 }), 1_000);

    expect(task.state).toBe('completed');
    expect(task.exitCode).toBe(0);
  });

  it('reports failed with the code and the log tail on a fresh non-zero status', () => {
    const task = deriveInitTask(facts({ statusMtimeMs: 2_100, statusCode: 3, tail: 'boom' }), 1_000);

    expect(task.state).toBe('failed');
    expect(task.exitCode).toBe(3);
    expect(task.detail).toBe('boom');
  });

  it('reports failed for a fresh but unreadable status sidecar', () => {
    const task = deriveInitTask(facts({ statusMtimeMs: 2_100, malformedStatus: true }), 1_000);

    expect(task.state).toBe('failed');
    expect(task.detail).toMatch(/unreadable/);
  });

  it('treats a whole stale generation as pending, never as last boot’s success', () => {
    const task = deriveInitTask(facts({ logMtimeMs: 100, statusMtimeMs: 120, statusCode: 0 }), 5_000);

    expect(task.state).toBe('pending');
  });

  it('reports pending with no socket to date artifacts against', () => {
    expect(deriveInitTask(facts({ statusMtimeMs: 2_100, statusCode: 0 }), null).state).toBe('pending');
  });

  it('prefers a mapped label and falls back to the raw task name', () => {
    expect(deriveInitTask(facts({ name: 'hub:init' }), 1_000).label).toBe('Hub build');
    expect(deriveInitTask(facts({ name: 'future:task' }), 1_000).label).toBe('future:task');
  });
});

describe('InitTasksService', () => {
  let dir: string;
  let socketMtimeMs: number;

  const write = (name: string, body: string, mtimeSec: number): void => {
    const path = join(dir, name);
    writeFileSync(path, body);
    utimesSync(path, mtimeSec, mtimeSec);
  };

  const makeService = () => {
    const pc = {
      taskLogDir: vi.fn(() => dir),
      socketMtimeMs: vi.fn(() => socketMtimeMs),
      tailFileLast: vi.fn(() => 'last line'),
      streamTaskLog: vi.fn(() => of('line\n')),
    };
    return { svc: new InitTasksService(pc as unknown as ProcessComposeClient), pc };
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lab-init-tasks-'));
    socketMtimeMs = 1_000_000;
  });

  it('derives the roster from the on-disk artifacts, in declared order', () => {
    write('apps:init.log', 'a\n', 1_100);
    write('apps:init.status', '0\n', 1_100);
    write('hub:init.log', 'b\n', 1_200);
    const { svc } = makeService();

    expect(svc.list().map((t) => t.name)).toEqual(['apps:init', 'hub:init']);
    expect(svc.list().map((t) => t.state)).toEqual(['completed', 'running']);
  });

  it('orders the roster by the declared dag, not by artifact mtime', () => {
    const declared = [
      'apps:init',
      'hub:init',
      'hub:migrate',
      'sql-seed:notify',
      'spoke:init',
      'sim:seed',
      'redis-acl:seed',
      'zone-crypto:mint-tokens',
      'zone-crypto:seed-bmc',
      'fleet:init',
    ];
    [...declared].reverse().forEach((name, i) => write(`${name}.log`, 'x\n', 1_100 + i));
    const { svc } = makeService();

    expect(svc.list().map((t) => t.name)).toEqual(declared);
  });

  it('holds the order steady when a running task keeps touching its log', () => {
    write('hub:init.log', 'a\n', 1_100);
    write('hub:migrate.log', 'b\n', 1_200);
    write('fleet:init.log', 'c\n', 1_150);
    const { svc } = makeService();
    const before = svc.list().map((t) => t.name);

    write('hub:migrate.log', 'b\nmore\n', 9_000);

    expect(svc.list().map((t) => t.name)).toEqual(before);
    expect(before).toEqual(['hub:init', 'hub:migrate', 'fleet:init']);
  });

  it('appends an unmapped task after every declared one, sorted by name', () => {
    write('zzz:custom.log', 'x\n', 1_050);
    write('aaa:custom.log', 'x\n', 1_060);
    write('fleet:init.log', 'x\n', 1_100);
    write('apps:init.log', 'x\n', 1_100);
    const { svc } = makeService();

    expect(svc.list().map((t) => t.name)).toEqual(['apps:init', 'fleet:init', 'aaa:custom', 'zzz:custom']);
  });

  it('ignores process-compose process logs and non-task files', () => {
    write('hub-api.stdout.log', 'x\n', 1_100);
    write('hub-api.stderr.log', 'x\n', 1_100);
    write('notes.txt', 'x\n', 1_100);
    write('hub:init.log', 'b\n', 1_100);
    const { svc } = makeService();

    expect(svc.list().map((t) => t.name)).toEqual(['hub:init']);
  });

  it('reads a stale-status task as pending rather than last boot’s success', () => {
    write('hub:init.log', 'b\n', 900);
    write('hub:init.status', '0\n', 900);
    const { svc } = makeService();

    expect(svc.list()[0]).toMatchObject({ name: 'hub:init', state: 'pending', exitCode: null });
  });

  it('surfaces a fresh non-zero status as failed with the log tail', () => {
    write('sim:seed.log', 'boom\n', 1_100);
    write('sim:seed.status', '7\n', 1_100);
    const { svc } = makeService();

    expect(svc.list()[0]).toMatchObject({ state: 'failed', exitCode: 7, detail: 'last line' });
  });

  it('surfaces a malformed status file as failed, not completed', () => {
    write('sim:seed.log', 'x\n', 1_100);
    write('sim:seed.status', 'not-a-code\n', 1_100);
    const { svc } = makeService();

    expect(svc.list()[0]).toMatchObject({ state: 'failed', exitCode: null });
  });

  it('returns an empty roster when the log dir does not exist', () => {
    dir = join(dir, 'absent');
    const { svc } = makeService();

    expect(svc.list()).toEqual([]);
  });

  it('streams a task in the derived roster', () => {
    write('fleet:init.log', 'x\n', 1_100);
    const { svc, pc } = makeService();

    svc.streamLog('fleet:init');

    expect(pc.streamTaskLog).toHaveBeenCalledWith('fleet:init');
  });

  it('rejects a name outside the derived roster, including traversal', () => {
    write('fleet:init.log', 'x\n', 1_100);
    const { svc, pc } = makeService();

    for (const name of ['../../../etc/passwd', '/etc/passwd', 'hub:init', '']) {
      expect(() => svc.streamLog(name)).toThrow(NotFoundException);
    }
    expect(pc.streamTaskLog).not.toHaveBeenCalled();
  });

  it('includes fleet:init as one roster entry, not a special case', () => {
    mkdirSync(dir, { recursive: true });
    write('fleet:init.log', 'x\n', 1_100);
    write('fleet:init.status', '0\n', 1_100);
    const { svc } = makeService();

    expect(svc.list()).toHaveLength(1);
    expect(svc.list()[0]).toMatchObject({ name: 'fleet:init', label: 'Fleet artifacts', state: 'completed' });
  });

  describe('summary', () => {
    it('reports failed with the failed task as current, outranking a task still running', () => {
      write('apps:init.log', 'a\n', 1_100);
      write('apps:init.status', '0\n', 1_100);
      write('hub:init.log', 'boom\n', 1_150);
      write('hub:init.status', '7\n', 1_150);
      write('sim:seed.log', 'x\n', 1_200);
      const { svc } = makeService();

      expect(svc.summary()).toEqual({ state: 'failed', total: 3, completed: 1, failed: 1, current: 'Hub build' });
    });

    it('reports running with the running task as current when nothing has failed', () => {
      write('apps:init.log', 'a\n', 1_100);
      write('apps:init.status', '0\n', 1_100);
      write('hub:init.log', 'b\n', 1_200);
      const { svc } = makeService();

      expect(svc.summary()).toEqual({ state: 'running', total: 2, completed: 1, failed: 0, current: 'Hub build' });
    });

    it('reports completed with no current when every task exited 0', () => {
      write('apps:init.log', 'a\n', 1_100);
      write('apps:init.status', '0\n', 1_100);
      write('hub:init.log', 'b\n', 1_150);
      write('hub:init.status', '0\n', 1_150);
      const { svc } = makeService();

      expect(svc.summary()).toEqual({ state: 'completed', total: 2, completed: 2, failed: 0, current: null });
    });

    it('reports pending on an empty roster', () => {
      dir = join(dir, 'absent');
      const { svc } = makeService();

      expect(svc.summary()).toEqual({ state: 'pending', total: 0, completed: 0, failed: 0, current: null });
    });
  });
});
