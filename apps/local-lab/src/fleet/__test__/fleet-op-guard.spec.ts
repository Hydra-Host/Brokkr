import { ConflictException } from '@nestjs/common';
import { Subject } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { type RunSection, type RunStatus } from '../../contract';
import { type RunState } from '../../runner/runner.service';
import { STACK_OPS } from '../../stack/stack.service';
import { FLEET_MUTATING_STACK_OP_IDS, FleetOpRegistry } from '../fleet-op-registry';
import { FleetPowerService } from '../fleet-power.service';
import { FleetResetService } from '../fleet-reset.service';

vi.mock('../../common/sleep', () => ({ sleep: () => Promise.resolve() }));
vi.mock('../../common/hub-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../common/hub-client')>();
  return {
    ...actual,
    hubApiSignIn: vi.fn(() => Promise.resolve(new Map())),
    hubApiFetch: vi.fn(() => Promise.resolve({ code: 200, body: {} })),
  };
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
    spawn: vi.fn(() => new Promise<number | null>(() => {})),
    emit: vi.fn(),
    finalize: vi.fn(),
  };
}

function makePower(registry: FleetOpRegistry, runner: ReturnType<typeof makeRunner>, nodes = ['cpu-1', 'cpu-2']) {
  const topology = { nodeNames: () => nodes };
  return new FleetPowerService(runner as never, {} as never, topology as never, registry);
}

function makeReset(registry: FleetOpRegistry, runner: ReturnType<typeof makeRunner>, nodes = ['cpu-1', 'cpu-2']) {
  const topology = { nodeNames: () => nodes };
  const svc = new FleetResetService(runner as never, {} as never, topology as never, {} as never, registry, {} as never);
  Object.assign(svc, { discoverDeadlineMs: 0 });
  return svc;
}

function runningStackOp(opId: string): StackRunEntry {
  return {
    runId: `stack-${opId}`,
    section: 'stack',
    opId,
    label: opId,
    status: 'running',
    startedAt: 1,
    exitCode: null,
  };
}

function expectAllOpsAllowed(stackRuns: StackRunEntry[]) {
  const rPower = makeRunner(stackRuns);
  expect(typeof makePower(new FleetOpRegistry(rPower as never), rPower).power('cpu-1', 'on')).toBe('string');

  const rDiscover = makeRunner(stackRuns);
  expect(typeof makeReset(new FleetOpRegistry(rDiscover as never), rDiscover).discover('cpu-1')).toBe('string');

  const rReset = makeRunner(stackRuns);
  const reset = makeReset(new FleetOpRegistry(rReset as never), rReset);
  vi.spyOn(reset, 'resetDeviceNative').mockReturnValue(new Promise<never>(() => {}));
  expect(typeof reset.reset('cpu-1')).toBe('string');
}

afterEach(() => vi.clearAllMocks());

describe('FleetOpRegistry — per-node exclusion', () => {
  it('blocks a second power on the same node in flight but allows a different node', () => {
    const runner = makeRunner();
    const registry = new FleetOpRegistry(runner as never);
    const power = makePower(registry, runner);

    expect(typeof power.power('cpu-1', 'on')).toBe('string');
    expect(() => power.power('cpu-1', 'off')).toThrow(ConflictException);
    expect(typeof power.power('cpu-2', 'on')).toBe('string');
  });
});

describe('FleetOpRegistry — fleet-wide exclusion', () => {
  it('blocks reset while any node lease is held', () => {
    const runner = makeRunner();
    const registry = new FleetOpRegistry(runner as never);
    registry.acquire({ kind: 'node', name: 'cpu-1' }, 'power cpu-1 on');
    const reset = makeReset(registry, runner);

    expect(() => reset.reset('cpu-2')).toThrow(ConflictException);
  });

  it('blocks both power and discover while the fleet lease is held', () => {
    const runner = makeRunner();
    const registry = new FleetOpRegistry(runner as never);
    registry.acquire({ kind: 'fleet' }, 'reset cpu-1');
    const power = makePower(registry, runner);
    const reset = makeReset(registry, runner);

    expect(() => power.power('cpu-1', 'on')).toThrow(ConflictException);
    expect(() => reset.discover('cpu-1')).toThrow(ConflictException);
  });
});

describe('FleetOpRegistry — 409 precedes run creation', () => {
  it('never creates a run when the acquire conflicts', () => {
    const runner = makeRunner();
    const registry = new FleetOpRegistry(runner as never);
    registry.acquire({ kind: 'fleet' }, 'reset cpu-1');
    const power = makePower(registry, runner);
    const reset = makeReset(registry, runner);

    expect(() => power.power('cpu-1', 'on')).toThrow(ConflictException);
    expect(() => reset.reset('cpu-1')).toThrow(ConflictException);
    expect(runner.create).not.toHaveBeenCalled();
  });
});

describe('FleetOpRegistry — lease release on op failure', () => {
  it('releases the node lease after the op chain rejects so a fresh acquire succeeds', async () => {
    const runner = makeRunner();
    runner.spawn = vi.fn(() => Promise.reject(new Error('boom')));
    const registry = new FleetOpRegistry(runner as never);
    const power = makePower(registry, runner);

    power.power('cpu-1', 'on');
    await vi.waitFor(() => expect(runner.finalize).toHaveBeenCalled());

    expect(() => power.power('cpu-1', 'off')).not.toThrow();
  });

  it('releases the node lease after discover finishes so a fresh discover succeeds', async () => {
    const runner = makeRunner();
    const registry = new FleetOpRegistry(runner as never);
    const reset = makeReset(registry, runner);

    reset.discover('cpu-1');
    await vi.waitFor(() => expect(runner.finalize).toHaveBeenCalled());

    expect(() => reset.discover('cpu-1')).not.toThrow();
  });

  it('releases the fleet lease after reset finishes so a fresh reset succeeds', async () => {
    const runner = makeRunner();
    const registry = new FleetOpRegistry(runner as never);
    const reset = makeReset(registry, runner);
    vi.spyOn(reset, 'resetDeviceNative').mockResolvedValue(undefined as never);

    reset.reset('cpu-1');
    await vi.waitFor(() => expect(runner.finalize).toHaveBeenCalled());

    expect(() => reset.reset('cpu-1')).not.toThrow();
  });
});

describe('FleetOpRegistry — cross-domain stack op check', () => {
  it('blocks all three ops while a fleet-mutating stack op is running', () => {
    const runner = makeRunner([runningStackOp('fleet-up')]);
    const registry = new FleetOpRegistry(runner as never);
    const power = makePower(registry, runner);
    const reset = makeReset(registry, runner);

    expect(() => power.power('cpu-1', 'on')).toThrow(ConflictException);
    expect(() => reset.discover('cpu-1')).toThrow(ConflictException);
    expect(() => reset.reset('cpu-1')).toThrow(ConflictException);
  });

  it('allows fleet ops once the fleet-mutating stack op has passed', () => {
    expectAllOpsAllowed([{ ...runningStackOp('fleet-up'), status: 'passed', exitCode: 0 }]);
  });

  it('allows fleet ops when only a non-fleet stack op is running', () => {
    expectAllOpsAllowed([runningStackOp('up')]);
  });
});

describe('FleetOpRegistry — stack op identity comes from opId, not the label', () => {
  it('blocks on a fleet-mutating opId even when the label is unrelated prose', () => {
    const runner = makeRunner([{ ...runningStackOp('fleet-up'), label: 'bring the fleet up' }]);
    const registry = new FleetOpRegistry(runner as never);

    expect(() => makePower(registry, runner).power('cpu-1', 'on')).toThrow(ConflictException);
  });

  it('allows fleet ops when only the label happens to match a fleet-mutating op id', () => {
    expectAllOpsAllowed([{ ...runningStackOp('redeploy'), label: 'fleet-up' }]);
  });
});

describe('FLEET_MUTATING_STACK_OP_IDS parity with the stack op catalog', () => {
  it('equals the fleet-section, non-status stack ops derived from STACK_OPS', () => {
    const derived = new Set(
      STACK_OPS.filter((op) => op.group !== 'status' && (op.section === 'fleet' || op.sections?.includes('fleet'))).map(
        (op) => op.id,
      ),
    );

    expect(new Set(FLEET_MUTATING_STACK_OP_IDS)).toEqual(derived);
  });
});
