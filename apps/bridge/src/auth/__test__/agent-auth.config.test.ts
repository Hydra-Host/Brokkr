import { afterEach, describe, expect, it } from 'vitest';

import { buildAgentAuthConfig, getAgentAuthConfig, resetAgentAuthConfigForTests } from '../agent-auth.config';

afterEach(() => {
  resetAgentAuthConfigForTests();
});

describe('buildAgentAuthConfig', () => {
  it('defaults token_bytes=32 and discovery_ttl_s=86400', () => {
    const cfg = buildAgentAuthConfig({});
    expect(cfg.tokenBytes).toBe(32);
    expect(cfg.discoveryTtlS).toBe(86_400);
  });

  it('applies env overrides', () => {
    const cfg = buildAgentAuthConfig({
      AGENT_AUTH_TOKEN_BYTES: '48',
      AGENT_AUTH_DISCOVERY_TTL_S: '3600',
    });
    expect(cfg.tokenBytes).toBe(48);
    expect(cfg.discoveryTtlS).toBe(3600);
  });

  it('enforces minimum token_bytes of 16', () => {
    const cfg = buildAgentAuthConfig({ AGENT_AUTH_TOKEN_BYTES: '4' });
    expect(cfg.tokenBytes).toBe(16);
  });

  it('falls back to default token_bytes on garbage input', () => {
    const cfg = buildAgentAuthConfig({ AGENT_AUTH_TOKEN_BYTES: 'abc' });
    expect(cfg.tokenBytes).toBe(32);
  });

  it('falls back to default discovery_ttl_s on garbage input', () => {
    const cfg = buildAgentAuthConfig({ AGENT_AUTH_DISCOVERY_TTL_S: 'not-a-number' });
    expect(cfg.discoveryTtlS).toBe(86_400);
  });
});

describe('getAgentAuthConfig', () => {
  it('returns the cached instance on subsequent calls', () => {
    const a = getAgentAuthConfig();
    const b = getAgentAuthConfig();
    expect(a).toBe(b);
  });
});
