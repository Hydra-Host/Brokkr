import * as pty from 'node-pty';
import { describe, expect, it, vi } from 'vitest';

import { NULL_RUN_SINK, type RunSink } from '../run-sink';
import { runBacklog, RunnerService } from '../runner.service';

vi.mock('node-pty', () => ({ spawn: vi.fn() }));

const MARKER = '[... earlier output truncated ...]\r\n';

describe('runBacklog', () => {
  it('prepends the marker only for truncated runs', () => {
    expect(runBacklog({ lines: ['a', 'b'], truncated: true })).toBe(`${MARKER}ab`);
    expect(runBacklog({ lines: ['a', 'b'] })).toBe('ab');
  });
});

describe('RunnerService.spawnPty childPid tracking', () => {
  it('records the pty pid during the run and clears it on exit', async () => {
    let exitCb: ((e: { exitCode: number; signal?: number }) => void) | undefined;
    const fake = {
      pid: 4242,
      onData: vi.fn(),
      onExit: vi.fn((cb: (e: { exitCode: number; signal?: number }) => void) => {
        exitCb = cb;
      }),
      kill: vi.fn(),
      write: vi.fn(),
      resize: vi.fn(),
    };
    vi.mocked(pty.spawn).mockReturnValue(fake as unknown as ReturnType<typeof pty.spawn>);
    const svc = new RunnerService(NULL_RUN_SINK);
    const run = svc.create({ section: 'test', opId: 'smoke', label: 'pty-pid' });

    const exit = svc.spawnPty(run, 'npx', ['vitest']);

    expect(run.childPid).toBe(4242);
    exitCb?.({ exitCode: 0 });
    await expect(exit).resolves.toBe(0);
    expect(run.childPid).toBeUndefined();
  });
});

describe('RunnerService log ring', () => {
  it('trims from the front past the byte cap and prepends the truncation marker', () => {
    const svc = new RunnerService(NULL_RUN_SINK);
    const run = svc.create({ section: 'test', opId: 'smoke', label: 'ring' });
    svc.emit(run, `early${'x'.repeat(256 * 1024)}`);
    for (let i = 0; i < 9; i += 1) svc.emit(run, `chunk-${i}${'y'.repeat(256 * 1024)}`);

    expect(run.truncated).toBe(true);
    expect(run.bytes).toBeLessThanOrEqual(2 * 1024 * 1024);
    const { backlog } = svc.stream(run.runId);
    expect(backlog.startsWith(MARKER)).toBe(true);
    expect(backlog).not.toContain('early');
    expect(backlog).toContain('chunk-8');
  });

  it('keeps the full backlog with no marker under the cap', () => {
    const svc = new RunnerService(NULL_RUN_SINK);
    const run = svc.create({ section: 'test', opId: 'smoke', label: 'small' });
    svc.emit(run, 'hello ');
    svc.emit(run, 'world');

    expect(run.truncated).toBeUndefined();
    expect(run.bytes).toBe('hello world'.length);
    expect(svc.stream(run.runId).backlog).toBe('hello world');
  });
});

describe('RunnerService.prune', () => {
  it('keeps the most recently finished runs of the section and never touches running or other sections', () => {
    const svc = new RunnerService(NULL_RUN_SINK);
    const oldest = svc.create({ section: 'test', opId: 'smoke', label: 't1' });
    const older = svc.create({ section: 'test', opId: 'smoke', label: 't2' });
    const newer = svc.create({ section: 'test', opId: 'smoke', label: 't3' });
    const newest = svc.create({ section: 'test', opId: 'smoke', label: 't4' });
    const running = svc.create({ section: 'test', opId: 'smoke', label: 'running' });
    const otherSection = svc.create({ section: 'build', opId: 'build-agent', label: 'b1' });
    for (const run of [oldest, older, newer, newest, otherSection]) svc.finalize(run, 0);

    svc.prune('test', 2);

    expect(svc.getRun(oldest.runId)).toBeUndefined();
    expect(svc.getRun(older.runId)).toBeUndefined();
    expect(svc.getRun(newer.runId)).toBeDefined();
    expect(svc.getRun(newest.runId)).toBeDefined();
    expect(svc.getRun(running.runId)).toBeDefined();
    expect(svc.getRun(otherSection.runId)).toBeDefined();
  });

  it('retains a long run that started first but finished last', () => {
    const svc = new RunnerService(NULL_RUN_SINK);
    const long = svc.create({ section: 'test', opId: 'smoke', label: 'long' });
    const quick = svc.create({ section: 'test', opId: 'smoke', label: 'quick' });
    svc.finalize(quick, 0);
    svc.finalize(long, 0);

    svc.prune('test', 1);

    expect(svc.getRun(long.runId)).toBeDefined();
    expect(svc.getRun(quick.runId)).toBeUndefined();
  });
});

describe('RunnerService.finalize eviction', () => {
  it('evicts terminal runs of the section beyond the in-memory cap', () => {
    const svc = new RunnerService(NULL_RUN_SINK);
    const runs = Array.from({ length: 25 }, (_, i) => svc.create({ section: 'test', opId: 'smoke', label: `t${i}` }));
    const running = svc.create({ section: 'test', opId: 'smoke', label: 'still-running' });
    const otherSection = svc.create({ section: 'build', opId: 'build-agent', label: 'b0' });
    svc.finalize(otherSection, 0);

    for (const run of runs) svc.finalize(run, 0);

    expect(runs.slice(0, 5).map((r) => svc.getRun(r.runId))).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    expect(runs.slice(5).every((r) => svc.getRun(r.runId) !== undefined)).toBe(true);
    expect(svc.getRun(running.runId)).toBeDefined();
    expect(svc.getRun(otherSection.runId)).toBeDefined();
  });
});

describe('RunnerService.cancel before the child starts', () => {
  it('marks the run cancelled and refuses to spawn', async () => {
    const svc = new RunnerService(NULL_RUN_SINK);
    const run = svc.create({ section: 'test', opId: 'smoke', label: 'pre-spawn' });

    expect(svc.cancel(run.runId)).toBe(false);
    expect(run.cancelled).toBe(true);

    await expect(svc.spawn(run, 'node', ['-e', 'process.exit(0)'])).resolves.toBeNull();
    expect(run.childPid).toBeUndefined();

    svc.finalize(run, null);
    expect(run.status).toBe('cancelled');
  });
});

describe('RunnerService with a throwing sink', () => {
  it('creates, emits and finalizes a run regardless', () => {
    const boom = (): never => {
      throw new Error('ledger down');
    };
    const sink: RunSink = { onCreate: boom, onSpawn: boom, onOutput: boom, onFinalize: boom };
    const svc = new RunnerService(sink);

    const run = svc.create({ section: 'test', opId: 'smoke', label: 'throwing-sink' });

    expect(run.runId).toBeTruthy();
    expect(() => svc.emit(run, 'hello')).not.toThrow();
    expect(() => svc.finalize(run, 0)).not.toThrow();
    expect(run.status).toBe('passed');
    expect(svc.stream(run.runId).backlog).toBe('hello');
  });

  it('spawns despite a throwing onSpawn', async () => {
    const sink: RunSink = {
      onCreate: () => undefined,
      onSpawn: () => {
        throw new Error('ledger down');
      },
      onOutput: () => undefined,
      onFinalize: () => undefined,
    };
    const svc = new RunnerService(sink);
    const run = svc.create({ section: 'test', opId: 'smoke', label: 'throwing-onspawn' });

    await expect(svc.spawn(run, 'node', ['-e', ''])).resolves.toBe(0);
  });
});

describe('RunnerService.spawn childPid tracking', () => {
  it('records the child pid during the run and clears it on exit', async () => {
    const svc = new RunnerService(NULL_RUN_SINK);
    const run = svc.create({ section: 'test', opId: 'smoke', label: 'pid' });

    const exit = svc.spawn(run, 'node', ['-e', '']);

    expect(run.childPid).toBeGreaterThan(0);
    await expect(exit).resolves.toBe(0);
    expect(run.childPid).toBeUndefined();
  });
});
