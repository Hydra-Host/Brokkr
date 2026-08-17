import { describe, expect, it, vi } from 'vitest';

import { validateOperationOutput } from '../../agent/dispatch/dispatch-envelope';
import { DispatchFailed } from '../../agent/dispatch/grpc.exceptions';
import type { SagaContext } from '../../saga-framework/saga.types';
import { WipeDisksStep } from '../steps/wipe-disks.step';

function dispatchThroughBoundary(raw: unknown) {
  return vi.fn(async () => validateOperationOutput('storage.wipeDisks', raw));
}

function makeLogger() {
  return {
    info: vi.fn(async () => undefined),
    debug: vi.fn(async () => undefined),
    warning: vi.fn(async () => undefined),
    error: vi.fn(async () => undefined),
  };
}

function makeDeps(dispatchResult: unknown, environment = 'development') {
  const dispatcher = { dispatchTyped: vi.fn(async () => dispatchResult) };
  const normalizer = { diskLayoutsForAgent: vi.fn((layouts: unknown) => layouts) };
  const efiBootFactory = { create: vi.fn(async () => ({ forceBootDevice: vi.fn(async () => undefined) })) };
  const appConfig = { environment };
  const logger = makeLogger();
  return { dispatcher, normalizer, efiBootFactory, appConfig, logger };
}

type WipeStepCtor = ConstructorParameters<typeof WipeDisksStep>;

function makeStep(deps: ReturnType<typeof makeDeps>): WipeDisksStep {
  return new WipeDisksStep(
    deps.dispatcher as unknown as WipeStepCtor[0],
    deps.normalizer,
    deps.efiBootFactory as unknown as WipeStepCtor[2],
    deps.appConfig,
    deps.logger,
  );
}

function makeCtx(overrides: Partial<SagaContext> = {}): SagaContext {
  return {
    planId: 'plan-1',
    stepName: 'wipe_disks',
    deviceId: 'device-1',
    payload: {},
    jobId: 'job-1',
    attempt: 1,
    metadata: {},
    stepResults: {},
    ...overrides,
  };
}

describe('WipeDisksStep.execute', () => {
  it('falls through to a full wipe when resolved disk_layouts is an empty array', async () => {
    const deps = makeDeps({ sanitization_report: { mode: 'full', overall_result: 'pass' }, optimal_os_disk: null });
    const step = makeStep(deps);

    const result = await step.execute(
      makeCtx({ stepResults: { resolve_deploy_target: { disk_layouts: [] } }, payload: {} }),
    );

    expect(deps.normalizer.diskLayoutsForAgent).not.toHaveBeenCalled();
    expect(deps.dispatcher.dispatchTyped).toHaveBeenCalledWith(
      'device-1',
      'storage.wipeDisks',
      expect.objectContaining({ disk_layouts: null }),
      expect.anything(),
    );
    expect(deps.logger.info).toHaveBeenCalledWith(expect.stringContaining('mode=full'), { jobId: 'job-1' });
    expect(result.mode).toBe('full');
  });

  it('uses payload disk_layouts for a selective wipe when resolve is empty but payload is present', async () => {
    const deps = makeDeps({
      sanitization_report: { mode: 'selective', overall_result: 'pass' },
      optimal_os_disk: null,
    });
    const step = makeStep(deps);

    const layouts = [{ disk: '/dev/sda' }];
    await step.execute(
      makeCtx({ stepResults: { resolve_deploy_target: { disk_layouts: [] } }, payload: { disk_layouts: layouts } }),
    );

    expect(deps.normalizer.diskLayoutsForAgent).toHaveBeenCalledWith(layouts);
    expect(deps.logger.info).toHaveBeenCalledWith(expect.stringContaining('mode=selective'), { jobId: 'job-1' });
  });

  it('returns the validated report and optimal-OS-disk fields verbatim', async () => {
    const sanitizationReport = { mode: 'full', overall_result: 'pass' };
    const optimalOsDisk = { name: 'sda', size: 1024, type: 'nvme' };
    const deps = makeDeps({ sanitization_report: sanitizationReport, optimal_os_disk: optimalOsDisk });
    const step = makeStep(deps);

    const result = await step.execute(makeCtx());

    expect(result).toEqual({
      wiped: true,
      mode: 'full',
      optimal_os_disk: optimalOsDisk,
      sanitization_report: sanitizationReport,
    });
  });

  it('still wraps a real agent FAILURE / DispatchFailed as a disk-wipe error and logs it', async () => {
    const deps = makeDeps(undefined);
    deps.dispatcher.dispatchTyped = vi.fn(async () => {
      throw new DispatchFailed('AGENT_FAILURE', 'wipe pass aborted', null);
    });
    const step = makeStep(deps);

    await expect(step.execute(makeCtx())).rejects.toThrowError(/Disk wipe failed: AGENT_FAILURE/);
    expect(deps.logger.error).toHaveBeenCalledWith(expect.stringContaining('AGENT_FAILURE'), { jobId: 'job-1' });
  });

  describe('overall_result saga gate', () => {
    const validReport = {
      version: '1.0',
      standards_reference: ['NIST SP 800-88 Rev.2'],
      job_id: 'job-1',
      mode: 'selective',
      started_at: '2026-01-01T00:00:00Z',
      completed_at: '2026-01-01T01:00:00Z',
      duration_seconds: 3600,
      overall_result: 'pass',
      tool: { name: 'brokkr-bridge', version: '1.0.0' },
      holder_teardown: {
        crypt_closed: [],
        lvm_removed: [],
        vg_removed: [],
        raid_stopped: [],
        swap_deactivated: [],
        signatures_cleared: [],
        skipped_preserved: [],
      },
      disks: [],
      preserved_disks: [],
      skipped_disks: [],
    };

    const unverifiedCases: ReadonlyArray<{ label: string; report: unknown }> = [
      { label: 'null', report: null },
      { label: 'scalar string', report: 'sanitized' },
      { label: 'scalar number', report: 0 },
      { label: 'scalar boolean', report: true },
      { label: 'missing key', report: undefined },
      { label: 'empty array', report: [] },
      { label: 'non-empty array', report: [{ overall_result: 'pass' }] },
      { label: "overall_result='fail'", report: { mode: 'full', overall_result: 'fail' } },
      { label: 'overall_result absent', report: { mode: 'full' } },
    ];

    for (const { label, report } of unverifiedCases) {
      it(`fails the step (re-attempt) when sanitization_report is ${label}`, async () => {
        const raw: Record<string, unknown> = { optimal_os_disk: null };
        if (report !== undefined) raw.sanitization_report = report;

        const deps = makeDeps(undefined);
        deps.dispatcher.dispatchTyped = dispatchThroughBoundary(raw);
        const step = makeStep(deps);

        await expect(step.execute(makeCtx())).rejects.toThrowError(/Disk wipe failed: sanitization not verified/);
        expect(deps.logger.error).toHaveBeenCalled();
      });
    }

    it('preserves a valid report and its mode through the real boundary', async () => {
      const deps = makeDeps(undefined);
      deps.dispatcher.dispatchTyped = dispatchThroughBoundary({
        sanitization_report: validReport,
        optimal_os_disk: null,
      });
      const step = makeStep(deps);

      const result = await step.execute(makeCtx());

      expect(result.wiped).toBe(true);
      expect(result.mode).toBe('selective');
      expect(deps.logger.error).not.toHaveBeenCalled();
    });

    it('preserves valid siblings and the real mode when a single field is malformed', async () => {
      const deps = makeDeps(undefined);
      deps.dispatcher.dispatchTyped = dispatchThroughBoundary({
        sanitization_report: { ...validReport, duration_seconds: 'not-a-number' },
        optimal_os_disk: null,
      });
      const step = makeStep(deps);

      const result = await step.execute(makeCtx());

      expect(result.wiped).toBe(true);
      expect(result.mode).toBe('selective');
      const report = result.sanitization_report as Record<string, unknown>;
      expect(report.overall_result).toBe('pass');
      expect(report.job_id).toBe('job-1');
      expect(report.duration_seconds).toBeUndefined();
      expect(deps.logger.error).not.toHaveBeenCalled();
    });
  });

  describe('environment mapping', () => {
    const cases: ReadonlyArray<{ input: string; expected: 'production' | 'development' }> = [
      { input: 'prod', expected: 'production' },
      { input: 'production', expected: 'production' },
      { input: 'development', expected: 'development' },
      { input: 'staging', expected: 'development' },
      { input: 'dev', expected: 'development' },
      { input: 'local', expected: 'development' },
      { input: '', expected: 'development' },
    ];

    for (const { input, expected } of cases) {
      it(`maps appConfig.environment="${input}" to "${expected}" in the payload`, async () => {
        const deps = makeDeps(
          { sanitization_report: { mode: 'full', overall_result: 'pass' }, optimal_os_disk: null },
          input,
        );
        const step = makeStep(deps);

        await step.execute(makeCtx());

        expect(deps.dispatcher.dispatchTyped).toHaveBeenCalledWith(
          'device-1',
          'storage.wipeDisks',
          expect.objectContaining({ environment: expected }),
          expect.anything(),
        );
      });
    }

    it('does not unconditionally report production for a non-prod environment', async () => {
      const deps = makeDeps(
        { sanitization_report: { mode: 'full', overall_result: 'pass' }, optimal_os_disk: null },
        'staging',
      );
      const step = makeStep(deps);

      await step.execute(makeCtx());

      expect(deps.dispatcher.dispatchTyped).toHaveBeenCalledWith(
        'device-1',
        'storage.wipeDisks',
        expect.objectContaining({ environment: 'development' }),
        expect.anything(),
      );
      expect(deps.dispatcher.dispatchTyped).not.toHaveBeenCalledWith(
        'device-1',
        'storage.wipeDisks',
        expect.objectContaining({ environment: 'production' }),
        expect.anything(),
      );
    });
  });
});
