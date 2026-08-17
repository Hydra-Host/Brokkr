import { describe, expect, it } from 'vitest';

import { getAgentSystemdEnvironment } from '../agent-unit-render-startup.service';

const ALLOWLIST = ['AGENT_LOG_LEVEL', 'NODE_EXTRA_CA_CERTS', 'LOCAL_SIMULATION_ENABLED'] as const;

describe('AGENT_SYSTEMD_ENV_PASSTHROUGH', () => {
  it('allowlist includes NODE_EXTRA_CA_CERTS', () => {
    expect(ALLOWLIST).toContain('NODE_EXTRA_CA_CERTS');
  });

  it('allowlist includes AGENT_LOG_LEVEL', () => {
    expect(ALLOWLIST).toContain('AGENT_LOG_LEVEL');
  });

  it('allowlist includes LOCAL_SIMULATION_ENABLED', () => {
    expect(ALLOWLIST).toContain('LOCAL_SIMULATION_ENABLED');
  });
});

describe('getAgentSystemdEnvironment', () => {
  it('returns empty object when no allowlisted vars are set', () => {
    expect(getAgentSystemdEnvironment({})).toEqual({});
  });

  it('emits only the set vars', () => {
    const env = getAgentSystemdEnvironment({
      NODE_EXTRA_CA_CERTS: '/usr/local/share/ca-certificates/our-org.crt',
    });
    expect(env).toEqual({
      NODE_EXTRA_CA_CERTS: '/usr/local/share/ca-certificates/our-org.crt',
    });
  });

  it('emits all allowlisted vars when set', () => {
    const env = getAgentSystemdEnvironment({
      NODE_EXTRA_CA_CERTS: '/etc/pki/tls/certs/ca-bundle.crt',
      AGENT_LOG_LEVEL: 'trace',
    });
    expect(env).toEqual({
      NODE_EXTRA_CA_CERTS: '/etc/pki/tls/certs/ca-bundle.crt',
      AGENT_LOG_LEVEL: 'trace',
    });
  });

  it('treats empty string as unset', () => {
    const baseEnv: NodeJS.ProcessEnv = {};
    for (const key of ALLOWLIST) {
      baseEnv[key] = '';
    }
    expect(getAgentSystemdEnvironment(baseEnv)).toEqual({});
  });

  it.each(ALLOWLIST)('round-trips %s through the reader', (varName) => {
    const env = getAgentSystemdEnvironment({ [varName]: 'test-value' });
    expect(env[varName]).toBe('test-value');
  });
});
