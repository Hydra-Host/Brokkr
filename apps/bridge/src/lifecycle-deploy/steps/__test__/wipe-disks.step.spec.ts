import { describe, expect, it, vi } from 'vitest';

import {
  AgentNotConnected,
  AgentNotResponsive,
  DispatchFailed,
  DispatchStalled,
} from '../../../agent/dispatch/grpc.exceptions.js';
import type { SagaContext } from '../../../saga-framework/saga.types.js';
import { WipeDisksStep } from '../wipe-disks.step.js';

function makeCtx(overrides: Partial<SagaContext> = {}): SagaContext {
  return {
    planId: 'plan-1',
    stepName: 'wipe_disks',
    deviceId: 'dev-1',
    payload: {},
    jobId: 'job-1',
    attempt: 1,
    metadata: {},
    stepResults: {},
    ...overrides,
  };
}

function makeLogger() {
  return {
    info: vi.fn().mockResolvedValue(undefined),
    debug: vi.fn().mockResolvedValue(undefined),
    warning: vi.fn().mockResolvedValue(undefined),
    error: vi.fn().mockResolvedValue(undefined),
  };
}

type DispatchFn = (
  deviceId: string,
  operation: string,
  input: Record<string, unknown>,
  options: { jobId: string; timeoutS: number; stallTimeoutS?: number },
) => Promise<unknown>;

interface StepOptions {
  dispatch?: ReturnType<typeof vi.fn>;
  forceBootDevice?: ReturnType<typeof vi.fn>;
}

function makeStep(opts: StepOptions = {}) {
  const dispatch =
    opts.dispatch ??
    vi.fn().mockResolvedValue({
      sanitization_report: { mode: 'selective', overall_result: 'pass' },
      optimal_os_disk: '/dev/nvme0n1',
    });
  const dispatcher = { dispatchTyped: dispatch as unknown as DispatchFn };
  const normalizer = { diskLayoutsForAgent: vi.fn((layouts: unknown) => layouts) };
  const forceBootDevice = opts.forceBootDevice ?? vi.fn().mockResolvedValue(undefined);
  const efiBootFactory = { create: vi.fn().mockResolvedValue({ forceBootDevice }) };
  const appConfig = { environment: 'development' };
  const logger = makeLogger();
  const step = new WipeDisksStep(dispatcher, normalizer, efiBootFactory, appConfig, logger);
  return { step, dispatch, normalizer, efiBootFactory, forceBootDevice, logger };
}

describe('WipeDisksStep error classification', () => {
  it('returns a wiped result on success', async () => {
    const { step } = makeStep();
    const result = await step.execute(makeCtx());
    expect(result).toEqual({
      wiped: true,
      mode: 'selective',
      optimal_os_disk: '/dev/nvme0n1',
      sanitization_report: { mode: 'selective', overall_result: 'pass' },
    });
  });

  it('FAILS CLOSED when overall_result is missing (must not return wiped)', async () => {
    const forceBootDevice = vi.fn().mockResolvedValue(undefined);
    const dispatch = vi.fn().mockResolvedValue({
      sanitization_report: { mode: 'full' },
      optimal_os_disk: '/dev/nvme0n1',
    });
    const { step } = makeStep({ dispatch, forceBootDevice });

    const error = await step.execute(makeCtx()).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('Disk wipe failed');
    expect((error as Error).message).toContain('sanitization not verified');
    expect(forceBootDevice).not.toHaveBeenCalled();
  });

  it('FAILS the step when the sanitization report overall_result is "fail" (must not return wiped)', async () => {
    const forceBootDevice = vi.fn().mockResolvedValue(undefined);
    const dispatch = vi.fn().mockResolvedValue({
      sanitization_report: { mode: 'full', overall_result: 'fail' },
      optimal_os_disk: '/dev/nvme0n1',
    });
    const { step, logger } = makeStep({ dispatch, forceBootDevice });

    const error = await step.execute(makeCtx()).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('Disk wipe failed');
    expect((error as Error).message).toContain('sanitization not verified');
    expect(logger.error).toHaveBeenCalled();
    expect(forceBootDevice).not.toHaveBeenCalled();
  });

  it('attaches the FAILED sanitization report to the thrown error so the runner can persist it', async () => {
    const report = { mode: 'full', overall_result: 'fail' };
    const dispatch = vi.fn().mockResolvedValue({ sanitization_report: report, optimal_os_disk: '/dev/nvme0n1' });
    const { step } = makeStep({ dispatch });

    const error = await step.execute(makeCtx()).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as { stepResult?: unknown }).stepResult).toEqual({ sanitization_report: report });
  });

  it('treats overall_result "pass_crypto_erase" as success and returns wiped', async () => {
    const dispatch = vi.fn().mockResolvedValue({
      sanitization_report: { mode: 'selective', overall_result: 'pass_crypto_erase' },
      optimal_os_disk: '/dev/nvme0n1',
    });
    const { step } = makeStep({ dispatch });

    const result = await step.execute(makeCtx());

    expect(result.wiped).toBe(true);
    expect(result.sanitization_report).toEqual({ mode: 'selective', overall_result: 'pass_crypto_erase' });
  });

  it('treats an EFI boot-config failure as NON-FATAL: swallows it, logs a warning, and still returns wiped', async () => {
    const forceBootDevice = vi.fn().mockRejectedValue(new Error('efivars unavailable'));
    const { step, logger } = makeStep({ forceBootDevice });

    const result = await step.execute(makeCtx());

    expect(result.wiped).toBe(true);
    expect(forceBootDevice).toHaveBeenCalledTimes(1);
    expect(logger.warning).toHaveBeenCalledTimes(1);
    expect(logger.warning.mock.calls[0][0]).toContain('non-fatal');
  });

  it('re-raises AgentNotConnected unchanged (retryable transient — must NOT be rewrapped)', async () => {
    const original = new AgentNotConnected('dev-1');
    const { step } = makeStep({ dispatch: vi.fn().mockRejectedValue(original) });

    const error = await step.execute(makeCtx()).catch((e: unknown) => e);

    expect(error).toBe(original);
    expect(error).toBeInstanceOf(AgentNotConnected);
  });

  it('re-raises AgentNotResponsive unchanged (retryable transient — must NOT be rewrapped)', async () => {
    const original = new AgentNotResponsive('dev-1', 5);
    const { step } = makeStep({ dispatch: vi.fn().mockRejectedValue(original) });

    const error = await step.execute(makeCtx()).catch((e: unknown) => e);

    expect(error).toBe(original);
    expect(error).toBeInstanceOf(AgentNotResponsive);
  });

  it('rewraps DispatchFailed into a generic Error (fatal wipe failure) and logs details', async () => {
    const original = new DispatchFailed('INTERNAL', 'agent blew up', 'stack-trace');
    const { step, logger } = makeStep({ dispatch: vi.fn().mockRejectedValue(original) });

    const error = await step.execute(makeCtx()).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(DispatchFailed);
    expect((error as Error).message).toContain('Disk wipe failed');
    expect((error as Error).message).toContain('agent blew up');
    expect(logger.error).toHaveBeenCalled();
  });

  it('logs and rewraps DispatchStalled into a generic Error', async () => {
    const original = new DispatchStalled('wipe-work-1', null, 600);
    const { step, logger } = makeStep({ dispatch: vi.fn().mockRejectedValue(original) });

    const error = await step.execute(makeCtx({ jobId: 'job-stalled' })).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(DispatchStalled);
    expect(error).toMatchObject({ message: expect.stringContaining('Disk wipe stalled') });
    expect(logger.error).toHaveBeenCalledWith(
      'Disk wipe stalled: no agent progress for 600s (work_id=wipe-work-1, last_progress=null)',
      { jobId: 'job-stalled' },
    );
  });

  it('rewraps an unknown error into a generic Disk wipe failure Error', async () => {
    const { step } = makeStep({ dispatch: vi.fn().mockRejectedValue(new Error('boom')) });

    const error = await step.execute(makeCtx()).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('Disk wipe failed: boom');
  });

  it('maps prod environment to production in the dispatch payload', async () => {
    const dispatch = vi.fn().mockResolvedValue({ sanitization_report: { overall_result: 'pass' } });
    const dispatcher = { dispatchTyped: dispatch as unknown as DispatchFn };
    const normalizer = { diskLayoutsForAgent: vi.fn((l: unknown) => l) };
    const efiBootFactory = {
      create: vi.fn().mockResolvedValue({ forceBootDevice: vi.fn().mockResolvedValue(undefined) }),
    };
    const logger = makeLogger();
    const step = new WipeDisksStep(dispatcher, normalizer, efiBootFactory, { environment: 'prod' }, logger);

    await step.execute(makeCtx());

    expect(dispatch.mock.calls[0][2]).toMatchObject({ environment: 'production' });
  });
});

describe('WipeDisksStep storage.wipeDisks dispatch envelope', () => {
  it('dispatches storage.wipeDisks to the resolved device with the NIST wipe payload (selective, normalized layouts, dev env)', async () => {
    const rawLayouts = [{ disk: '/dev/nvme0n1', wipe: true }];
    const normalizedLayouts = [{ device: '/dev/nvme0n1', sanitize: 'nist' }];
    const dispatch = vi.fn().mockResolvedValue({ sanitization_report: { mode: 'selective', overall_result: 'pass' } });
    const dispatcher = { dispatchTyped: dispatch as unknown as DispatchFn };
    const normalizer = { diskLayoutsForAgent: vi.fn(() => normalizedLayouts) };
    const efiBootFactory = {
      create: vi.fn().mockResolvedValue({ forceBootDevice: vi.fn().mockResolvedValue(undefined) }),
    };
    const logger = makeLogger();
    const step = new WipeDisksStep(dispatcher, normalizer, efiBootFactory, { environment: 'development' }, logger);

    await step.execute(
      makeCtx({
        deviceId: 'dev-42',
        jobId: 'job-99',
        stepResults: { resolve_deploy_target: { disk_layouts: rawLayouts } },
      }),
    );

    expect(normalizer.diskLayoutsForAgent).toHaveBeenCalledWith(rawLayouts);
    expect(dispatch).toHaveBeenCalledTimes(1);
    const [deviceId, operation, payload, options] = dispatch.mock.calls[0];
    expect(deviceId).toBe('dev-42');
    expect(operation).toBe('storage.wipeDisks');
    expect(payload).toEqual({
      disk_layouts: normalizedLayouts,
      environment: 'development',
      full_wipe: false,
      job_id: 'job-99',
    });
    expect(options).toEqual({ jobId: 'job-99', timeoutS: 28_800, stallTimeoutS: 600 });
  });

  it('sends a full-wipe payload (disk_layouts: null, layouts NOT normalized) when no layouts are resolved', async () => {
    const dispatch = vi.fn().mockResolvedValue({ sanitization_report: { overall_result: 'pass' } });
    const dispatcher = { dispatchTyped: dispatch as unknown as DispatchFn };
    const normalizer = { diskLayoutsForAgent: vi.fn((l: unknown) => l) };
    const efiBootFactory = {
      create: vi.fn().mockResolvedValue({ forceBootDevice: vi.fn().mockResolvedValue(undefined) }),
    };
    const logger = makeLogger();
    const step = new WipeDisksStep(dispatcher, normalizer, efiBootFactory, { environment: 'development' }, logger);

    await step.execute(makeCtx({ payload: {}, stepResults: {} }));

    expect(normalizer.diskLayoutsForAgent).not.toHaveBeenCalled();
    expect(dispatch.mock.calls[0][2]).toMatchObject({
      disk_layouts: null,
      environment: 'development',
      full_wipe: false,
    });
  });

  it('forces full_wipe on PROVISION even when selective layouts are present (no disk inherits prior-tenant data)', async () => {
    const rawLayouts = [{ disk: '/dev/nvme0n1', wipe: true }];
    const normalizedLayouts = [{ device: '/dev/nvme0n1', sanitize: 'nist' }];
    const dispatch = vi.fn().mockResolvedValue({ sanitization_report: { mode: 'full', overall_result: 'pass' } });
    const dispatcher = { dispatchTyped: dispatch as unknown as DispatchFn };
    const normalizer = { diskLayoutsForAgent: vi.fn(() => normalizedLayouts) };
    const efiBootFactory = {
      create: vi.fn().mockResolvedValue({ forceBootDevice: vi.fn().mockResolvedValue(undefined) }),
    };
    const logger = makeLogger();
    const step = new WipeDisksStep(dispatcher, normalizer, efiBootFactory, { environment: 'development' }, logger);

    await step.execute(
      makeCtx({
        payload: { status: 'provisioning' },
        stepResults: { resolve_deploy_target: { disk_layouts: rawLayouts } },
      }),
    );

    const sent = dispatch.mock.calls[0][2] as Record<string, unknown>;
    expect(sent.full_wipe).toBe(true);
    expect(sent.disk_layouts).toEqual(normalizedLayouts);
  });

  it('keeps full_wipe=false on REPROVISION so selective preserve semantics survive', async () => {
    const rawLayouts = [
      { disk: '/dev/nvme0n1', wipe: true },
      { disk: '/dev/nvme0n2', wipe: false },
    ];
    const dispatch = vi.fn().mockResolvedValue({ sanitization_report: { mode: 'selective', overall_result: 'pass' } });
    const dispatcher = { dispatchTyped: dispatch as unknown as DispatchFn };
    const normalizer = { diskLayoutsForAgent: vi.fn((l: unknown) => l) };
    const efiBootFactory = {
      create: vi.fn().mockResolvedValue({ forceBootDevice: vi.fn().mockResolvedValue(undefined) }),
    };
    const logger = makeLogger();
    const step = new WipeDisksStep(dispatcher, normalizer, efiBootFactory, { environment: 'development' }, logger);

    await step.execute(
      makeCtx({
        payload: { status: 'reprovisioning' },
        stepResults: { resolve_deploy_target: { disk_layouts: rawLayouts } },
      }),
    );

    expect((dispatch.mock.calls[0][2] as Record<string, unknown>).full_wipe).toBe(false);
  });
});
