import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { assertAuthBypassEnvSafe, isLocalSimulationEnabled, resolveAuthBypassPolicy } from '../local-simulation';

describe('auth-bypass env gating', () => {
  const KEYS = [
    'AUTH_BYPASS_ENABLED',
    'LOCAL_SIMULATION_ENABLED',
    'HH_ENV',
    'NODE_ENV',
    'AUTH_BYPASS_ALLOWED_ENVS',
  ] as const;
  const saved: Record<string, string | undefined> = {};

  const assign = (key: string, value: string | undefined) => {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  };

  const set = (vars: Partial<Record<(typeof KEYS)[number], string | undefined>>) => {
    for (const key of KEYS) assign(key, vars[key]);
  };

  beforeEach(() => {
    for (const key of KEYS) saved[key] = process.env[key];
    set({});
  });
  afterEach(() => {
    for (const key of KEYS) assign(key, saved[key]);
  });

  describe('resolveAuthBypassPolicy', () => {
    it('enables every relaxation with AUTH_BYPASS_ENABLED in a permitted env', () => {
      set({ AUTH_BYPASS_ENABLED: 'true', HH_ENV: 'dev', NODE_ENV: 'development' });
      const policy = resolveAuthBypassPolicy();
      expect(policy.enabled).toBe(true);
      expect(policy.autoResolveAdminOwner).toBe(true);
      expect(policy.skipEntraLink).toBe(true);
      expect(policy.relaxOrigins).toBe(true);
      expect(policy.relaxPasswordPolicy).toBe(true);
      expect(policy.relaxRateLimit).toBe(true);
      expect(policy.seedBypassUser).toBe(true);
    });

    it('is also enabled by LOCAL_SIMULATION_ENABLED (sim implies auth bypass)', () => {
      set({ LOCAL_SIMULATION_ENABLED: 'true', HH_ENV: 'dev', NODE_ENV: 'development' });
      expect(resolveAuthBypassPolicy().enabled).toBe(true);
    });

    it('is disabled when no flag is set', () => {
      set({ HH_ENV: 'dev', NODE_ENV: 'development' });
      expect(resolveAuthBypassPolicy().enabled).toBe(false);
    });

    it('is inert when HH_ENV is not in the allowlist', () => {
      set({ AUTH_BYPASS_ENABLED: 'true', HH_ENV: 'stg', NODE_ENV: 'development' });
      expect(resolveAuthBypassPolicy().enabled).toBe(false);
    });

    it('honors a widened allowlist for automation environments', () => {
      set({ AUTH_BYPASS_ENABLED: 'true', HH_ENV: 'ci', NODE_ENV: 'development', AUTH_BYPASS_ALLOWED_ENVS: 'dev,ci' });
      expect(resolveAuthBypassPolicy().enabled).toBe(true);
    });

    it('is inert in production regardless of HH_ENV or allowlist', () => {
      set({ AUTH_BYPASS_ENABLED: 'true', HH_ENV: 'dev', NODE_ENV: 'production', AUTH_BYPASS_ALLOWED_ENVS: 'dev' });
      expect(resolveAuthBypassPolicy().enabled).toBe(false);
    });
  });

  describe('isLocalSimulationEnabled', () => {
    it('requires LOCAL_SIMULATION_ENABLED specifically (AUTH_BYPASS alone is not enough)', () => {
      set({ AUTH_BYPASS_ENABLED: 'true', HH_ENV: 'dev', NODE_ENV: 'development' });
      expect(isLocalSimulationEnabled()).toBe(false);
      set({ LOCAL_SIMULATION_ENABLED: 'true', HH_ENV: 'dev', NODE_ENV: 'development' });
      expect(isLocalSimulationEnabled()).toBe(true);
    });

    it('is inert outside the allowlist / in production', () => {
      for (const env of [{ HH_ENV: 'stg' }, { HH_ENV: 'prod' }, { NODE_ENV: 'production' }]) {
        set({ LOCAL_SIMULATION_ENABLED: 'true', HH_ENV: 'dev', NODE_ENV: 'development', ...env });
        expect(isLocalSimulationEnabled()).toBe(false);
      }
    });
  });

  describe('assertAuthBypassEnvSafe', () => {
    it('throws when a flag is set in a disallowed environment', () => {
      set({ AUTH_BYPASS_ENABLED: 'true', HH_ENV: 'prod', NODE_ENV: 'production' });
      expect(() => assertAuthBypassEnvSafe()).toThrow(/refusing to start/);
    });

    it('passes when permitted, or when no flag is set', () => {
      set({ AUTH_BYPASS_ENABLED: 'true', HH_ENV: 'dev', NODE_ENV: 'development' });
      expect(() => assertAuthBypassEnvSafe()).not.toThrow();
      set({ HH_ENV: 'prod', NODE_ENV: 'production' });
      expect(() => assertAuthBypassEnvSafe()).not.toThrow();
    });
  });
});
