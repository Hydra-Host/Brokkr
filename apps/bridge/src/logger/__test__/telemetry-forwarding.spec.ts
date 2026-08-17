import { emitTelemetryLog } from '@repo/telemetry';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ContextLogger } from '../logger.service';

vi.mock('@repo/telemetry', () => ({ emitTelemetryLog: vi.fn() }));

describe('ContextLogger telemetry forwarding', () => {
  let logger: ContextLogger;

  beforeEach(() => {
    vi.clearAllMocks();
    logger = new ContextLogger(null, {});
  });

  it("maps the bridge's warning level onto otel's warn and carries the context attrs", async () => {
    await logger.warning('careful', { jobId: 'plan-3', appClassName: 'SpecClass' });
    expect(emitTelemetryLog).toHaveBeenCalledExactlyOnceWith(
      'brokkr-bridge',
      'warn',
      'careful',
      {
        'brokkr.app_class_name': 'SpecClass',
        'brokkr.job_id': 'plan-3',
        'brokkr.app_name': 'bridge-api',
        'brokkr.device_id': undefined,
      },
      undefined,
    );
  });

  it('forwards info/error under their own names with defaulted class name', async () => {
    await logger.info('i');
    expect(emitTelemetryLog).toHaveBeenLastCalledWith(
      'brokkr-bridge',
      'info',
      'i',
      {
        'brokkr.app_class_name': 'unknown',
        'brokkr.job_id': undefined,
        'brokkr.app_name': 'bridge-api',
        'brokkr.device_id': undefined,
      },
      undefined,
    );
    await logger.error('e');
    expect(emitTelemetryLog).toHaveBeenLastCalledWith('brokkr-bridge', 'error', 'e', expect.anything(), undefined);
  });

  it('carries agent-relay identity (app_name/device_id) and the explicit remote span context', async () => {
    await logger.info('[agent device=dev-1] booted', {
      appClassName: 'agent',
      appName: 'bridge-agent',
      deviceId: 'dev-1',
      traceId: '0af7651916cd43dd8448eb211c80319c',
      spanId: 'b7ad6b7169203331',
    });
    expect(emitTelemetryLog).toHaveBeenCalledExactlyOnceWith(
      'brokkr-bridge',
      'info',
      '[agent device=dev-1] booted',
      {
        'brokkr.app_class_name': 'agent',
        'brokkr.job_id': undefined,
        'brokkr.app_name': 'bridge-agent',
        'brokkr.device_id': 'dev-1',
      },
      { traceId: '0af7651916cd43dd8448eb211c80319c', spanId: 'b7ad6b7169203331' },
    );
  });

  it('passes no span context when only one of traceId/spanId is present', async () => {
    await logger.info('partial', { traceId: '0af7651916cd43dd8448eb211c80319c' });
    const call = vi.mocked(emitTelemetryLog).mock.calls[0]!;
    expect(call[4]).toBeUndefined();
  });

  it('never forwards a level below the logger threshold (debug < the fixed info level)', async () => {
    await logger.debug('suppressed');
    expect(emitTelemetryLog).not.toHaveBeenCalled();
  });

  it('never forwards a record the job-id prefix filter suppresses from stdout', async () => {
    const filtered = new ContextLogger(null, { LOG_SUPPRESS_JOB_ID_PREFIXES: 'health-cron-' });
    await filtered.info('heartbeat', { jobId: 'health-cron-42' });
    expect(emitTelemetryLog).not.toHaveBeenCalled();

    await filtered.info('deploying', { jobId: 'deploy-saga-1' });
    expect(emitTelemetryLog).toHaveBeenCalledOnce();
  });

  it('never forwards a line the 100ms dedup window suppresses from stdout', async () => {
    const nowMs = vi.spyOn(performance, 'now').mockReturnValue(0);
    try {
      await logger.info('same line');
      await logger.info('same line');
      expect(emitTelemetryLog).toHaveBeenCalledOnce();

      nowMs.mockReturnValue(200);
      await logger.info('same line');
      expect(emitTelemetryLog).toHaveBeenCalledTimes(2);
    } finally {
      nowMs.mockRestore();
    }
  });

  it('forwards both lines when only appName differs within the dedup window', async () => {
    await logger.info('same line', { appClassName: 'svc', appName: 'bridge-api' });
    await logger.info('same line', { appClassName: 'svc', appName: 'bridge-agent' });
    expect(emitTelemetryLog).toHaveBeenCalledTimes(2);
  });
});
