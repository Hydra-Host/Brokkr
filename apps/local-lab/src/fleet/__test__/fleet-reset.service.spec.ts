import { NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Subject } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { bmDeviceUuid, simDeviceUuid } from '../../common/hub-client';
import { RedisConnectionsService } from '../../datastore/redis-connections.service';
import { QueueReaderService } from '../../queues/queue-reader.service';
import { RunnerService, type RunState } from '../../runner/runner.service';
import { FleetOpRegistry } from '../fleet-op-registry';
import { FleetPowerService } from '../fleet-power.service';
import { FleetResetService } from '../fleet-reset.service';
import { resolveRoster, type RosterNode } from '../fleet-roster';

const { pgQuery } = vi.hoisted(() => ({ pgQuery: vi.fn() }));

vi.mock('pg', async (importOriginal) => {
  const actual = await importOriginal<typeof import('pg')>();
  return {
    ...actual,
    Pool: class {
      connect = () => Promise.resolve({ query: pgQuery, release: vi.fn() });
      end = () => Promise.resolve();
    },
  };
});

vi.mock('ioredis', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ioredis')>();
  return {
    ...actual,
    default: class {
      on = vi.fn();
      disconnect = vi.fn();
      scan = () => Promise.resolve(['0', []]);
      multi = () => ({
        del: vi.fn(),
        lrem: vi.fn(),
        zrem: vi.fn(),
        srem: vi.fn(),
        exec: () => Promise.resolve([[null, 3]]),
      });
    },
  };
});

function makeService(inFlight: number) {
  const queueReader = { inFlightCount: vi.fn(() => Promise.resolve(inFlight)) };
  const svc = new FleetResetService({} as never, queueReader as never, {} as never, {} as never, {} as never);
  return { svc, queueReader };
}

describe('FleetResetService.countActiveSagaJobs — active-saga guard', () => {
  it('delegates to the queue reader and returns its number unchanged', async () => {
    const { svc, queueReader } = makeService(5);
    await expect(svc.countActiveSagaJobs()).resolves.toBe(5);
    expect(queueReader.inFlightCount).toHaveBeenCalledTimes(1);
  });

  it('passes a zero straight through (no block) rather than substituting a floor of its own', async () => {
    const { svc } = makeService(0);
    await expect(svc.countActiveSagaJobs()).resolves.toBe(0);
  });
});

const VM_ROSTER = resolveRoster({ vmNodeNames: () => ['cpu-1', 'cpu-2'], baremetalNodes: () => [] });
const BM_ROSTER = resolveRoster({
  vmNodeNames: () => [],
  baremetalNodes: () => [
    {
      name: 'metal-1',
      bmc_ip: '10.10.0.5',
      bmc_mac: 'aa:bb:cc:dd:ee:01',
      pxe_mac: '00:00:5e:00:53:b1',
      arch: null,
      system_id: null,
    },
  ],
});

function wirePg(deviceId: string) {
  pgQuery.mockImplementation((sql: string) => {
    if (sql.includes('FROM "Server"')) return Promise.resolve({ rows: [{ id: 'server-1' }], rowCount: 1 });
    if (sql.includes('FROM "Device"'))
      return Promise.resolve({ rows: [{ id: deviceId, name: 'device', zoneId: 'zone-1' }], rowCount: 1 });
    return Promise.resolve({ rows: [], rowCount: 0 });
  });
}

function makeRun(): RunState {
  return {
    runId: 'reset-run',
    section: 'fleet',
    opId: 'reset',
    label: 'reset',
    status: 'running',
    startedAt: 1,
    exitCode: null,
    log$: new Subject<string>(),
    lines: [],
    bytes: 0,
    nodeIndex: null,
  };
}

async function makeResetService(roster: RosterNode[]) {
  const run = makeRun();
  const runner = {
    create: vi.fn(() => run),
    emit: vi.fn((r: RunState, text: string) => {
      r.lines.push(text);
    }),
    finalize: vi.fn(),
  };
  const power = {
    roster: () => roster,
    powerCycleRedfish: vi.fn(() => Promise.resolve(0)),
    baremetalPower: vi.fn(() => Promise.resolve({ powerState: 'On', action: 'powercycle', resetType: 'PowerCycle' })),
  };
  const lease = { key: 'fleet', bind: vi.fn(), release: vi.fn() };
  const moduleRef = await Test.createTestingModule({
    providers: [
      FleetResetService,
      { provide: RunnerService, useValue: runner },
      { provide: QueueReaderService, useValue: {} },
      { provide: FleetPowerService, useValue: power },
      { provide: FleetOpRegistry, useValue: { acquire: vi.fn(() => lease) } },
      { provide: RedisConnectionsService, useValue: { url: () => 'redis://127.0.0.1:6379' } },
    ],
  }).compile();
  return { svc: moduleRef.get(FleetResetService), runner, run, power };
}

describe('FleetResetService.reset by roster node', () => {
  beforeEach(() => vi.clearAllMocks());

  it('resets a bare-metal machine by its pxe-derived device id', async () => {
    const deviceId = bmDeviceUuid('00:00:5e:00:53:b1');
    wirePg(deviceId);
    const { svc, runner, run, power } = await makeResetService(BM_ROSTER);

    svc.reset('metal-1');

    await vi.waitFor(() => expect(runner.finalize).toHaveBeenCalledWith(run, 0));
    expect(pgQuery).toHaveBeenCalledWith('SELECT id FROM "Server" WHERE "deviceId" = $1', [deviceId]);
    expect(power.baremetalPower).toHaveBeenCalledWith('metal-1', 'powercycle');
    expect(power.powerCycleRedfish).not.toHaveBeenCalled();
  });

  it('power-cycles a vm through the simulated redfish script', async () => {
    wirePg(simDeviceUuid(0));
    const { svc, runner, run, power } = await makeResetService(VM_ROSTER);

    svc.reset('cpu-1');

    await vi.waitFor(() => expect(runner.finalize).toHaveBeenCalledWith(run, 0));
    expect(power.powerCycleRedfish).toHaveBeenCalledWith('cpu-1');
    expect(power.baremetalPower).not.toHaveBeenCalled();
  });

  it('rejects an unknown machine name with 404 before creating a run', async () => {
    const { svc, runner } = await makeResetService(BM_ROSTER);

    expect(() => svc.reset('ghost')).toThrow(NotFoundException);
    expect(runner.create).not.toHaveBeenCalled();
  });
});
