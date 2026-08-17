import { describe, expect, it, vi } from 'vitest';

import { NonRetryableSagaError } from '../../../saga-framework/saga-runner.service.js';
import type { SagaContext } from '../../../saga-framework/saga.types.js';
import { ResolveDeployTargetStep } from '../resolve-deploy-target.step.js';

function makeCtx(overrides: Partial<SagaContext> = {}): SagaContext {
  return {
    planId: 'plan-1',
    stepName: 'resolve_deploy_target',
    deviceId: 'dev-1',
    payload: {},
    jobId: 'job-1',
    attempt: 1,
    metadata: {},
    stepResults: {},
    ...overrides,
  };
}

function makeStep() {
  const resolveDeployTarget = vi.fn().mockResolvedValue({ os_payload: { distro: 'ubuntu' } });
  const factory = { create: vi.fn().mockResolvedValue({ resolveDeployTarget }) };
  const logger = { info: vi.fn().mockResolvedValue(undefined) };
  const step = new ResolveDeployTargetStep(factory, logger);
  return { step, factory, resolveDeployTarget, logger };
}

describe('ResolveDeployTargetStep', () => {
  it('throws a NonRetryableSagaError (fail-fast) when device_id is null', async () => {
    const { step } = makeStep();
    await expect(step.execute(makeCtx({ deviceId: null }))).rejects.toBeInstanceOf(NonRetryableSagaError);
    await expect(step.execute(makeCtx({ deviceId: null }))).rejects.toThrow(/device_id is required/);
  });

  it('produces the skipped signal (and does not call orchestration) when an iPXE URL is provided', async () => {
    const { step, factory, logger } = makeStep();
    const ctx = makeCtx({
      payload: { lifecycle_data: { ipxe_url: 'http://boot/ipxe' } },
    });

    const result = await step.execute(ctx);

    expect(result).toEqual({ skipped: true, reason: 'ipxe_url provided', ipxe_url: 'http://boot/ipxe' });
    expect(factory.create).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledTimes(1);
  });

  it('resolves through orchestration when no iPXE URL is present', async () => {
    const { step, resolveDeployTarget } = makeStep();
    const ctx = makeCtx({
      payload: { platform: { kind: 'oci' }, boot_device: 'disk', lifecycle_data: {} },
    });

    const result = await step.execute(ctx);

    expect(result).toEqual({ os_payload: { distro: 'ubuntu' } });
    expect(resolveDeployTarget).toHaveBeenCalledWith({
      deviceId: 'dev-1',
      platform: { kind: 'oci' },
      lifecycleData: {},
      bootDevice: 'disk',
    });
  });

  it('coerces non-object platform/lifecycle_data payload fields to {} instead of trusting an unsafe cast', async () => {
    const { step, resolveDeployTarget } = makeStep();
    await step.execute(makeCtx({ deviceId: '42', payload: { platform: 'not-an-object' } }));
    expect(resolveDeployTarget).toHaveBeenCalledWith({
      deviceId: '42',
      platform: {},
      lifecycleData: {},
      bootDevice: 'pxe',
    });
  });

  it('passes through a string boot_device and defaults non-strings to pxe', async () => {
    const { step, resolveDeployTarget } = makeStep();
    await step.execute(makeCtx({ payload: { boot_device: 'disk', platform: { os_distro: 'ubuntu' } } }));
    expect(resolveDeployTarget).toHaveBeenCalledWith(
      expect.objectContaining({ bootDevice: 'disk', platform: { os_distro: 'ubuntu' } }),
    );

    resolveDeployTarget.mockClear();
    await step.execute(makeCtx({ payload: { boot_device: 123 } }));
    expect(resolveDeployTarget).toHaveBeenCalledWith(expect.objectContaining({ bootDevice: 'pxe' }));
  });

  it('defaults the boot device to pxe', async () => {
    const { step, resolveDeployTarget } = makeStep();
    await step.execute(makeCtx());
    expect(resolveDeployTarget).toHaveBeenCalledWith(expect.objectContaining({ bootDevice: 'pxe' }));
  });
});
