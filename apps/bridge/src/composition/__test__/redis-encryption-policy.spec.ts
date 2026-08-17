import { describe, expect, it, vi, type Mock } from 'vitest';

import type { RedisClientLogger, RedisConfig } from '../../common/redis/redis-client/index.js';
import { loadRedisConfig } from '../../common/redis/redis-client/redis.config.js';
import {
  assertRedisEncryptionConfig,
  buildRedisModuleOptions,
  RedisEncryptionConfigError,
} from '../app-root-providers.js';

type LogFn = (message: string, jobId?: string) => void;

function makeLogger(): RedisClientLogger & { warn: Mock<LogFn> } {
  return {
    debug: vi.fn<LogFn>(),
    info: vi.fn<LogFn>(),
    warn: vi.fn<LogFn>(),
    error: vi.fn<LogFn>(),
  };
}

function configFor(encryptionKey = ''): RedisConfig {
  return { ...loadRedisConfig({}), encryptionKey };
}

describe('assertRedisEncryptionConfig', () => {
  it('passes silently when an encryption key is configured', () => {
    const env: NodeJS.ProcessEnv = { BROKKR_ENV: 'prod' };
    const logger = makeLogger();
    expect(() => assertRedisEncryptionConfig(configFor('A'.repeat(44)), env, logger)).not.toThrow();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('fails closed when the key is unset and the environment requires encryption', () => {
    const env: NodeJS.ProcessEnv = { BROKKR_ENV: 'prod' };
    expect(() => assertRedisEncryptionConfig(configFor(), env, makeLogger())).toThrow(RedisEncryptionConfigError);
  });

  it('treats an unset environment as production and fails closed', () => {
    const env: NodeJS.ProcessEnv = {};
    expect(() => assertRedisEncryptionConfig(configFor(), env, makeLogger())).toThrow(/BRIDGE_AT_REST_KEY/);
  });

  it('fails closed for a cert-less local rig (LOCAL_SIMULATION_ENABLED=true) — no tolerance', () => {
    const env: NodeJS.ProcessEnv = { BROKKR_ENV: 'prod', LOCAL_SIMULATION_ENABLED: 'true' };
    const logger = makeLogger();
    expect(() => assertRedisEncryptionConfig(configFor(), env, logger)).toThrow(RedisEncryptionConfigError);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('fails closed for local/dev environments — no tolerance', () => {
    for (const environment of ['local', 'dev', 'DEV']) {
      const env: NodeJS.ProcessEnv = { BROKKR_ENV: environment };
      const logger = makeLogger();
      expect(() => assertRedisEncryptionConfig(configFor(), env, logger)).toThrow(RedisEncryptionConfigError);
      expect(logger.warn).not.toHaveBeenCalled();
    }
  });

  it('fails closed under a test runtime — no tolerance', () => {
    const env: NodeJS.ProcessEnv = { BROKKR_ENV: 'prod', VITEST: 'true' };
    const logger = makeLogger();
    expect(() => assertRedisEncryptionConfig(configFor(), env, logger)).toThrow(RedisEncryptionConfigError);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe('buildRedisModuleOptions loadRedisConfig-throws fallback', () => {
  const FAILING_URL = 'redis://localhost:6379/not-a-db';

  it('honors a set BRIDGE_AT_REST_KEY in the fallback path (prod does not fail closed)', () => {
    const key = 'A'.repeat(44);
    const env: NodeJS.ProcessEnv = { BROKKR_ENV: 'prod', REDIS_URL: FAILING_URL, BRIDGE_AT_REST_KEY: key };
    const options = buildRedisModuleOptions(env);
    expect(options.config.url).toBe('redis://localhost:6379/0');
    expect(options.config.encryptionKey).toBe(key);
  });

  it('fails closed in the fallback path when BRIDGE_AT_REST_KEY is unset (prod)', () => {
    const env: NodeJS.ProcessEnv = { BROKKR_ENV: 'prod', REDIS_URL: FAILING_URL };
    expect(() => buildRedisModuleOptions(env)).toThrow(RedisEncryptionConfigError);
  });
});
