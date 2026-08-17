import { describe, expect, it, vi } from 'vitest';

import { NonRetryableSagaError } from '../../../saga-framework/saga-runner.service.js';
import type { SagaContext } from '../../../saga-framework/saga.types.js';
import { DeployOsStep } from '../deploy-os.step.js';

function makeCtx(overrides: Partial<SagaContext> = {}): SagaContext {
  return {
    planId: 'plan-1',
    stepName: 'deploy_os',
    deviceId: 'dev-1',
    payload: {},
    jobId: 'job-1',
    attempt: 1,
    metadata: {},
    stepResults: {},
    ...overrides,
  };
}

function validDeviceData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    netplan: 'network:\n  version: 2\n',
    gpu_model: 'h100',
    purge_ttys: true,
    serial_port: 'ttyS0',
    serial_baud: 115200,
    device_type: 'gpu',
    network_type: 'ethernet',
    ...overrides,
  };
}

function makeStep() {
  const deployOs = vi.fn().mockResolvedValue({ deployed: true });
  const factory = { create: vi.fn().mockResolvedValue({ deployOs }) };
  const logger = { warning: vi.fn().mockResolvedValue(undefined) };
  const step = new DeployOsStep(factory, logger);
  return { step, factory, deployOs, logger };
}

describe('DeployOsStep', () => {
  it('throws a NonRetryableSagaError when device_id is missing (non-orchestration guard)', async () => {
    const { step } = makeStep();
    await expect(step.execute(makeCtx({ deviceId: null }))).rejects.toBeInstanceOf(NonRetryableSagaError);
    await expect(step.execute(makeCtx({ deviceId: null }))).rejects.toThrow('device_id is required');
  });

  it('propagates the skipped signal from resolve_deploy_target without calling orchestration', async () => {
    const { step, factory } = makeStep();
    const ctx = makeCtx({
      stepResults: { resolve_deploy_target: { skipped: true, reason: 'ipxe_url provided' } },
    });

    const result = await step.execute(ctx);

    expect(result).toEqual({ skipped: true, reason: 'ipxe_url provided' });
    expect(factory.create).not.toHaveBeenCalled();
  });

  it('throws a NonRetryableSagaError when device_data.netplan is missing', async () => {
    const { step, factory } = makeStep();
    const ctx = makeCtx({
      payload: { device_data: validDeviceData({ netplan: null }) },
    });

    const error = await step.execute(ctx).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NonRetryableSagaError);
    expect((error as Error).message).toContain('netplan');
    expect(factory.create).not.toHaveBeenCalled();
  });

  it('warns (using defaults) but still deploys when payload-required fields are missing', async () => {
    const { step, logger, deployOs } = makeStep();
    const ctx = makeCtx({
      payload: { device_data: { netplan: 'network:\n  version: 2\n' } },
    });

    await step.execute(ctx);

    expect(logger.warning).toHaveBeenCalledTimes(1);
    expect(logger.warning.mock.calls[0][0]).toContain('using defaults');
    expect(deployOs).toHaveBeenCalledTimes(1);
  });

  it('deploys with mapped device data when payload is complete', async () => {
    const { step, logger, deployOs } = makeStep();
    const ctx = makeCtx({
      payload: {
        device_data: validDeviceData(),
        lifecycle_data: { node_desc: 'rack-7' },
      },
      stepResults: {
        resolve_deploy_target: { os_payload: { distro: 'ubuntu' } },
        prepare_storage: { target_path: '/target' },
      },
    });

    const result = await step.execute(ctx);

    expect(logger.warning).not.toHaveBeenCalled();
    expect(result).toEqual({ deployed: true });
    expect(deployOs).toHaveBeenCalledWith(
      expect.objectContaining({
        deviceId: 'dev-1',
        osPayload: { distro: 'ubuntu' },
        storage: { target_path: '/target' },
        nodeDesc: 'rack-7',
        deviceNetplan: 'network:\n  version: 2\n',
        deviceGpuModel: 'h100',
        devicePurgeTtys: true,
        deviceSerialPort: 'ttyS0',
        deviceSerialBaud: 115200,
        deviceType: 'gpu',
        deviceNetworkType: 'ethernet',
      }),
    );
  });
});
