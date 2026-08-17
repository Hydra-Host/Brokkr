import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RESTART_STALE_AFTER_MS } from '@repo/local-lab-contract';
import { NULL_RUN_SINK } from '../../runner/run-sink';
import { RunnerService, type RunState } from '../../runner/runner.service';
import { SudoService } from '../../sudo/sudo.service';
import { restartChain, restartScript, restartStatus, StackRestartService } from '../stack-restart.service';

const { spawnMock, execFileMock } = vi.hoisted(() => ({ spawnMock: vi.fn(), execFileMock: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: spawnMock,
  execFile: execFileMock,
}));

type ChildHandler = (...args: unknown[]) => void;
const buildFakeChild = () => {
  const handlers = new Map<string, ChildHandler>();
  const child = {
    on: (event: string, cb: ChildHandler) => {
      handlers.set(event, cb);
      return child;
    },
    once: (event: string, cb: ChildHandler) => {
      handlers.set(event, cb);
      return child;
    },
    unref: vi.fn(),
  };
  return { child, handlers };
};
const inertChild = () => buildFakeChild().child;
const fakeChild = (event: string, ...args: unknown[]) => {
  const { child, handlers } = buildFakeChild();
  setImmediate(() => handlers.get(event)?.(...args));
  return child;
};

const unreachableSocket = () =>
  execFileMock.mockImplementation(
    (_bin: string, _args: string[], _opts: object, cb: (e: Error | null) => void) => void cb(new Error('no server')),
  );
const liveSocket = () =>
  execFileMock.mockImplementation(
    (_bin: string, _args: string[], _opts: object, cb: (e: Error | null, out: object) => void) =>
      void cb(null, { stdout: '{}', stderr: '' }),
  );

let stateDir: string;
let runtimeDir: string;

function makeService() {
  const sudo = new SudoService();
  vi.spyOn(sudo, 'preflight').mockResolvedValue({ ok: true });
  const runner = new RunnerService(NULL_RUN_SINK);
  return { svc: new StackRestartService(sudo, runner), sudo, runner };
}

const newRun = (runner: RunnerService, opId: string): RunState =>
  runner.create({ section: 'stack', opId, label: opId });

const spawnScript = (): string => String((spawnMock.mock.calls[0][1] as string[])[1]);

beforeEach(() => {
  spawnMock.mockReset();
  execFileMock.mockReset();
  unreachableSocket();
  stateDir = mkdtempSync(join(tmpdir(), 'lab-restart-state-'));
  runtimeDir = join(mkdtempSync(join(tmpdir(), 'lab-restart-rt-')), 'devenv-self');
  mkdirSync(runtimeDir, { recursive: true });
  vi.stubEnv('DEVENV_STATE', stateDir);
  vi.stubEnv('DEVENV_ROOT', mkdtempSync(join(tmpdir(), 'lab-restart-root-')));
  vi.stubEnv('DEVENV_RUNTIME', runtimeDir);
  vi.stubEnv('PC_SOCKET_PATH', join(runtimeDir, 'pc.sock'));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('restartChain', () => {
  it.each([
    [undefined, 'stack-down; stack-up'],
    ['stack-wipe-data' as const, 'stack-down; stack-await-down && stack-wipe-data; stack-up'],
    ['stack-reset' as const, 'stack-reset; stack-up'],
    ['stack-purge' as const, 'stack-purge; stack-up'],
    ['stack-reslot' as const, 'stack-reslot; stack-up'],
  ])('reads %s as the exact chain, gate included, `;` before stack-up', (wipe, chain) => {
    expect(restartChain(wipe)).toBe(chain);
  });

  it('never gates stack-down with && — its body cannot fail, so && would imply a guarantee', () => {
    expect(restartChain('stack-wipe-data')).not.toContain('stack-down &&');
  });
});

describe('restartScript', () => {
  const exitPath = '/state/lab-restart.exit';

  it('reports the wipe stage over the bring-up so a refused wipe cannot read as clean', () => {
    expect(restartScript('stack-wipe-data', exitPath)).toBe(
      'sleep 2; stack-down; stack-await-down && stack-wipe-data; wipe=$?; stack-up; up=$?;' +
        ' printf \'%s\\n\' "$(( wipe != 0 ? wipe : up ))" >>"$LAB_RESTART_EXIT"',
    );
  });

  it('reports only the bring-up when there is no wipe stage', () => {
    expect(restartScript(undefined, exitPath)).toBe(
      'sleep 2; stack-down; stack-up; up=$?; printf \'%s\\n\' "$up" >>"$LAB_RESTART_EXIT"',
    );
  });

  it('omits the sidecar write when there is no state dir to write it to', () => {
    expect(restartScript('stack-reset', null)).toBe('sleep 2; stack-reset; wipe=$?; stack-up; up=$?');
  });
});

describe('StackRestartService — spawn shape', () => {
  it('spawns the script through bash, detached, with the sidecar path in the env', async () => {
    const { svc, runner } = makeService();
    const child = inertChild();
    spawnMock.mockReturnValue(child);

    await svc.restartStackDetached(newRun(runner, 'reset'), { reason: 'r', wipe: 'stack-reset' });

    expect(spawnMock.mock.calls[0][0]).toBe('bash');
    expect(spawnScript()).toBe(restartScript('stack-reset', join(stateDir, 'lab-restart.exit')));
    const opts = spawnMock.mock.calls[0][2] as { env: Record<string, string>; detached: boolean; stdio: unknown[] };
    expect(opts.detached).toBe(true);
    expect(opts.env.LAB_RESTART_EXIT).toBe(join(stateDir, 'lab-restart.exit'));
    expect(child.unref).toHaveBeenCalled();
  });

  it("sends the child's stdout AND stderr to the restart log, so a gate refusal is readable", async () => {
    const { svc, runner } = makeService();
    spawnMock.mockReturnValue(inertChild());

    await svc.restartStackDetached(newRun(runner, 'reinit'), { reason: 'r', wipe: 'stack-wipe-data' });

    const { stdio } = spawnMock.mock.calls[0][2] as { stdio: [unknown, number, number] };
    expect(typeof stdio[1]).toBe('number');
    expect(stdio[2]).toBe(stdio[1]);
  });

  it('bounds the child nowhere — the wipe gate is allowed its full 60s before refusing', async () => {
    const { svc, runner } = makeService();
    spawnMock.mockReturnValue(inertChild());

    await svc.restartStackDetached(newRun(runner, 'reinit'), { reason: 'r', wipe: 'stack-wipe-data' });

    expect(spawnMock.mock.calls[0][2]).not.toHaveProperty('timeout');
    expect(spawnMock.mock.calls[0][2]).not.toHaveProperty('signal');
  });

  it('logs the readable chain, not the status-capture plumbing', async () => {
    const { svc, runner } = makeService();
    spawnMock.mockReturnValue(inertChild());
    const run = newRun(runner, 'reinit');

    await svc.restartStackDetached(run, { reason: 'reinit', wipe: 'stack-wipe-data' });

    expect(run.lines.join('')).toContain(restartChain('stack-wipe-data'));
    expect(run.lines.join('')).not.toContain('wipe=$?');
  });
});

describe('restartScript executed by a real bash', () => {
  let workDir: string;
  let orderFile: string;
  let exitFile: string;
  let codes: Record<string, number>;

  const prelude = (): string =>
    Object.entries(codes)
      .map(([name, code]) => `${name}() { printf '%s\\n' '${name}' >>"${orderFile}"; return ${code}; }`)
      .join('\n');

  const run = (wipe: Parameters<typeof restartScript>[0]): { order: string[]; exit: string } => {
    execFileSync('bash', ['-c', `${prelude()}\n${restartScript(wipe, exitFile)}`], {
      env: { LAB_RESTART_EXIT: exitFile, PATH: process.env.PATH ?? '' },
    });
    return {
      order: readFileSync(orderFile, 'utf8').trim().split('\n').filter(Boolean),
      exit: readFileSync(exitFile, 'utf8').trim(),
    };
  };

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'lab-restart-bash-'));
    orderFile = join(workDir, 'order.txt');
    exitFile = join(workDir, 'exit.txt');
    writeFileSync(orderFile, '');
    writeFileSync(exitFile, '');
    codes = {
      sleep: 0,
      'stack-down': 0,
      'stack-await-down': 0,
      'stack-wipe-data': 0,
      'stack-up': 0,
      'stack-reset': 0,
    };
  });

  it('skips the wipe but still brings the stack up when the down-gate refuses', () => {
    codes['stack-await-down'] = 1;

    const { order, exit } = run('stack-wipe-data');

    expect(order).toEqual(['sleep', 'stack-down', 'stack-await-down', 'stack-up']);
    expect(order).not.toContain('stack-wipe-data');
    expect(exit).toBe('1');
  });

  it('wipes only after the gate confirms the stack is down', () => {
    const { order, exit } = run('stack-wipe-data');

    expect(order).toEqual(['sleep', 'stack-down', 'stack-await-down', 'stack-wipe-data', 'stack-up']);
    expect(exit).toBe('0');
  });

  it('still wipes when stack-down itself fails — only the gate decides', () => {
    codes['stack-down'] = 1;

    expect(run('stack-wipe-data').order).toContain('stack-wipe-data');
  });

  it('reports the wipe failure even though the bring-up succeeded', () => {
    codes['stack-wipe-data'] = 2;

    const { order, exit } = run('stack-wipe-data');

    expect(order).toContain('stack-up');
    expect(exit).toBe('2');
  });

  it('reports a failed bring-up when the wipe succeeded', () => {
    codes['stack-up'] = 3;

    expect(run('stack-wipe-data').exit).toBe('3');
  });

  it('reports a refused stack-reset and still brings the stack up', () => {
    codes['stack-reset'] = 1;

    const { order, exit } = run('stack-reset');

    expect(order).toEqual(['sleep', 'stack-reset', 'stack-up']);
    expect(exit).toBe('1');
  });
});

describe('StackRestartService — finalization ownership', () => {
  it('never finalizes a launched child: the run is still running at detach', async () => {
    const { svc, runner } = makeService();
    spawnMock.mockReturnValue(fakeChild('spawn'));
    const run = newRun(runner, 'reinit');

    await svc.restartStackDetached(run, { reason: 'r', wipe: 'stack-wipe-data' });
    await new Promise((r) => setTimeout(r, 5));

    expect(run.status).toBe('running');
    expect(run.exitCode).toBeNull();
  });

  it('finalizes 1 and clears the marker on a launch error', async () => {
    const { svc, runner } = makeService();
    spawnMock.mockReturnValue(fakeChild('error', new Error('bash not found')));
    const run = newRun(runner, 'reinit');

    await svc.restartStackDetached(run, { reason: 'r', wipe: 'stack-wipe-data' });
    await new Promise((r) => setTimeout(r, 5));

    expect(run.status).toBe('failed');
    expect(existsSync(join(stateDir, 'lab-restart.json'))).toBe(false);
    expect(run.lines.join('')).toMatch(/failed to launch/);
  });

  it('finalizes 1 on a non-zero exit and runs the caller hook', async () => {
    const { svc, runner } = makeService();
    spawnMock.mockReturnValue(fakeChild('exit', 1, null));
    const onLaunchFailure = vi.fn();
    const run = newRun(runner, 'reinit');

    await svc.restartStackDetached(run, { reason: 'r', wipe: 'stack-wipe-data', onLaunchFailure });
    await new Promise((r) => setTimeout(r, 5));

    expect(run.status).toBe('failed');
    expect(onLaunchFailure).toHaveBeenCalledTimes(1);
  });
});

describe('StackRestartService — refusals', () => {
  it('refuses when sudo -n is unavailable, without spawning', async () => {
    const { svc, runner, sudo } = makeService();
    vi.mocked(sudo.preflight).mockResolvedValue({ ok: false, reason: 'sudo -n is unavailable' });
    const run = newRun(runner, 'reinit');

    await svc.restartStackDetached(run, { reason: 'r', wipe: 'stack-wipe-data' });

    expect(spawnMock).not.toHaveBeenCalled();
    expect(run.status).toBe('failed');
    expect(run.lines.join('')).toMatch(/pre-flight failed: sudo -n is unavailable/);
  });

  it('refuses on sudoers drift, without spawning', async () => {
    const { svc, runner, sudo } = makeService();
    vi.mocked(sudo.preflight).mockResolvedValue({ ok: false, reason: 'the drop-in is stale' });
    const run = newRun(runner, 'reset');

    await svc.restartStackDetached(run, { reason: 'r', wipe: 'stack-reset' });

    expect(spawnMock).not.toHaveBeenCalled();
    expect(run.lines.join('')).toMatch(/the drop-in is stale/);
  });

  it('rejects a concurrent call while a restart is in flight', async () => {
    const { svc, runner } = makeService();
    spawnMock.mockReturnValue(inertChild());
    await svc.restartStackDetached(newRun(runner, 'reinit'), { reason: 'r', wipe: 'stack-wipe-data' });
    const second = newRun(runner, 'reset');

    await svc.restartStackDetached(second, { reason: 'r', wipe: 'stack-reset' });

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(second.status).toBe('failed');
    expect(second.lines.join('')).toMatch(/already in flight/);
  });

  it('does not detach behind a cancelled run', async () => {
    const { svc, runner } = makeService();
    const run = newRun(runner, 'reinit');
    run.cancelled = true;
    runner.finalize(run, null);

    await svc.restartStackDetached(run, { reason: 'r', wipe: 'stack-wipe-data' });

    expect(spawnMock).not.toHaveBeenCalled();
    expect(run.status).toBe('cancelled');
  });

  it('refuses a reset while a sibling checkout answers on its own socket', async () => {
    const { svc, runner } = makeService();
    const sibling = join(runtimeDir, '..', 'devenv-other');
    mkdirSync(sibling, { recursive: true });
    writeFileSync(join(sibling, 'pc.sock'), '');
    liveSocket();
    const run = newRun(runner, 'reset');

    await svc.restartStackDetached(run, { reason: 'r', wipe: 'stack-reset' });

    expect(spawnMock).not.toHaveBeenCalled();
    expect(run.status).toBe('failed');
    expect(run.lines.join('')).toMatch(/another checkout's stack is live/);
  });

  it('proceeds for a reinit even with a live sibling — it wipes nothing host-global', async () => {
    const { svc, runner } = makeService();
    const sibling = join(runtimeDir, '..', 'devenv-other');
    mkdirSync(sibling, { recursive: true });
    writeFileSync(join(sibling, 'pc.sock'), '');
    liveSocket();
    spawnMock.mockReturnValue(inertChild());

    await svc.restartStackDetached(newRun(runner, 'reinit'), { reason: 'r', wipe: 'stack-wipe-data' });

    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('never mistakes its own live socket for a sibling', async () => {
    const { svc, runner } = makeService();
    writeFileSync(join(runtimeDir, 'pc.sock'), '');
    liveSocket();
    spawnMock.mockReturnValue(inertChild());

    await svc.restartStackDetached(newRun(runner, 'purge'), { reason: 'r', wipe: 'stack-purge' });

    expect(spawnMock).toHaveBeenCalledTimes(1);
  });
});

describe('StackRestartService — marker + restart state', () => {
  it('writes the marker before the spawn', async () => {
    const { svc, runner } = makeService();
    let markerAtSpawn: string | null = null;
    spawnMock.mockImplementation(() => {
      markerAtSpawn = readFileSync(join(stateDir, 'lab-restart.json'), 'utf8');
      return inertChild();
    });
    const run = newRun(runner, 'reinit');

    await svc.restartStackDetached(run, { reason: 'reinit (nuke + rebuild)', wipe: 'stack-wipe-data' });

    expect(markerAtSpawn).toBeTruthy();
    expect(JSON.parse(String(markerAtSpawn))).toMatchObject({
      opId: 'reinit',
      runId: run.runId,
      reason: 'reinit (nuke + rebuild)',
      wipe: 'stack-wipe-data',
      logPath: join(stateDir, 'lab-restart.log'),
    });
  });

  it('reports idle with no marker', () => {
    const { svc } = makeService();
    expect(svc.restartState()).toEqual({ status: 'idle' });
  });

  it('reports the pending restart with its reason and log path', async () => {
    const { svc, runner } = makeService();
    spawnMock.mockReturnValue(inertChild());

    await svc.restartStackDetached(newRun(runner, 'purge'), { reason: 'purge', wipe: 'stack-purge' });

    expect(svc.restartState()).toMatchObject({
      status: 'pending',
      opId: 'purge',
      reason: 'purge',
      logPath: join(stateDir, 'lab-restart.log'),
    });
  });

  it('ignores a malformed marker rather than reporting a half-read restart', () => {
    const { svc } = makeService();
    writeFileSync(join(stateDir, 'lab-restart.json'), '{"opId":');

    expect(svc.restartState()).toEqual({ status: 'idle' });
  });

  it('ignores a malformed exit sidecar and keeps reporting pending', async () => {
    const { svc, runner } = makeService();
    spawnMock.mockReturnValue(inertChild());
    await svc.restartStackDetached(newRun(runner, 'reinit'), { reason: 'reinit', wipe: 'stack-wipe-data' });
    writeFileSync(join(stateDir, 'lab-restart.exit'), 'not-a-code\n');

    expect(svc.restartState().status).toBe('pending');
  });

  it('reports a non-zero child exit as failed, with the log path', async () => {
    const { svc, runner } = makeService();
    spawnMock.mockReturnValue(inertChild());
    await svc.restartStackDetached(newRun(runner, 'reinit'), { reason: 'reinit', wipe: 'stack-wipe-data' });
    writeFileSync(join(stateDir, 'lab-restart.exit'), '2\n');

    expect(svc.restartState()).toMatchObject({ status: 'failed', logPath: join(stateDir, 'lab-restart.log') });
  });
});

describe('restartStatus', () => {
  it('is idle only for a clean completion, and failed for any non-zero', () => {
    expect(restartStatus(0, 1_000)).toBe('idle');
    expect(restartStatus(1, 1_000)).toBe('failed');
    expect(restartStatus(2, RESTART_STALE_AFTER_MS + 60_000)).toBe('failed');
  });

  it('never returns a status that hides a failure behind an age check', () => {
    expect(restartStatus(1, 0)).toBe('failed');
    expect(restartStatus(null, 0)).toBe('pending');
    expect(restartStatus(null, RESTART_STALE_AFTER_MS + 60_000)).toBe('stale');
  });
});

describe('StackRestartService — marker sweeper', () => {
  const sweep = (svc: StackRestartService): void =>
    (svc as unknown as { sweepMarker: () => void }).sweepMarker();
  const detach = async (svc: StackRestartService, runner: RunnerService) => {
    spawnMock.mockReturnValue(inertChild());
    await svc.restartStackDetached(newRun(runner, 'reinit'), { reason: 'reinit', wipe: 'stack-wipe-data' });
  };
  const secondAttempt = async (svc: StackRestartService, runner: RunnerService): Promise<RunState> => {
    const run = newRun(runner, 'reinit');
    await svc.restartStackDetached(run, { reason: 'reinit', wipe: 'stack-wipe-data' });
    return run;
  };

  it('does not clear the marker or release the latch in the pre-teardown window', async () => {
    const { svc, runner } = makeService();
    await detach(svc, runner);
    spawnMock.mockClear();

    sweep(svc);

    expect(svc.restartState().status).toBe('pending');
    expect((await secondAttempt(svc, runner)).status).toBe('failed');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('keeps holding the latch across many sweeps while the child has not reported', async () => {
    const { svc, runner } = makeService();
    await detach(svc, runner);
    spawnMock.mockClear();

    for (let i = 0; i < 20; i++) sweep(svc);

    expect(svc.restartState().status).toBe('pending');
    expect((await secondAttempt(svc, runner)).lines.join('')).toMatch(/already in flight/);
  });

  it('retires the marker and releases the latch on a clean child exit', async () => {
    const { svc, runner } = makeService();
    await detach(svc, runner);
    writeFileSync(join(stateDir, 'lab-restart.exit'), '0\n');

    sweep(svc);

    expect(svc.restartState()).toEqual({ status: 'idle' });
    expect(existsSync(join(stateDir, 'lab-restart.json'))).toBe(false);
    expect(existsSync(join(stateDir, 'lab-restart.exit'))).toBe(false);
    spawnMock.mockClear();
    spawnMock.mockReturnValue(inertChild());
    expect((await secondAttempt(svc, runner)).status).toBe('running');
  });

  it('keeps a failure reportable but releases the latch so a retry is possible', async () => {
    const { svc, runner } = makeService();
    await detach(svc, runner);
    writeFileSync(join(stateDir, 'lab-restart.exit'), '3\n');

    sweep(svc);

    expect(svc.restartState().status).toBe('failed');
    expect(existsSync(join(stateDir, 'lab-restart.json'))).toBe(true);
    spawnMock.mockClear();
    spawnMock.mockReturnValue(inertChild());
    expect((await secondAttempt(svc, runner)).status).toBe('running');
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('supersedes a recorded failure when the retry writes its own marker', async () => {
    const { svc, runner } = makeService();
    await detach(svc, runner);
    writeFileSync(join(stateDir, 'lab-restart.exit'), '3\n');
    sweep(svc);

    spawnMock.mockReturnValue(inertChild());
    await secondAttempt(svc, runner);

    expect(svc.restartState().status).toBe('pending');
    expect(existsSync(join(stateDir, 'lab-restart.exit'))).toBe(false);
  });

  it('abandons a marker whose child never reported, only past the age floor', async () => {
    const { svc, runner } = makeService();
    await detach(svc, runner);

    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + RESTART_STALE_AFTER_MS + 60_000 });
    try {
      sweep(svc);
      expect(svc.restartState().status).toBe('stale');
    } finally {
      vi.useRealTimers();
    }

    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 7 * 60 * 60 * 1000 });
    try {
      sweep(svc);
      expect(svc.restartState()).toEqual({ status: 'idle' });
    } finally {
      vi.useRealTimers();
    }
  });
});
