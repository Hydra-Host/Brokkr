import { describe, expect, it } from 'vitest';

import { buildAgentBundleConfig } from '../agent-unit-render-startup.service';

describe('buildAgentBundleConfig', () => {
  it('reads bundle and unit paths from env vars', () => {
    const cfg = buildAgentBundleConfig({
      AGENT_BUNDLE_PATH: '/opt/brokkr/agent/main.js',
      AGENT_UNIT_PATH: '/etc/systemd/system/brokkr-bridge-agent.service',
    });
    expect(cfg.bundlePath).toBe('/opt/brokkr/agent/main.js');
    expect(cfg.unitPath).toBe('/etc/systemd/system/brokkr-bridge-agent.service');
  });

  it('falls back to the canonical defaults when env is empty', () => {
    const cfg = buildAgentBundleConfig({});
    expect(cfg.bundlePath).toBe('/opt/brokkr/agent/main.js');
    expect(cfg.unitPath).toBe('/opt/brokkr/agent/brokkr-bridge-agent.service');
  });
});
