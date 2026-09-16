import { deriveFleetStatus, type FleetProgress } from '../fleet-health';
import type { PcProcess } from '../proc-health';

const proc = (o: Partial<PcProcess>): PcProcess => ({ name: 'fleet', status: 'Running', ...o });
const prog = (o: Partial<FleetProgress>): FleetProgress => ({
  phase: 'up',
  step: 'power-on',
  label: 'powering on',
  node: 'cpu-1',
  index: 1,
  total: 4,
  stepOrdinal: 7,
  stepCount: 9,
  startedAt: 1000,
  updatedAt: 1100,
  error: null,
  ...o,
});
const NOW = 1124_000;

describe('deriveFleetStatus', () => {
  it('ready when Running + Ready, with VM count + stepOrdinal passthrough', () => {
    const s = deriveFleetStatus(proc({ is_ready: 'Ready' }), prog({ step: 'ready', stepOrdinal: 8 }), 4, 4, NOW);
    expect(s.health).toBe('ready');
    expect(s.detail).toBe('ready · 4/4 VMs running');
    expect(s.stepOrdinal).toBe(8);
    expect(s.stepCount).toBe(9);
  });

  it('degraded (not ready) when a spoke that serves the boot chain is down', () => {
    const s = deriveFleetStatus(
      proc({ is_ready: 'Ready' }),
      prog({ step: 'ready', stepOrdinal: 8 }),
      4,
      4,
      NOW,
      undefined,
      ['spoke'],
    );
    expect(s.health).toBe('degraded');
    expect(s.detail).toContain('4/4 VMs running');
    expect(s.detail).toContain('spoke down');
    expect(s.machinesRunning).toBe(4);
  });

  it('leaves a fleet that is not itself ready alone — a down spoke does not mask coming-up', () => {
    const s = deriveFleetStatus(proc({ is_ready: 'Not Ready' }), prog({}), 4, 0, NOW, undefined, ['spoke']);
    expect(s.health).toBe('coming-up');
  });

  it('coming-up with label/counts/elapsed', () => {
    const s = deriveFleetStatus(
      proc({ is_ready: 'Not Ready' }),
      prog({
        step: 'build-ipxe',
        stepOrdinal: 4,
        label: 'building per-VM iPXE binary for cpu-3',
        node: 'cpu-3',
        index: 3,
        total: 4,
      }),
      4,
      0,
      NOW,
    );
    expect(s.health).toBe('coming-up');
    expect(s.detail).toContain('building per-VM iPXE binary for cpu-3 (3/4)');
    expect(s.detail).toContain('2m04s');
  });

  it('coming-up when Pending', () => {
    expect(deriveFleetStatus(proc({ status: 'Pending', is_ready: '-' }), null, 4, 0, NOW).health).toBe('coming-up');
  });

  it('STOPPED (not failed) when stopped/cancelled — Completed with negative exit (the nuke incident)', () => {
    const s = deriveFleetStatus(
      proc({ status: 'Completed', is_ready: '-', exit_code: -1 }),
      prog({ phase: 'init', step: 'build-ipxe' }),
      4,
      0,
      NOW,
    );
    expect(s.health).toBe('stopped');
    expect(s.detail).toMatch(/click Start/);
  });

  it('STOPPED (not failed) on a termination-signal exit — pc stop/restart yields 128+signum (e.g. 143)', () => {
    expect(
      deriveFleetStatus(proc({ status: 'Completed', is_ready: '-', exit_code: 143 }), null, 4, 0, NOW).health,
    ).toBe('stopped');
    expect(deriveFleetStatus(proc({ status: 'Stopped', is_ready: '-', exit_code: 143 }), null, 4, 0, NOW).health).toBe(
      'stopped',
    );
  });

  it('failed on a real crash (Error / positive exit / recorded error)', () => {
    expect(deriveFleetStatus(proc({ status: 'Error', exit_code: 1 }), null, 4, 0, NOW).health).toBe('failed');
    expect(deriveFleetStatus(proc({ status: 'Completed', exit_code: 2 }), null, 4, 0, NOW).health).toBe('failed');
    expect(
      deriveFleetStatus(
        proc({ status: 'Completed', exit_code: 0 }),
        prog({ error: 'preflight failed: ipmi_sim missing' }),
        4,
        0,
        NOW,
      ).health,
    ).toBe('failed');
  });

  it('disabled / idle', () => {
    expect(deriveFleetStatus(proc({ status: 'Disabled' }), null, 4, 0, NOW).health).toBe('disabled');
    expect(deriveFleetStatus(undefined, null, 4, 0, NOW).health).toBe('idle');
  });

  it('surfaces lastError in the stopped/failed detail when the engine recorded none', () => {
    const stopped = deriveFleetStatus(
      proc({ status: 'Completed', is_ready: '-', exit_code: -1 }),
      null,
      4,
      0,
      NOW,
      'spoke: 404 brokkr-discovery-x.img',
    );
    expect(stopped.health).toBe('stopped');
    expect(stopped.detail).toContain('spoke: 404');

    const failed = deriveFleetStatus(proc({ status: 'Error', exit_code: 1 }), null, 4, 0, NOW, 'boom from stderr');
    expect(failed.health).toBe('failed');
    expect(failed.detail).toBe('boom from stderr');
  });

  it('prefers the engine-recorded prog.error over lastError', () => {
    const s = deriveFleetStatus(
      proc({ status: 'Completed', exit_code: 0 }),
      prog({ error: 'fleet init failed: spoke could not serve …' }),
      4,
      0,
      NOW,
      'less-specific tail line',
    );
    expect(s.health).toBe('failed');
    expect(s.detail).toBe('fleet init failed: spoke could not serve …');
  });

  it('carries the accelerator and how it was chosen through to the card', () => {
    const s = deriveFleetStatus(proc({ is_ready: 'Ready' }), prog({ accel: 'tcg', accelForced: true }), 4, 4, NOW);
    expect(s.accel).toBe('tcg');
    expect(s.accelForced).toBe(true);
  });

  it('carries the accelerator while the fleet is still coming up', () => {
    const s = deriveFleetStatus(proc({ is_ready: 'Not Ready' }), prog({ accel: 'tcg', accelForced: false }), 4, 0, NOW);
    expect(s.health).toBe('coming-up');
    expect(s.accel).toBe('tcg');
    expect(s.accelForced).toBe(false);
  });

  it('leaves the accelerator null when no progress record exists', () => {
    const s = deriveFleetStatus(proc({ is_ready: 'Ready' }), null, 4, 4, NOW);
    expect(s.accel).toBeNull();
    expect(s.accelForced).toBeNull();
  });

  it('keeps fleet health ready under emulation — tcg is slow, not degraded', () => {
    const s = deriveFleetStatus(proc({ is_ready: 'Ready' }), prog({ accel: 'tcg', accelForced: false }), 4, 4, NOW);
    expect(s.health).toBe('ready');
  });
});

describe('deriveFleetStatus — bare-metal vocabulary and unreachable machines', () => {
  it('says machines, not VMs, when the bare-metal plane is on', () => {
    const s = deriveFleetStatus(proc({ is_ready: 'Ready' }), prog({}), 3, 3, NOW, undefined, [], {
      planes: { vm: false, baremetal: true },
    });

    expect(s.detail).toContain('3/3 machines running');
    expect(s.detail).not.toContain('VMs');
  });

  it('keeps saying VMs when only the vm plane is on', () => {
    const s = deriveFleetStatus(proc({ is_ready: 'Ready' }), prog({}), 3, 3, NOW, undefined, [], {
      planes: { vm: true, baremetal: false },
    });

    expect(s.detail).toContain('3/3 VMs running');
  });

  it('says machines when both planes are on', () => {
    const s = deriveFleetStatus(proc({ is_ready: 'Ready' }), prog({}), 5, 5, NOW, undefined, [], {
      planes: { vm: true, baremetal: true },
    });

    expect(s.detail).toContain('5/5 machines running');
  });

  it('says VMs when the planes are unknown', () => {
    const s = deriveFleetStatus(proc({ is_ready: 'Ready' }), prog({}), 3, 3, NOW, undefined, [], { planes: null });

    expect(s.detail).toContain('3/3 VMs running');
  });

  it('names unreachable machines rather than letting them read as powered off', () => {
    const s = deriveFleetStatus(proc({ is_ready: 'Ready' }), prog({}), 3, 1, NOW, undefined, [], {
      planes: { vm: false, baremetal: true },
      unreachable: 2,
    });

    expect(s.detail).toContain('1/3 machines running');
    expect(s.detail).toContain('2 unreachable');
  });

  it('says nothing about unreachable machines when there are none', () => {
    const s = deriveFleetStatus(proc({ is_ready: 'Ready' }), prog({}), 3, 3, NOW, undefined, [], {
      planes: { vm: false, baremetal: true },
      unreachable: 0,
    });

    expect(s.detail).not.toContain('unreachable');
  });

  it('uses the bare-metal noun in the degraded boot-chain message too', () => {
    const s = deriveFleetStatus(proc({ is_ready: 'Ready' }), prog({}), 2, 2, NOW, undefined, ['spoke'], {
      planes: { vm: false, baremetal: true },
    });

    expect(s.health).toBe('degraded');
    expect(s.detail).toContain('the machines have no boot chain');
  });
});
