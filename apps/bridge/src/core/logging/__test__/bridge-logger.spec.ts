import { emitTelemetryLog } from '@repo/telemetry';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { forwardToTelemetry } from '../bridge-logger';

vi.mock('@repo/telemetry', () => ({ emitTelemetryLog: vi.fn() }));

describe('bridge-logger telemetry forwarding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("maps the bridge's warning level onto otel's warn and carries the option attrs", () => {
    forwardToTelemetry('warning', 'careful', { jobId: 'plan-3', appClassName: 'SpecClass' });
    expect(emitTelemetryLog).toHaveBeenCalledExactlyOnceWith('brokkr-bridge', 'warn', 'careful', {
      'brokkr.app_class_name': 'SpecClass',
      'brokkr.job_id': 'plan-3',
      'brokkr.app_name': 'bridge-api',
    });
  });

  it('forwards the other levels under their own names with defaulted attrs', () => {
    forwardToTelemetry('info', 'i');
    expect(emitTelemetryLog).toHaveBeenLastCalledWith('brokkr-bridge', 'info', 'i', {
      'brokkr.app_class_name': 'unknown',
      'brokkr.job_id': undefined,
      'brokkr.app_name': 'bridge-api',
    });
    forwardToTelemetry('error', 'e');
    expect(emitTelemetryLog).toHaveBeenLastCalledWith('brokkr-bridge', 'error', 'e', expect.anything());
    forwardToTelemetry('debug', 'd');
    expect(emitTelemetryLog).toHaveBeenLastCalledWith('brokkr-bridge', 'debug', 'd', expect.anything());
  });

  it('carries an explicit appName (agent-relayed lines)', () => {
    forwardToTelemetry('info', 'relayed', { appName: 'bridge-agent' });
    expect(emitTelemetryLog).toHaveBeenLastCalledWith('brokkr-bridge', 'info', 'relayed', {
      'brokkr.app_class_name': 'unknown',
      'brokkr.job_id': undefined,
      'brokkr.app_name': 'bridge-agent',
    });
  });

  it('normalizes an empty job id to an absent attribute', () => {
    forwardToTelemetry('info', 'no job', { jobId: '' });
    expect(emitTelemetryLog).toHaveBeenLastCalledWith('brokkr-bridge', 'info', 'no job', {
      'brokkr.app_class_name': 'unknown',
      'brokkr.job_id': undefined,
      'brokkr.app_name': 'bridge-api',
    });
  });
});
