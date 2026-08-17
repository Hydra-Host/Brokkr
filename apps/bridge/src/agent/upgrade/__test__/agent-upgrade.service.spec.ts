import { describe, expect, it, vi } from 'vitest';

import {
  AgentNotConnected,
  AgentVersionMismatch,
  DispatchFailed,
  DispatchTimeout,
} from '../../dispatch/grpc.exceptions';
import { AgentUpgradeRateLimited, AgentUpgradeService, type AgentUpgradeServiceDeps } from '../agent-upgrade.service';

interface FakeCacheState {
  existsKeys: Set<string>;
  lockResult: string | null;
  sets: [string, string][];
}

function makeDeps(
  state: Partial<FakeCacheState> = {},
  overrides: Partial<AgentUpgradeServiceDeps> = {},
): {
  deps: AgentUpgradeServiceDeps;
  sets: [string, string][];
  released: string[];
} {
  const existsKeys = state.existsKeys ?? new Set<string>();
  const sets: [string, string][] = [];
  const released: string[] = [];
  const deps: AgentUpgradeServiceDeps = {
    cache: {
      exists: vi.fn(async (key: string) => existsKeys.has(key)),
      set: vi.fn(async (key: string, value: string) => {
        sets.push([key, value]);
        return true;
      }),
      secretSet: vi.fn().mockResolvedValue(true),
      acquireLock: vi.fn().mockResolvedValue(state.lockResult === undefined ? 'lock-token' : state.lockResult),
      releaseLock: vi.fn(async (key: string) => {
        released.push(key);
        return true;
      }),
    },
    dispatch: vi.fn().mockResolvedValue({}),
    deviceService: { getDeviceById: vi.fn().mockResolvedValue({ id: 'dev-1' }) },
    tokenService: { mintOrReuseDevice: vi.fn().mockResolvedValue('tok') },
    bridgeRegistry: { getAllBridgeHostnames: vi.fn().mockResolvedValue(['bridge-a']) },
    grpcConfig: { externalPort: 443 },
    renderAgentYaml: vi.fn().mockResolvedValue('rendered: yaml\n'),
    bundleSha256: vi.fn().mockResolvedValue('bundle-sha'),
    unitSha256: vi.fn().mockResolvedValue('unit-sha'),
    ...overrides,
  };
  return { deps, sets, released };
}

const PARAMS = {
  deviceId: 'dev-1',
  currentVersion: '1.0.0',
  expectedVersion: '1.1.0',
  jobId: 'job-1',
};

describe('AgentUpgradeService.upgradeAgent', () => {
  it('skips identity dispatch', async () => {
    const { deps } = makeDeps();
    const service = new AgentUpgradeService(deps);
    expect(await service.upgradeAgent({ ...PARAMS, expectedVersion: '1.0.0' })).toBe(false);
    expect(deps.dispatch).not.toHaveBeenCalled();
  });

  it('defers when the saga lock is held', async () => {
    const { deps } = makeDeps({ existsKeys: new Set(['device:dev-1']) });
    const service = new AgentUpgradeService(deps);
    expect(await service.upgradeAgent(PARAMS)).toBe(false);
    expect(deps.dispatch).not.toHaveBeenCalled();
  });

  it('returns false when the upgrade lock is contended', async () => {
    const { deps } = makeDeps({ lockResult: null });
    const service = new AgentUpgradeService(deps);
    expect(await service.upgradeAgent(PARAMS)).toBe(false);
  });

  it('raises AgentUpgradeRateLimited inside the cooldown window', async () => {
    const { deps, released } = makeDeps({
      existsKeys: new Set(['agent-upgrade:cooldown:dev-1']),
    });
    const service = new AgentUpgradeService(deps);
    await expect(service.upgradeAgent(PARAMS)).rejects.toThrow(AgentUpgradeRateLimited);
    expect(released).toEqual(['agent-upgrade:dev-1']);
  });

  it('dispatches the payload with config sha and sets the cooldown', async () => {
    const dispatch = vi.fn().mockResolvedValue({});
    const { deps, sets } = makeDeps({}, { dispatch });
    const service = new AgentUpgradeService(deps);

    expect(await service.upgradeAgent(PARAMS)).toBe(true);

    const [deviceId, operation, payload] = dispatch.mock.calls[0] as [string, string, Record<string, unknown>];
    expect(deviceId).toBe('dev-1');
    expect(operation).toBe('agent.upgrade');
    expect(payload.sha256).toBe('bundle-sha');
    expect(payload.expected_version).toBe('1.1.0');
    expect(payload.unit_sha256).toBe('unit-sha');
    expect(typeof payload.config_sha256).toBe('string');
    expect(sets.some(([key]) => key === 'agent-upgrade:cooldown:dev-1')).toBe(true);
  });

  it('omits config_sha256 when the device lookup fails', async () => {
    const dispatch = vi.fn().mockResolvedValue({});
    const { deps } = makeDeps(
      {},
      {
        dispatch,
        deviceService: {
          getDeviceById: vi.fn().mockRejectedValue(new Error('device missing')),
        },
      },
    );
    const service = new AgentUpgradeService(deps);

    expect(await service.upgradeAgent(PARAMS)).toBe(true);
    const payload = dispatch.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(payload).not.toHaveProperty('config_sha256');
  });

  it('returns false on DispatchFailed without entering cooldown', async () => {
    const dispatch = vi.fn().mockRejectedValue(new DispatchFailed('BOOM', 'agent failed'));
    const { deps, sets } = makeDeps({}, { dispatch });
    const service = new AgentUpgradeService(deps);

    expect(await service.upgradeAgent(PARAMS)).toBe(false);
    expect(sets).toEqual([]);
  });

  it('returns false on AgentVersionMismatch without entering cooldown', async () => {
    const dispatch = vi.fn().mockRejectedValue(new AgentVersionMismatch('dev-1', '1.0.0', '1.1.0'));
    const { deps, sets } = makeDeps({}, { dispatch });
    const service = new AgentUpgradeService(deps);

    expect(await service.upgradeAgent(PARAMS)).toBe(false);
    expect(sets).toEqual([]);
  });

  it('returns true on AgentNotConnected and sets the cooldown', async () => {
    const dispatch = vi.fn().mockRejectedValue(new AgentNotConnected('dev-1'));
    const { deps, sets } = makeDeps({}, { dispatch });
    const service = new AgentUpgradeService(deps);

    expect(await service.upgradeAgent(PARAMS)).toBe(true);
    expect(sets.some(([key]) => key === 'agent-upgrade:cooldown:dev-1')).toBe(true);
  });

  it('returns true on DispatchTimeout and sets the cooldown', async () => {
    const dispatch = vi.fn().mockRejectedValue(new DispatchTimeout('timed out'));
    const { deps, sets } = makeDeps({}, { dispatch });
    const service = new AgentUpgradeService(deps);

    expect(await service.upgradeAgent(PARAMS)).toBe(true);
    expect(sets.some(([key]) => key === 'agent-upgrade:cooldown:dev-1')).toBe(true);
  });

  it('dispatches without config refresh when the render exceeds its budget', async () => {
    const dispatch = vi.fn().mockResolvedValue({});
    const slowRender = vi.fn(
      () => new Promise<string>((resolveRender) => setTimeout(() => resolveRender('late'), 200)),
    );
    const { deps } = makeDeps({}, { dispatch, renderAgentYaml: slowRender, renderTimeoutS: 0.05 });
    const service = new AgentUpgradeService(deps);

    expect(await service.upgradeAgent(PARAMS)).toBe(true);
    const payload = dispatch.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(payload).not.toHaveProperty('config_sha256');
  });

  it('releases the lock even when dispatch raises an unexpected error', async () => {
    const dispatch = vi.fn().mockRejectedValue(new Error('unexpected'));
    const { deps, released } = makeDeps({}, { dispatch });
    const service = new AgentUpgradeService(deps);

    await expect(service.upgradeAgent(PARAMS)).rejects.toThrow('unexpected');
    expect(released).toEqual(['agent-upgrade:dev-1']);
  });
});
