import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Subject } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BareMetalNode, FleetPlanes } from '@repo/local-lab-contract';

import { bmDeviceUuid, simDeviceUuid } from '../../common/hub-client';
import { RunnerService, type RunState } from '../../runner/runner.service';
import { OverlayStoreService } from '../../services/overlay-store';
import { FleetOpRegistry } from '../fleet-op-registry';
import {
  AUTH_FAILED_BACKOFF_MS,
  BMC_PROBE_CONCURRENCY,
  BMC_PROBE_TIMEOUT_MS,
  FleetPowerService,
} from '../fleet-power.service';
import { FleetTopologyService } from '../fleet-topology.service';
import { fakeVirshChild } from './virsh-spawn-harness';

const { requestMock, agentOptions, spawnMock } = vi.hoisted(() => ({
  requestMock: vi.fn(),
  agentOptions: vi.fn(),
  spawnMock: vi.fn(),
}));

vi.mock('undici', () => ({
  request: requestMock,
  Agent: class {
    close = vi.fn();
    constructor(opts: unknown) {
      agentOptions(opts);
    }
  },
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: spawnMock };
});

const SYSTEM = '/redfish/v1/Systems/1';
const VM_ONLY: FleetPlanes = { vm: true, baremetal: false };
const BM_ONLY: FleetPlanes = { vm: false, baremetal: true };
const BOTH: FleetPlanes = { vm: true, baremetal: true };

const bmNode = (over: Partial<BareMetalNode> & { name: string }): BareMetalNode => ({
  bmc_ip: '10.10.0.5',
  bmc_mac: 'aa:bb:cc:dd:ee:01',
  pxe_mac: '00:00:5e:00:53:b1',
  arch: null,
  system_id: null,
  ...over,
});

function resp(statusCode: number, json: unknown) {
  return { statusCode, body: { text: async () => JSON.stringify(json) } };
}

function wireRedfish(answerByHost: Record<string, string | number>, onCall?: () => Promise<void>) {
  requestMock.mockImplementation(async (url: string) => {
    if (onCall) await onCall();
    const state = answerByHost[new URL(url).host];
    if (state === undefined) throw new Error('connect ECONNREFUSED');
    if (typeof state === 'number') return resp(state, { error: 'rejected' });
    if (url.endsWith('/redfish/v1/Systems')) return resp(200, { Members: [{ '@odata.id': SYSTEM }] });
    if (url.endsWith(SYSTEM)) return resp(200, { PowerState: state });
    if (url.endsWith('/Actions/ComputerSystem.Reset')) return resp(204, {});
    throw new Error(`unexpected redfish call: ${url}`);
  });
}

function makeService(opts: {
  planes?: FleetPlanes;
  nodes?: BareMetalNode[];
  vmNames?: string[];
  credByNode?: Record<string, { user: string; pass: string } | null>;
}) {
  const overlay = { planes: () => opts.planes ?? BM_ONLY };
  const topology = {
    nodeNames: () => opts.vmNames ?? [],
    baremetalView: () => ({ nodes: opts.nodes ?? [] }),
    resolveBmcCred: (name: string) =>
      opts.credByNode ? (opts.credByNode[name] ?? null) : { user: 'root', pass: 'secret' },
  };
  return new FleetPowerService({} as never, overlay as never, topology as never, {} as never);
}

describe('FleetPowerService.machines with bare-metal rows', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it('lists both planes and reads libvirt only when a vm node exists', async () => {
    wireRedfish({ '10.10.0.5': 'On' });
    const bmOnly = makeService({ nodes: [bmNode({ name: 'metal-1' })] });

    await expect(bmOnly.machines()).resolves.toEqual([
      {
        name: 'metal-1',
        kind: 'baremetal',
        power: 'on',
        configured: true,
        deviceId: bmDeviceUuid('00:00:5e:00:53:b1'),
        bmc: { reachable: 'ok', powerState: 'On' },
      },
    ]);
    expect(spawnMock).not.toHaveBeenCalled();

    spawnMock.mockImplementation((_cmd: string, args: string[]) =>
      fakeVirshChild(
        args.includes('list') ? [' Id   Name       State', ' 1    cpu-1      running', ''].join('\n') : '',
      ),
    );
    const both = makeService({ planes: BOTH, vmNames: ['cpu-1'], nodes: [bmNode({ name: 'metal-1' })] });

    await expect(both.machines()).resolves.toEqual([
      { name: 'cpu-1', kind: 'vm', power: 'on', configured: true, deviceId: simDeviceUuid(0), bmc: null },
      {
        name: 'metal-1',
        kind: 'baremetal',
        power: 'on',
        configured: true,
        deviceId: bmDeviceUuid('00:00:5e:00:53:b1'),
        bmc: { reachable: 'ok', powerState: 'On' },
      },
    ]);
    expect(spawnMock).toHaveBeenCalled();
  });

  it('lists one row per registered machine with the BMC-reported power state', async () => {
    wireRedfish({ '10.10.0.5': 'On', '10.10.0.6': 'Off' });
    const svc = makeService({
      nodes: [
        bmNode({ name: 'metal-1', pxe_mac: '00:00:5e:00:53:b1' }),
        bmNode({ name: 'metal-2', bmc_ip: '10.10.0.6', pxe_mac: '00:00:5e:00:53:b2' }),
      ],
    });

    await expect(svc.machines()).resolves.toEqual([
      {
        name: 'metal-1',
        kind: 'baremetal',
        power: 'on',
        configured: true,
        deviceId: bmDeviceUuid('00:00:5e:00:53:b1'),
        bmc: { reachable: 'ok', powerState: 'On' },
      },
      {
        name: 'metal-2',
        kind: 'baremetal',
        power: 'off',
        configured: true,
        deviceId: bmDeviceUuid('00:00:5e:00:53:b2'),
        bmc: { reachable: 'ok', powerState: 'Off' },
      },
    ]);
  });

  it('keeps the row of an unreachable BMC and reports its power as unknown', async () => {
    wireRedfish({ '10.10.0.5': 'On' });
    const svc = makeService({
      nodes: [
        bmNode({ name: 'metal-1', pxe_mac: '00:00:5e:00:53:b1' }),
        bmNode({ name: 'metal-dead', bmc_ip: '10.10.0.99', pxe_mac: '00:00:5e:00:53:b9' }),
      ],
    });

    const machines = await svc.machines();
    expect(machines.map((m) => m.name)).toEqual(['metal-1', 'metal-dead']);
    expect(machines[1]).toEqual({
      name: 'metal-dead',
      power: 'unknown',
      kind: 'baremetal',
      configured: true,
      deviceId: bmDeviceUuid('00:00:5e:00:53:b9'),
      bmc: { reachable: 'unreachable', powerState: null },
    });
  });

  it('honours a per-node Redfish System id instead of enumerating Members', async () => {
    wireRedfish({ '10.10.0.5': 'On' });
    const svc = makeService({ nodes: [bmNode({ name: 'blade-1', system_id: '1' })] });

    await expect(svc.machines()).resolves.toEqual([
      {
        name: 'blade-1',
        kind: 'baremetal',
        power: 'on',
        configured: true,
        deviceId: bmDeviceUuid('00:00:5e:00:53:b1'),
        bmc: { reachable: 'ok', powerState: 'On' },
      },
    ]);
    expect(requestMock.mock.calls.map((c) => c[0])).toEqual([`https://10.10.0.5${SYSTEM}`]);
  });

  it('reports unknown without a Redfish call when the machine has no BMC credentials', async () => {
    wireRedfish({ '10.10.0.5': 'On' });
    const svc = makeService({ nodes: [bmNode({ name: 'metal-1' })], credByNode: { 'metal-1': null } });

    await expect(svc.machines()).resolves.toEqual([
      {
        name: 'metal-1',
        kind: 'baremetal',
        power: 'unknown',
        configured: true,
        deviceId: bmDeviceUuid('00:00:5e:00:53:b1'),
        bmc: { reachable: 'unconfigured', powerState: null },
      },
    ]);
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('reports a transient Redfish power state as unknown rather than guessing', async () => {
    wireRedfish({ '10.10.0.5': 'PoweringOn' });
    const svc = makeService({ nodes: [bmNode({ name: 'metal-1' })] });

    const [row] = await svc.machines();
    expect(row.power).toBe('unknown');
    expect(row.bmc).toEqual({ reachable: 'ok', powerState: 'PoweringOn' });
  });

  it('bounds every BMC read with a connect, headers and body timeout', async () => {
    wireRedfish({ '10.10.0.5': 'On' });
    const svc = makeService({ nodes: [bmNode({ name: 'metal-1' })] });

    await svc.machines();
    const opts = agentOptions.mock.calls[0][0];
    expect(opts.connect.timeout).toBeGreaterThan(0);
    expect(opts.headersTimeout).toBeGreaterThan(0);
    expect(opts.bodyTimeout).toBeGreaterThan(0);
  });

  it('gives a routed bmc the same fifteen seconds verify gives it', async () => {
    wireRedfish({ '10.10.0.5': 'On' });
    const svc = makeService({ nodes: [bmNode({ name: 'metal-1' })] });

    await svc.machines();
    const opts = agentOptions.mock.calls[0][0];
    expect(BMC_PROBE_TIMEOUT_MS).toBe(15_000);
    expect(opts.connect.timeout).toBe(BMC_PROBE_TIMEOUT_MS);
    expect(opts.headersTimeout).toBe(BMC_PROBE_TIMEOUT_MS);
    expect(opts.bodyTimeout).toBe(BMC_PROBE_TIMEOUT_MS);
  });

  it('never probes more BMCs at once than the concurrency bound', async () => {
    let inFlight = 0;
    let peak = 0;
    const nodes = Array.from({ length: BMC_PROBE_CONCURRENCY * 3 }, (_, i) =>
      bmNode({ name: `metal-${i}`, bmc_ip: `10.10.1.${i}`, pxe_mac: `00:00:5e:00:54:${String(i).padStart(2, '0')}` }),
    );
    const hosts = Object.fromEntries(nodes.map((n) => [n.bmc_ip, 'On']));
    wireRedfish(hosts, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setImmediate(r));
      inFlight -= 1;
    });
    const svc = makeService({ nodes });

    const machines = await svc.machines();
    expect(machines).toHaveLength(nodes.length);
    expect(peak).toBeLessThanOrEqual(BMC_PROBE_CONCURRENCY);
  });

  it('reports auth-failed on a 401 and unreachable on a refused connection', async () => {
    wireRedfish({ '10.10.0.5': 401 });
    const svc = makeService({
      nodes: [
        bmNode({ name: 'metal-locked', pxe_mac: '00:00:5e:00:53:b1' }),
        bmNode({ name: 'metal-dead', bmc_ip: '10.10.0.99', pxe_mac: '00:00:5e:00:53:b9' }),
      ],
    });

    const machines = await svc.machines();
    expect(machines.map((m) => m.bmc)).toEqual([
      { reachable: 'auth-failed', powerState: null },
      { reachable: 'unreachable', powerState: null },
    ]);
    expect(machines.map((m) => m.power)).toEqual(['unknown', 'unknown']);
  });

  it('reports unconfigured without a request when the machine has no bmc address', async () => {
    wireRedfish({ '10.10.0.5': 'On' });
    const svc = makeService({ nodes: [bmNode({ name: 'metal-1', bmc_ip: '' })] });

    const [row] = await svc.machines();
    expect(row.bmc).toEqual({ reachable: 'unconfigured', powerState: null });
    expect(row.power).toBe('unknown');
    expect(requestMock).not.toHaveBeenCalled();
  });
});

describe('FleetPowerService.machines bmc auth backoff', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ['Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('holds auth-failed without a redfish call on the next poll after a 401', async () => {
    wireRedfish({ '10.10.0.5': 401 });
    const svc = makeService({ nodes: [bmNode({ name: 'metal-locked' })] });

    await svc.machines();
    requestMock.mockClear();

    const [row] = await svc.machines();
    expect(row.bmc).toEqual({ reachable: 'auth-failed', powerState: null });
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('probes again once the backoff window has elapsed', async () => {
    wireRedfish({ '10.10.0.5': 401 });
    const svc = makeService({ nodes: [bmNode({ name: 'metal-locked' })] });

    await svc.machines();
    requestMock.mockClear();
    vi.setSystemTime(Date.now() + AUTH_FAILED_BACKOFF_MS);

    const [row] = await svc.machines();
    expect(row.bmc).toEqual({ reachable: 'auth-failed', powerState: null });
    expect(requestMock).toHaveBeenCalledTimes(1);
  });

  it('probes immediately when the saved credential changes', async () => {
    wireRedfish({ '10.10.0.5': 401 });
    const opts = {
      nodes: [bmNode({ name: 'metal-locked' })],
      credByNode: { 'metal-locked': { user: 'root', pass: 'wrong' } },
    };
    const svc = makeService(opts);

    await svc.machines();
    requestMock.mockClear();
    opts.credByNode['metal-locked'] = { user: 'root', pass: 'right' };
    wireRedfish({ '10.10.0.5': 'On' });

    const [row] = await svc.machines();
    expect(row.bmc).toEqual({ reachable: 'ok', powerState: 'On' });
  });

  it('holds only the rejected machine and keeps probing the one that answered', async () => {
    wireRedfish({ '10.10.0.5': 'On', '10.10.0.7': 401 });
    const svc = makeService({
      nodes: [
        bmNode({ name: 'metal-1', pxe_mac: '00:00:5e:00:53:b1' }),
        bmNode({ name: 'metal-locked', bmc_ip: '10.10.0.7', pxe_mac: '00:00:5e:00:53:b7' }),
      ],
    });

    await svc.machines();
    requestMock.mockClear();

    const machines = await svc.machines();
    expect(machines.map((m) => m.bmc?.reachable)).toEqual(['ok', 'auth-failed']);
    expect(requestMock.mock.calls.map(([url]) => new URL(url).host)).toEqual(['10.10.0.5', '10.10.0.5']);
  });
});

describe('FleetPowerService.machines with vm nodes only', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it('still reads libvirt and never touches a BMC', async () => {
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('list'))
        return fakeVirshChild([' Id   Name       State', ' 1    cpu-1      running', ''].join('\n'));
      return fakeVirshChild('');
    });
    const svc = makeService({ planes: VM_ONLY, vmNames: ['cpu-1', 'cpu-2'] });

    await expect(svc.machines()).resolves.toEqual([
      { name: 'cpu-1', kind: 'vm', power: 'on', configured: true, deviceId: simDeviceUuid(0), bmc: null },
      { name: 'cpu-2', kind: 'vm', power: 'unknown', configured: true, deviceId: simDeviceUuid(1), bmc: null },
    ]);
    expect(requestMock).not.toHaveBeenCalled();
  });
});

function makeRun(): RunState {
  return {
    runId: 'power-run',
    section: 'fleet',
    opId: 'power',
    label: 'power',
    status: 'running',
    startedAt: 1,
    exitCode: null,
    log$: new Subject<string>(),
    lines: [],
    bytes: 0,
    nodeIndex: null,
  };
}

async function makePowerService(opts: {
  planes?: FleetPlanes;
  nodes?: BareMetalNode[];
  vmNames?: string[];
  credByNode?: Record<string, { user: string; pass: string } | null>;
}) {
  const run = makeRun();
  const runner = {
    create: vi.fn(() => run),
    emit: vi.fn((r: RunState, text: string) => {
      r.lines.push(text);
    }),
    finalize: vi.fn(),
    spawn: vi.fn(() => Promise.resolve(0)),
  };
  const lease = { key: 'node:metal-1', bind: vi.fn(), release: vi.fn() };
  const acquire = vi.fn(() => lease);
  const moduleRef = await Test.createTestingModule({
    providers: [
      FleetPowerService,
      { provide: RunnerService, useValue: runner },
      { provide: OverlayStoreService, useValue: { planes: () => opts.planes ?? BM_ONLY } },
      {
        provide: FleetTopologyService,
        useValue: {
          nodeNames: () => opts.vmNames ?? [],
          baremetalView: () => ({ nodes: opts.nodes ?? [] }),
          hostFacts: () => ({ os: 'linux' }),
          resolveBmcCred: (name: string) =>
            opts.credByNode ? (opts.credByNode[name] ?? null) : { user: 'root', pass: 'secret' },
        },
      },
      { provide: FleetOpRegistry, useValue: { acquire } },
    ],
  }).compile();
  return { svc: moduleRef.get(FleetPowerService), runner, run, lease, acquire };
}

describe('FleetPowerService.power by node kind', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it('powers a bare-metal machine from the fleet route through Redfish', async () => {
    wireRedfish({ '10.10.0.5': 'On' });
    const { svc, runner, run, lease } = await makePowerService({ nodes: [bmNode({ name: 'metal-1' })] });

    expect(svc.power('metal-1', 'cycle')).toBe('power-run');

    await vi.waitFor(() => expect(runner.finalize).toHaveBeenCalledWith(run, 0));
    const post = requestMock.mock.calls.find(([, options]) => options.method === 'POST');
    expect(post).toBeDefined();
    expect(post?.[0]).toBe(`https://10.10.0.5${SYSTEM}/Actions/ComputerSystem.Reset`);
    expect(JSON.parse(post?.[1].body)).toEqual({ ResetType: 'PowerCycle' });
    expect(run.lines.join('')).toContain('metal-1: PowerCycle → On');
    await vi.waitFor(() => expect(lease.release).toHaveBeenCalled());
  });

  it('rejects with 400 and creates no run when a bare-metal machine has no bmc credentials', async () => {
    const { svc, runner, acquire } = await makePowerService({
      nodes: [bmNode({ name: 'metal-1' })],
      credByNode: { 'metal-1': null },
    });

    expect(() => svc.power('metal-1', 'on')).toThrow(BadRequestException);
    expect(runner.create).not.toHaveBeenCalled();
    expect(acquire).not.toHaveBeenCalled();
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('rejects with 400 and creates no run when a bare-metal machine has no bmc address', async () => {
    const { svc, runner, acquire } = await makePowerService({ nodes: [bmNode({ name: 'metal-1', bmc_ip: '' })] });

    expect(() => svc.power('metal-1', 'on')).toThrow(BadRequestException);
    expect(runner.create).not.toHaveBeenCalled();
    expect(acquire).not.toHaveBeenCalled();
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('finalizes 1 in the run log when the bmc rejects the reset', async () => {
    requestMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/redfish/v1/Systems')) return resp(200, { Members: [{ '@odata.id': SYSTEM }] });
      if (url.endsWith(SYSTEM)) return resp(200, { PowerState: 'Off' });
      return resp(403, { error: 'rejected' });
    });
    const { svc, runner, run, lease } = await makePowerService({ nodes: [bmNode({ name: 'metal-1' })] });

    expect(svc.power('metal-1', 'on')).toBe('power-run');

    await vi.waitFor(() => expect(runner.finalize).toHaveBeenCalledWith(run, 1));
    expect(run.lines.join('')).toContain('Reset On → 403');
    await vi.waitFor(() => expect(lease.release).toHaveBeenCalled());
  });

  it('rejects an unknown machine with 404', async () => {
    const { svc, runner } = await makePowerService({ nodes: [bmNode({ name: 'metal-1' })] });

    expect(() => svc.power('ghost', 'on')).toThrow(NotFoundException);
    expect(runner.create).not.toHaveBeenCalled();
  });

  it('still drives a vm through the simulated bmc script', async () => {
    spawnMock.mockImplementation((_cmd: string, args: string[]) =>
      fakeVirshChild(
        args.includes('list') ? [' Id   Name       State', ' 1    cpu-1      running', ''].join('\n') : '',
      ),
    );
    const { svc, runner, run } = await makePowerService({ planes: VM_ONLY, vmNames: ['cpu-1'] });

    svc.power('cpu-1', 'on');

    await vi.waitFor(() => expect(runner.finalize).toHaveBeenCalledWith(run, 0));
    expect(runner.spawn).toHaveBeenCalledWith(run, 'bash', ['scripts/tasks/redfish.sh', 'cpu-1', 'power-on']);
    expect(requestMock).not.toHaveBeenCalled();
  });
});
