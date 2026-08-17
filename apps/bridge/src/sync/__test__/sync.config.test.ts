import { afterEach, describe, expect, it } from 'vitest';

import { buildSyncConfig, getSyncConfig, HTTPSConfigError, resetSyncConfig, validateHttpsConfig } from '../sync.config';

afterEach(() => {
  resetSyncConfig();
});

describe('buildSyncConfig — defaults', () => {
  it('instantiates with default env (no throw)', () => {
    const cfg = buildSyncConfig({});
    expect(cfg.brokkrLiveVersion).toBe('1.1.9');
    expect(cfg.httpsDownloadTimeout).toBe(3600);
    expect(cfg.httpsStallTimeout).toBe(120);
    expect(cfg.httpsVerifySsl).toBe(true);
    expect(cfg.httpsRetryAttempts).toBe(3);
    expect(cfg.httpsRetryDelay).toBe(5);
  });

  it('defaults osLayerUrl to the env-prefixed CDN', () => {
    const cfg = buildSyncConfig({ ENVIRONMENT: 'prod' });
    expect(cfg.osLayerUrl).toBe('https://brokkr.assets.prod.example.com/os-layers/blobs');
  });
});

describe('validateHttpsConfig', () => {
  it('accepts realistic OS_LAYER_URL values', () => {
    for (const okUrl of [
      'https://brokkr.assets.dev.example.com/os-layers/blobs',
      'https://bridge-1-2-3.lan/assets/os-layers/blobs',
      'http://localhost/blobs',
      'https://10.0.0.1/path/with-hyphens',
    ]) {
      const cfg = buildSyncConfig({ OS_LAYER_URL: okUrl });
      expect(() => validateHttpsConfig(cfg)).not.toThrow();
    }
  });

  it('rejects shell-unsafe characters in OS_LAYER_URL', () => {
    for (const badUrl of [
      'https://example.com/path;rm -rf /',
      'https://example.com/path&background',
      'https://example.com/path$(whoami)',
      'https://example.com/path`whoami`',
      'https://example.com/path with space',
      'https://example.com/path|pipe',
    ]) {
      const cfg = buildSyncConfig({ OS_LAYER_URL: badUrl });
      expect(() => validateHttpsConfig(cfg)).toThrow(HTTPSConfigError);
      expect(() => validateHttpsConfig(cfg)).toThrow(/shell-unsafe characters/);
    }
  });

  it('rejects HTTPS_VERIFY_SSL=false in non-local environments', () => {
    for (const environment of ['prod', 'stg']) {
      const cfg = buildSyncConfig({ ENVIRONMENT: environment, HTTPS_VERIFY_SSL: 'false' });
      expect(() => validateHttpsConfig(cfg)).toThrow(HTTPSConfigError);
      expect(() => validateHttpsConfig(cfg)).toThrow(/HTTPS_VERIFY_SSL=false/);
    }
  });

  it('permits HTTPS_VERIFY_SSL=false in local/dev environments', () => {
    for (const environment of ['local', 'dev']) {
      const cfg = buildSyncConfig({ ENVIRONMENT: environment, HTTPS_VERIFY_SSL: 'false' });
      expect(() => validateHttpsConfig(cfg)).not.toThrow();
    }
  });

  it('honors BROKKR_ENV over legacy ENVIRONMENT for the TLS guard', () => {
    const permitted = buildSyncConfig({ BROKKR_ENV: 'local', ENVIRONMENT: 'prod', HTTPS_VERIFY_SSL: 'false' });
    expect(() => validateHttpsConfig(permitted)).not.toThrow();

    const rejected = buildSyncConfig({ BROKKR_ENV: 'prod', ENVIRONMENT: 'dev', HTTPS_VERIFY_SSL: 'false' });
    expect(() => validateHttpsConfig(rejected)).toThrow(HTTPSConfigError);
  });

  it('permits HTTPS_VERIFY_SSL=false when LOCAL_SIMULATION_ENABLED=true regardless of env', () => {
    const cfg = buildSyncConfig({ ENVIRONMENT: 'prod', LOCAL_SIMULATION_ENABLED: 'true', HTTPS_VERIFY_SSL: 'false' });
    expect(() => validateHttpsConfig(cfg)).not.toThrow();
  });

  it('matches the resolved environment case-insensitively', () => {
    const cfg = buildSyncConfig({ ENVIRONMENT: 'LOCAL', HTTPS_VERIFY_SSL: 'false' });
    expect(() => validateHttpsConfig(cfg)).not.toThrow();
  });

  it('rejects a non-positive HTTPS_STALL_TIMEOUT', () => {
    const cfg = buildSyncConfig({ HTTPS_STALL_TIMEOUT: '0' });
    expect(() => validateHttpsConfig(cfg)).toThrow(/HTTPS_STALL_TIMEOUT must be positive/);
  });

  it('rejects a very low HTTPS_STALL_TIMEOUT', () => {
    const cfg = buildSyncConfig({ HTTPS_STALL_TIMEOUT: '5' });
    expect(() => validateHttpsConfig(cfg)).toThrow(/HTTPS_STALL_TIMEOUT is very low/);
  });

  it('rejects HTTPS_STALL_TIMEOUT greater than HTTPS_DOWNLOAD_TIMEOUT', () => {
    const cfg = buildSyncConfig({ HTTPS_STALL_TIMEOUT: '3600', HTTPS_DOWNLOAD_TIMEOUT: '60' });
    expect(() => validateHttpsConfig(cfg)).toThrow(/must not exceed HTTPS_DOWNLOAD_TIMEOUT/);
  });
});

describe('getSyncConfig singleton', () => {
  it('returns the cached instance on subsequent calls', () => {
    const a = getSyncConfig();
    const b = getSyncConfig();
    expect(a).toBe(b);
  });
});
