import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HostPluginDeviceOpsRequests } from '../host-plugin-device-ops-requests';
import type { OperatorDeviceOpsService } from '../operator-device-ops.service';

describe('HostPluginDeviceOpsRequests', () => {
  const deviceOps = {
    forceDiscovery: vi.fn(),
    runBenchmarks: vi.fn(),
    activateRescueMode: vi.fn(),
    deactivateRescueMode: vi.fn(),
  };

  let adapter: HostPluginDeviceOpsRequests;

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = new HostPluginDeviceOpsRequests(deviceOps as unknown as OperatorDeviceOpsService);
  });

  it('proxies force discovery', async () => {
    deviceOps.forceDiscovery.mockResolvedValue({ jobId: 'job-1' });

    const result = await adapter.requestForceDiscovery({ deviceId: 'device-1' });

    expect(deviceOps.forceDiscovery).toHaveBeenCalledWith('device-1');
    expect(result).toEqual({ jobId: 'job-1' });
  });

  it('maps an enqueued benchmarks result to the SDK camelCase shape', async () => {
    deviceOps.runBenchmarks.mockResolvedValue({
      enqueued: true,
      plan_id: 'plan-1',
      gpu_burn_run_id: 'gpu-1',
      nccl_run_id: 'nccl-1',
    });

    const result = await adapter.requestRunBenchmarks({ deviceId: 'device-1' });

    expect(result).toEqual({ enqueued: true, planId: 'plan-1', gpuBurnRunId: 'gpu-1', ncclRunId: 'nccl-1' });
  });

  it('maps a skipped benchmarks result', async () => {
    deviceOps.runBenchmarks.mockResolvedValue({ skipped: true });

    const result = await adapter.requestRunBenchmarks({ deviceId: 'device-1' });

    expect(result).toEqual({ enqueued: false, skipped: true });
  });

  it('proxies rescue mode activation with the requested OS slug', async () => {
    await adapter.requestActivateRescueMode({ deviceId: 'device-1', rescueOsSlug: 'custom-rescue' });
    expect(deviceOps.activateRescueMode).toHaveBeenCalledWith('device-1', 'custom-rescue');
  });

  it('proxies rescue mode activation with an undefined slug so the service default applies', async () => {
    await adapter.requestActivateRescueMode({ deviceId: 'device-1' });
    expect(deviceOps.activateRescueMode).toHaveBeenCalledWith('device-1', undefined);
  });

  it('proxies rescue mode deactivation', async () => {
    await adapter.requestDeactivateRescueMode({ deviceId: 'device-1' });
    expect(deviceOps.deactivateRescueMode).toHaveBeenCalledWith('device-1');
  });
});
