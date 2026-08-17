import { ConflictException } from '@nestjs/common';
import { Subject } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execFileMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (orig) => ({
  ...(await orig<typeof import('node:child_process')>()),
  execFile: (...a: unknown[]) => execFileMock(...a),
}));

import { type RunSection, type RunStatus } from '../../contract';
import { type RunState } from '../../runner/runner.service';
import { FleetOpRegistry } from '../fleet-op-registry';
import { FleetVerifyService } from '../fleet-verify.service';

const HEALTHY = JSON.stringify({
  status: 'healthy',
  mode: 'vm',
  findings: [],
  summary: { checked: 2, ok: 2, findings: 0 },
});

const FINDINGS = JSON.stringify({
  status: 'findings',
  mode: 'vm',
  findings: [{ node: 'cpu-1', kind: 'ipmi-sim-down', healable: true, detail: 'ipmi_sim (BMC) is down' }],
  summary: { checked: 2, ok: 1, findings: 1 },
});

type StackRunEntry = {
  runId: string;
  section: RunSection;
  opId: string;
  label: string;
  status: RunStatus;
  startedAt: number;
  exitCode: number | null;
};

function makeRunner(stackRuns: StackRunEntry[] = []) {
  return {
    repoRoot: '/repo',
    list: vi.fn((section?: RunSection) => (section === 'stack' ? stackRuns : [])),
    create: vi.fn(
      (opts: { section: RunSection; opId: string; label: string }): RunState => ({
        runId: `run-${opts.label}`,
        section: opts.section,
        opId: opts.opId,
        label: opts.label,
        status: 'running',
        startedAt: 1,
        exitCode: null,
        log$: new Subject<string>(),
        lines: [],
        bytes: 0,
        nodeIndex: null,
      }),
    ),
    spawnPty: vi.fn(() => Promise.resolve(0)),
    emit: vi.fn(),
    finalize: vi.fn(),
  };
}

function makeVerify(runner: ReturnType<typeof makeRunner>, registry?: FleetOpRegistry) {
  const reg = registry ?? new FleetOpRegistry(runner as never);
  return new FleetVerifyService(runner as never, reg);
}

describe('FleetVerifyService.verify', () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });
  afterEach(() => vi.clearAllMocks());

  it('parses the report from stdout when verify exits 2 (findings are not an error)', async () => {
    execFileMock.mockImplementation((_c, _a, _o, cb) =>
      cb(Object.assign(new Error('exit 2'), { code: 2, stdout: FINDINGS, stderr: '' })),
    );
    const report = await makeVerify(makeRunner()).verify();
    expect(report.status).toBe('findings');
    expect(report.findings[0].kind).toBe('ipmi-sim-down');
  });

  it('serves a second verify from the 5s TTL cache without a second python spawn', async () => {
    execFileMock.mockImplementation((_c, _a, _o, cb) => cb(null, { stdout: HEALTHY, stderr: '' }));
    const svc = makeVerify(makeRunner());
    await svc.verify();
    await svc.verify();
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it('throws when the engine emits malformed JSON', async () => {
    execFileMock.mockImplementation((_c, _a, _o, cb) => cb(null, { stdout: 'not json', stderr: '' }));
    await expect(makeVerify(makeRunner()).verify()).rejects.toThrow();
  });

  it('rethrows the original engine error for a genuine failure even when stdout carries noise', async () => {
    execFileMock.mockImplementation((_c, _a, _o, cb) =>
      cb(Object.assign(new Error('engine exploded'), { code: 1, stdout: 'Traceback: not json', stderr: 'boom' })),
    );
    await expect(makeVerify(makeRunner()).verify()).rejects.toThrow('engine exploded');
  });
});

describe('FleetVerifyService.heal', () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });
  afterEach(() => vi.clearAllMocks());

  it('recomputes verify after a heal invalidates the cache', async () => {
    execFileMock.mockImplementation((_c, _a, _o, cb) => cb(null, { stdout: HEALTHY, stderr: '' }));
    const runner = makeRunner();
    const svc = makeVerify(runner);
    await svc.verify();
    expect(execFileMock).toHaveBeenCalledTimes(1);

    svc.heal();
    await vi.waitFor(() => expect(runner.finalize).toHaveBeenCalled());

    await svc.verify();
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });

  it('re-runs verify for the post-heal snapshot when a heal invalidates the cache mid-flight', async () => {
    const runner = makeRunner();
    const svc = makeVerify(runner);
    let pendingCb: ((e: unknown, r: unknown) => void) | null = null;
    execFileMock
      .mockImplementationOnce((_c: unknown, _a: unknown, _o: unknown, cb: (e: unknown, r: unknown) => void) => {
        pendingCb = cb;
      })
      .mockImplementation((_c, _a, _o, cb) => cb(null, { stdout: HEALTHY, stderr: '' }));

    const pending = svc.verify();
    await vi.waitFor(() => expect(pendingCb).not.toBeNull());

    svc.heal();
    await vi.waitFor(() => expect(runner.finalize).toHaveBeenCalled());

    pendingCb!(null, { stdout: FINDINGS, stderr: '' });
    const report = await pending;

    expect(report.status).toBe('healthy');
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });

  it('propagates a 409 when the fleet lease is already held', () => {
    const runner = makeRunner();
    const registry = new FleetOpRegistry(runner as never);
    registry.acquire({ kind: 'fleet' }, 'reset cpu-1');
    const svc = makeVerify(runner, registry);

    expect(() => svc.heal()).toThrow(ConflictException);
    expect(runner.create).not.toHaveBeenCalled();
  });

  it('releases the fleet lease after a spawn failure so a fresh heal succeeds', async () => {
    const runner = makeRunner();
    runner.spawnPty = vi.fn(() => Promise.reject(new Error('boom')));
    const svc = makeVerify(runner);

    svc.heal();
    await vi.waitFor(() => expect(runner.finalize).toHaveBeenCalled());

    expect(() => svc.heal()).not.toThrow();
  });
});
