import { Test } from '@nestjs/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { simDeviceUuid } from '../../common/hub-client';
import type { Machine } from '../../contract';
import { RunnerService } from '../../runner/runner.service';
import { OverlayStoreService } from '../../services/overlay-store';
import { FleetOpRegistry } from '../fleet-op-registry';
import { FleetPowerService } from '../fleet-power.service';
import { FleetTopologyService } from '../fleet-topology.service';
import { fakeVirshChild } from './virsh-spawn-harness';

const { spawnMock, slot } = vi.hoisted(() => ({ spawnMock: vi.fn(), slot: { value: 0 } }));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: spawnMock };
});

vi.mock('../../ports', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../ports')>();
  return {
    ...actual,
    get STACK_SLOT() {
      return slot.value;
    },
  };
});

const LIST = [
  ' Id   Name       State',
  '-------------------------',
  ' 1    cpu-1      running',
  ' -    cpu-2      shut off',
  ' 3    ghost      running',
  ' 4    s1-ghost   running',
  '',
].join('\n');

function wireVirsh(tagByDomain: Record<string, string>) {
  spawnMock.mockImplementation((_cmd: string, args: string[]) => {
    if (args.includes('list')) return fakeVirshChild(LIST);
    if (args.includes('metadata')) {
      const name = args[args.indexOf('metadata') + 1];
      const tag = tagByDomain[name];
      return fakeVirshChild(
        tag ? `<brokkr:managed xmlns:brokkr='https://brokkr.local/sim/v1'>${tag}</brokkr:managed>` : '',
      );
    }
    throw new Error(`unexpected virsh call: ${args.join(' ')}`);
  });
}

const TAGGED = { ghost: 'brokkr-local', 's1-ghost': 'brokkr-local-s1' };

async function listMachines(names: string[]): Promise<Machine[]> {
  const moduleRef = await Test.createTestingModule({
    providers: [
      FleetPowerService,
      { provide: RunnerService, useValue: {} },
      { provide: OverlayStoreService, useValue: { planes: () => ({ vm: true, baremetal: false }) } },
      {
        provide: FleetTopologyService,
        useValue: { nodeNames: vi.fn(() => names), baremetalView: () => ({ nodes: [] }) },
      },
      { provide: FleetOpRegistry, useValue: {} },
    ],
  }).compile();
  return moduleRef.get(FleetPowerService).machines();
}

describe('FleetPowerService.machines', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    slot.value = 0;
  });
  afterEach(() => vi.restoreAllMocks());

  it('derives each configured machine device id from its fleet index', async () => {
    wireVirsh({});
    const machines = await listMachines(['cpu-1', 'cpu-2']);
    expect(machines).toEqual([
      { name: 'cpu-1', kind: 'vm', power: 'on', configured: true, deviceId: simDeviceUuid(0), bmc: null },
      { name: 'cpu-2', kind: 'vm', power: 'off', configured: true, deviceId: simDeviceUuid(1), bmc: null },
    ]);
  });

  it('keeps the index-to-device-id mapping aligned with the fleet order, not the virsh order', async () => {
    wireVirsh({});
    const machines = await listMachines(['cpu-2', 'cpu-1']);
    expect(machines.map((m) => m.deviceId)).toEqual([simDeviceUuid(0), simDeviceUuid(1)]);
    expect(machines.map((m) => m.name)).toEqual(['cpu-2', 'cpu-1']);
  });

  it('leaves an unconfigured domain without a device id, since it has no fleet index', async () => {
    wireVirsh({ ghost: 'brokkr-local' });
    const machines = await listMachines(['cpu-1', 'cpu-2']);
    expect(machines.find((m) => m.name === 'ghost')).toEqual({
      name: 'ghost',
      kind: 'vm',
      power: 'on',
      configured: false,
      deviceId: null,
      bmc: null,
    });
  });

  it('emits a device id that round-trips back to the fleet index', async () => {
    wireVirsh({});
    const machines = await listMachines(['cpu-1', 'cpu-2', 'gpu-1']);
    expect(machines[2].deviceId).toBe('00000000-0000-0000-0000-000000000003');
  });

  it('adopts only the legacy-tagged orphan on slot 0', async () => {
    wireVirsh(TAGGED);
    const machines = await listMachines(['cpu-1', 'cpu-2']);
    expect(machines.map((m) => m.name)).toEqual(['cpu-1', 'cpu-2', 'ghost']);
  });

  it('adopts only its own slot-tagged orphan on slot 1', async () => {
    slot.value = 1;
    wireVirsh(TAGGED);
    const machines = await listMachines(['cpu-1', 'cpu-2']);
    expect(machines.map((m) => m.name)).toEqual(['cpu-1', 'cpu-2', 's1-ghost']);
  });

  it('reads the managed tag through virsh metadata --uri', async () => {
    wireVirsh(TAGGED);
    await listMachines(['cpu-1', 'cpu-2']);
    const metadataCall = spawnMock.mock.calls.find((call) => call[1].includes('metadata'));
    expect(metadataCall?.[1]).toEqual([
      '-c',
      expect.any(String),
      'metadata',
      'ghost',
      '--uri',
      'https://brokkr.local/sim/v1',
    ]);
  });

  it('bounds every virsh call with a kill timer', async () => {
    wireVirsh(TAGGED);
    await listMachines(['cpu-1', 'cpu-2']);
    expect(spawnMock.mock.calls.length).toBeGreaterThan(1);
    for (const call of spawnMock.mock.calls) {
      expect(call[2].timeout).toBeGreaterThan(0);
      expect(call[2].killSignal).toBe('SIGKILL');
    }
  });
});
