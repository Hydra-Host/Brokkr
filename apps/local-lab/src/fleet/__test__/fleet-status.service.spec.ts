import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { PcProcess } from '../../services/proc-health';
import { FleetStatusService } from '../fleet-status.service';

const bridge = (proc: string) => ({ proc, zone: 'sim-zone', replica: 0, port: 8000, grpc: 9082 });

const mk = (
  pc: PcProcess[],
  names: string[],
  running: string[],
  prog: object | null,
  tailError: (name: string) => string | undefined = () => undefined,
  tailTaskLog: (name: string) => string | undefined = () => undefined,
  bridges: ReturnType<typeof bridge>[] = [],
) =>
  new FleetStatusService(
    { listAll: async () => pc, tailError, tailTaskLog } as any,
    { nodeNames: () => names, baremetalView: () => ({ nodes: [] }) } as any,
    {
      machines: async () =>
        names.map((name) => ({
          name,
          power: running.includes(name) ? 'on' : 'off',
          configured: true,
          deviceId: null,
        })),
    } as any,
    { labBridges: () => bridges, planes: () => ({ vm: true, baremetal: false }) } as any,
    { readProgress: () => prog } as any,
  );

describe('FleetStatusService.status', () => {
  it('coming-up during the init phase', async () => {
    const svc = mk(
      [{ name: 'fleet', status: 'Running', is_ready: 'Not Ready' }],
      ['cpu-1', 'cpu-2', 'cpu-3', 'cpu-4'],
      [],
      {
        phase: 'init',
        step: 'build-ipxe',
        label: 'building per-VM iPXE binary for cpu-3',
        node: 'cpu-3',
        index: 3,
        total: 4,
        stepOrdinal: 4,
        stepCount: 9,
        startedAt: 1,
        updatedAt: 2,
        error: null,
      },
    );
    const s = await svc.status();
    expect(s.health).toBe('coming-up');
    expect(s.machinesExpected).toBe(4);
    expect(s.stepOrdinal).toBe(4);
  });

  it('reconciles a Completed exit=-1 fleet (the nuke incident) to stopped', async () => {
    const svc = mk([{ name: 'fleet', status: 'Completed', is_ready: '-', exit_code: -1 }], ['cpu-1'], [], null);
    expect((await svc.status()).health).toBe('stopped');
  });

  it('surfaces the process tail-error on a terminal fleet with no engine-recorded error', async () => {
    const svc = mk(
      [{ name: 'fleet', status: 'Completed', is_ready: '-', exit_code: -1 }],
      ['cpu-1'],
      [],
      null,
      () => 'spoke: 404 brokkr-discovery-x.img',
    );
    const s = await svc.status();
    expect(s.health).toBe('stopped');
    expect(s.detail).toContain('spoke: 404');
  });

  it('falls back to the fleet:init task tee-log when the process error tail is empty', async () => {
    const svc = mk(
      [{ name: 'fleet', status: 'Completed', is_ready: '-', exit_code: -1 }],
      ['cpu-1'],
      [],
      null,
      () => undefined,
      (name) => (name === 'fleet:init' ? 'fleet:init: iPXE build failed' : undefined),
    );
    const s = await svc.status();
    expect(s.health).toBe('stopped');
    expect(s.detail).toContain('iPXE build failed');
  });

  it('does not tail logs on the running/coming-up hot path', async () => {
    const tail = vi.fn(() => 'should not be called');
    const svc = mk([{ name: 'fleet', status: 'Running', is_ready: 'Not Ready' }], ['cpu-1'], [], null, tail);
    await svc.status();
    expect(tail).not.toHaveBeenCalled();
  });

  it('ready with the running-VM count', async () => {
    const svc = mk(
      [{ name: 'fleet', status: 'Running', is_ready: 'Ready' }],
      ['cpu-1', 'cpu-2'],
      ['cpu-1', 'cpu-2'],
      null,
    );
    const s = await svc.status();
    expect(s.health).toBe('ready');
    expect(s.machinesRunning).toBe(2);
  });

  it('excludes an unconfigured sibling-stack domain from the running count', async () => {
    const svc = new FleetStatusService(
      {
        listAll: async () => [{ name: 'fleet', status: 'Running', is_ready: 'Ready' }],
        tailError: () => undefined,
        tailTaskLog: () => undefined,
      } as any,
      { nodeNames: () => ['cpu-1'], baremetalView: () => ({ nodes: [] }) } as any,
      {
        machines: async () => [
          { name: 'cpu-1', power: 'on', configured: true, deviceId: null },
          { name: 's1-cpu-1', power: 'on', configured: false, deviceId: null },
        ],
      } as any,
      { labBridges: () => [], planes: () => ({ vm: true, baremetal: false }) } as any,
      { readProgress: () => null } as any,
    );
    expect((await svc.status()).machinesRunning).toBe(1);
  });
});

describe('FleetStatusService.status with the spoke that serves the boot chain', () => {
  const fleetUp: PcProcess[] = [{ name: 'fleet', status: 'Running', is_ready: 'Ready' }];

  it('ready when every bridge process is up', async () => {
    const svc = mk(
      [...fleetUp, { name: 'spoke', status: 'Running', is_ready: 'Ready' }],
      ['cpu-1'],
      ['cpu-1'],
      null,
      undefined,
      undefined,
      [bridge('spoke')],
    );
    const s = await svc.status();
    expect(s.health).toBe('ready');
    expect(s.detail).toBe('ready · 1/1 VMs running');
  });

  it('degraded — naming the dead spoke — while every VM is still running', async () => {
    const svc = mk(
      [...fleetUp, { name: 'spoke', status: 'Error', is_ready: '-', exit_code: 1 }],
      ['cpu-1', 'cpu-2'],
      ['cpu-1', 'cpu-2'],
      null,
      undefined,
      undefined,
      [bridge('spoke')],
    );
    const s = await svc.status();
    expect(s.health).toBe('degraded');
    expect(s.detail).toContain('2/2 VMs running');
    expect(s.detail).toContain('spoke');
    expect(s.machinesRunning).toBe(2);
  });

  it('names every down bridge of a multi-bridge zone set', async () => {
    const svc = mk(
      [
        ...fleetUp,
        { name: 'spoke', status: 'Running', is_ready: 'Ready' },
        { name: 'spoke-2', status: 'Completed', is_ready: '-', exit_code: 143 },
      ],
      ['cpu-1'],
      ['cpu-1'],
      null,
      undefined,
      undefined,
      [bridge('spoke'), bridge('spoke-2')],
    );
    const s = await svc.status();
    expect(s.health).toBe('degraded');
    expect(s.detail).toContain('spoke-2');
    expect(s.detail).not.toContain('spoke,');
  });

  it('claims nothing about the spokes when the process list is unavailable', async () => {
    const svc = new FleetStatusService(
      {
        listAll: async () => {
          throw new Error('pc socket gone');
        },
        tailError: () => undefined,
        tailTaskLog: () => undefined,
      } as any,
      { nodeNames: () => ['cpu-1'], baremetalView: () => ({ nodes: [] }) } as any,
      { machines: async () => [] } as any,
      { labBridges: () => [bridge('spoke')], planes: () => ({ vm: true, baremetal: false }) } as any,
      { readProgress: () => null } as any,
    );
    expect((await svc.status()).health).toBe('idle');
  });
});

describe('FleetStatusService.status with a caller-supplied snapshot', () => {
  it('counts the passed machines without probing libvirt again', async () => {
    let probes = 0;
    const svc = new FleetStatusService(
      {
        listAll: async () => [{ name: 'fleet', status: 'Running', is_ready: 'Ready' }],
        tailError: () => undefined,
        tailTaskLog: () => undefined,
      } as any,
      { nodeNames: () => ['cpu-1', 'cpu-2'], baremetalView: () => ({ nodes: [] }) } as any,
      {
        machines: async () => {
          probes += 1;
          return [];
        },
      } as any,
      { labBridges: () => [], planes: () => ({ vm: true, baremetal: false }) } as any,
      { readProgress: () => null } as any,
    );

    const result = await svc.status([
      { name: 'cpu-1', kind: 'vm', power: 'on', configured: true, deviceId: null, bmc: null },
      { name: 'cpu-2', kind: 'vm', power: 'on', configured: true, deviceId: null, bmc: null },
    ]);

    expect(probes).toBe(0);
    expect(result.machinesRunning).toBe(2);
    expect(result.machinesExpected).toBe(2);
  });
});

describe('FleetStatusService.status with bare-metal machines', () => {
  const bm = (name: string, pxe_mac: string) => ({
    name,
    bmc_ip: '10.10.0.5',
    bmc_mac: 'aa:bb:cc:dd:ee:01',
    pxe_mac,
    arch: null,
    system_id: null,
  });

  const mkBaremetal = (nodes: ReturnType<typeof bm>[], machines: object[]) =>
    new FleetStatusService(
      {
        listAll: async () => [{ name: 'fleet', status: 'Running', is_ready: 'Ready' }],
        tailError: () => undefined,
        tailTaskLog: () => undefined,
      } as any,
      { nodeNames: () => [], baremetalView: () => ({ nodes }) } as any,
      { machines: async () => machines } as any,
      { labBridges: () => [], planes: () => ({ vm: false, baremetal: true }) } as any,
      { readProgress: () => null } as any,
    );

  it('counts registered bare-metal machines when no vm node is enabled', async () => {
    const svc = mkBaremetal(
      [bm('metal-1', '00:00:5e:00:53:b1'), bm('metal-2', '00:00:5e:00:53:b2')],
      [
        { name: 'metal-1', power: 'on', configured: true, deviceId: null },
        { name: 'metal-2', power: 'unknown', configured: true, deviceId: null },
      ],
    );
    const s = await svc.status();
    expect(s.machinesExpected).toBe(2);
    expect(s.machinesRunning).toBe(1);
  });

  it('leaves a machine with a blank pxe mac out of the expected count', async () => {
    const svc = mkBaremetal(
      [bm('metal-1', '00:00:5e:00:53:b1'), bm('metal-blank', '   ')],
      [{ name: 'metal-1', power: 'on', configured: true, deviceId: null }],
    );
    expect((await svc.status()).machinesExpected).toBe(1);
  });
});

describe('FleetStatusService.readProgressFromDisk', () => {
  const valid = {
    phase: 'init',
    step: 'build-ipxe',
    label: 'building',
    node: 'cpu-1',
    index: 1,
    total: 4,
    stepOrdinal: 4,
    stepCount: 9,
    startedAt: 1000,
    updatedAt: 1100,
    error: null,
  };
  let dir: string;
  const prevState = process.env.LOCAL_STATE;

  const writeProgress = (contents: string) => {
    const runDir = join(dir, 'state', 'run');
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'fleet-progress.json'), contents);
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lab-progress-'));
    process.env.LOCAL_STATE = dir;
  });
  afterEach(() => {
    if (prevState === undefined) delete process.env.LOCAL_STATE;
    else process.env.LOCAL_STATE = prevState;
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns null when the progress file is absent', () => {
    expect(FleetStatusService.readProgressFromDisk()).toBeNull();
  });

  it('parses a well-formed progress file', () => {
    writeProgress(JSON.stringify(valid));
    const prog = FleetStatusService.readProgressFromDisk();
    expect(prog?.phase).toBe('init');
    expect(prog?.step).toBe('build-ipxe');
  });

  it('returns null on valid JSON with the wrong shape (missing required field)', () => {
    const { step: _omit, ...partial } = valid;
    writeProgress(JSON.stringify(partial));
    expect(FleetStatusService.readProgressFromDisk()).toBeNull();
  });

  it('returns null on an out-of-enum phase', () => {
    writeProgress(JSON.stringify({ ...valid, phase: 'not-a-phase' }));
    expect(FleetStatusService.readProgressFromDisk()).toBeNull();
  });

  it('returns null on malformed JSON', () => {
    writeProgress('{ not json');
    expect(FleetStatusService.readProgressFromDisk()).toBeNull();
  });
});
