import { initTelemetry } from '@repo/telemetry';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initBridgeTelemetry } from '../init-telemetry';

vi.mock('@repo/telemetry', () => ({
  initTelemetry: vi.fn(),
}));

const KEYS = ['OTEL_RESOURCE_ATTRIBUTES', 'BRIDGE_HOSTNAME', 'BROKKR_ZONE_ID'];

describe('initBridgeTelemetry', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('derives resource attributes from the telegraf tag env and delegates to initTelemetry', () => {
    process.env.BRIDGE_HOSTNAME = 'bridge-01';
    process.env.BROKKR_ZONE_ID = 'zone-a';
    initBridgeTelemetry();
    expect(process.env.OTEL_RESOURCE_ATTRIBUTES).toBe('bridge_id=bridge-01,zone=zone-a');
    expect(initTelemetry).toHaveBeenCalledExactlyOnceWith({ serviceName: 'brokkr-bridge', preset: 'bridge' });
  });

  it('emits a single attribute when only one tag is set', () => {
    process.env.BROKKR_ZONE_ID = 'zone-a';
    initBridgeTelemetry();
    expect(process.env.OTEL_RESOURCE_ATTRIBUTES).toBe('zone=zone-a');
  });

  it('leaves the env unset when neither tag is present', () => {
    initBridgeTelemetry();
    expect(process.env.OTEL_RESOURCE_ATTRIBUTES).toBeUndefined();
    expect(initTelemetry).toHaveBeenCalledOnce();
  });

  it('never overrides an operator-provided OTEL_RESOURCE_ATTRIBUTES', () => {
    process.env.OTEL_RESOURCE_ATTRIBUTES = 'deployment.environment=prod';
    process.env.BRIDGE_HOSTNAME = 'bridge-01';
    initBridgeTelemetry();
    expect(process.env.OTEL_RESOURCE_ATTRIBUTES).toBe('deployment.environment=prod');
  });

  it('percent-encodes values so , and = cannot corrupt the k=v,k=v parse', () => {
    process.env.BRIDGE_HOSTNAME = 'bridge-01,env=prod';
    process.env.BROKKR_ZONE_ID = 'zone-a';
    initBridgeTelemetry();
    expect(process.env.OTEL_RESOURCE_ATTRIBUTES).toBe('bridge_id=bridge-01%2Cenv%3Dprod,zone=zone-a');
  });
});
