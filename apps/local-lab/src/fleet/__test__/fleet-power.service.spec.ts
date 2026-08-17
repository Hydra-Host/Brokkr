import { BadRequestException, NotFoundException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FleetPowerService, RedfishError } from '../fleet-power.service';

const { requestMock } = vi.hoisted(() => ({ requestMock: vi.fn() }));
vi.mock('undici', () => ({
  request: requestMock,
  Agent: class {
    close = vi.fn();
  },
}));

const SYSTEM = '/redfish/v1/Systems/1';

function resp(statusCode: number, json: unknown) {
  return { statusCode, body: { text: async () => JSON.stringify(json) } };
}

function wireRedfish(allowable: string[], powerState = 'On') {
  requestMock.mockImplementation((url: string, opts: { method: string }) => {
    if (opts.method === 'GET' && url.endsWith('/redfish/v1/Systems')) {
      return Promise.resolve(resp(200, { Members: [{ '@odata.id': SYSTEM }] }));
    }
    if (opts.method === 'GET' && url.endsWith(SYSTEM)) {
      return Promise.resolve(
        resp(200, {
          PowerState: powerState,
          Actions: { '#ComputerSystem.Reset': { 'ResetType@Redfish.AllowableValues': allowable } },
        }),
      );
    }
    if (opts.method === 'POST' && url.includes('ComputerSystem.Reset')) {
      return Promise.resolve(resp(204, {}));
    }
    throw new Error(`unexpected redfish call: ${opts.method} ${url}`);
  });
}

function makeService(opts: {
  mode?: string;
  os?: string;
  nodes?: { name: string; bmc_ip: string; system_id: string | null }[];
  cred?: { user: string; pass: string } | null;
}) {
  const overlay = { fleetMode: () => opts.mode ?? 'baremetal' };
  const topology = {
    hostFacts: vi.fn(() => ({ os: opts.os ?? 'linux' })),
    baremetalView: vi.fn(() => ({
      nodes: opts.nodes ?? [{ name: 'metal-1', bmc_ip: '192.168.1.50', system_id: null }],
    })),
    resolveBmcCred: vi.fn(() => (opts.cred === undefined ? { user: 'root', pass: 'secret' } : opts.cred)),
  };
  return new FleetPowerService({} as never, overlay as never, topology as never, {} as never);
}

describe('FleetPowerService.baremetalPower — guards', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it('rejects when the fleet is not in baremetal mode', async () => {
    const svc = makeService({ mode: 'vm' });
    await expect(svc.baremetalPower('metal-1', 'on')).rejects.toBeInstanceOf(BadRequestException);
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('rejects on a non-Linux host', async () => {
    const svc = makeService({ os: 'darwin' });
    await expect(svc.baremetalPower('metal-1', 'on')).rejects.toBeInstanceOf(BadRequestException);
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('rejects an unknown machine name', async () => {
    const svc = makeService({ nodes: [] });
    await expect(svc.baremetalPower('ghost', 'on')).rejects.toBeInstanceOf(NotFoundException);
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('rejects when the node has no BMC credentials', async () => {
    const svc = makeService({ cred: null });
    await expect(svc.baremetalPower('metal-1', 'on')).rejects.toBeInstanceOf(BadRequestException);
    expect(requestMock).not.toHaveBeenCalled();
  });
});

describe('FleetPowerService.baremetalPower — action → ResetType', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  const cases: [Parameters<FleetPowerService['baremetalPower']>[1], string][] = [
    ['on', 'On'],
    ['off', 'ForceOff'],
    ['reset', 'ForceRestart'],
    ['powercycle', 'PowerCycle'],
  ];

  for (const [action, expected] of cases) {
    it(`maps ${action} → ${expected}`, async () => {
      const svc = makeService({});
      wireRedfish(['On', 'ForceOff', 'GracefulShutdown', 'ForceRestart', 'GracefulRestart', 'PowerCycle'], 'On');
      const out = await svc.baremetalPower('metal-1', action);
      expect(out.resetType).toBe(expected);
      expect(out.action).toBe(action);
      expect(out.powerState).toBe('On');
      const post = requestMock.mock.calls.find(([, o]) => o.method === 'POST');
      expect(post).toBeDefined();
      const body: unknown = post![1].body;
      expect(typeof body).toBe('string');
      expect(JSON.parse(typeof body === 'string' ? body : '{}')).toEqual({ ResetType: expected });
    });
  }
});

describe('FleetPowerService.baremetalPower — transport errors → RedfishError (502, no cred leak)', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it('remaps a plain transport error to RedfishError and never leaks the BMC credential', async () => {
    requestMock.mockImplementation(async () => {
      throw new Error('ECONNREFUSED 192.168.1.50:443');
    });
    const svc = makeService({ cred: { user: 'root', pass: 'hunter2' } });
    const err = await svc.baremetalPower('metal-1', 'on').then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(RedfishError);
    expect((err as Error).message).toMatch(/unreachable/);
    expect((err as Error).message).not.toMatch(/hunter2/);
  });
});
