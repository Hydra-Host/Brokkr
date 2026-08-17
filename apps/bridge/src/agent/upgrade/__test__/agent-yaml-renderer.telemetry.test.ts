import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveOtlpTracesTarget } from '@repo/telemetry';

import { resetInitrdConfigForTests } from '../../../initrd/initrd.config';
import { renderAgentYaml } from '../agent-yaml-renderer';

vi.mock('@repo/telemetry', () => ({
  isTelemetryEnabled: () => true,
  resolveOtlpTracesTarget: vi.fn(() => ({ url: 'http://collector:4318/v1/traces', headers: {} })),
}));

describe('renderAgentYaml telemetry flag', () => {
  let savedZoneId: string | undefined;

  beforeEach(() => {
    savedZoneId = process.env['BROKKR_ZONE_ID'];
    process.env['BROKKR_ZONE_ID'] = 'zone-1';
    resetInitrdConfigForTests();
  });

  afterEach(() => {
    if (savedZoneId === undefined) {
      delete process.env['BROKKR_ZONE_ID'];
    } else {
      process.env['BROKKR_ZONE_ID'] = savedZoneId;
    }
    resetInitrdConfigForTests();
    vi.mocked(resolveOtlpTracesTarget).mockReturnValue({ url: 'http://collector:4318/v1/traces', headers: {} });
  });

  const render = () =>
    renderAgentYaml({
      deviceId: 'dev-1',
      bridges: ['bridge-a.example:443'],
      agentToken: 'tok-abc',
      jobId: 'job-x',
    });

  it('renders traces_enabled: true when the bridge SDK runs with an OTLP target', async () => {
    expect(await render()).toContain('traces_enabled: true');
  });

  it('renders traces_enabled: false when the SDK runs without an OTLP target (console exporter)', async () => {
    vi.mocked(resolveOtlpTracesTarget).mockReturnValue(undefined);
    expect(await render()).toContain('traces_enabled: false');
  });
});
