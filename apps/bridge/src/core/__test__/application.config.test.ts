import { existsSync } from 'node:fs';
import { dirname } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { buildDocsConfig } from '../../docs/docs.config.js';
import { buildIpxeConfig } from '../../ipxe/ipxe.config.js';
import {
  buildApplicationConfig,
  getApplicationConfig,
  getZoneId,
  resetApplicationConfigForTests,
  resolveAssetsDir,
} from '../application.config.js';

afterEach(() => {
  resetApplicationConfigForTests();
});

describe('ApplicationConfig', () => {
  it('returns defaults when env is empty', () => {
    const cfg = buildApplicationConfig({});
    expect(cfg.logLevel).toBe('info');
    expect(cfg.debug).toBe(false);
    expect(cfg.logFormat).toBe('json');
    expect(cfg.logSuppressJobIdPrefixes).toEqual(['health-cron-', 'heartbeat-']);
    expect(cfg.host).toBe('127.0.0.1');
    expect(cfg.port).toBe(8080);
    expect(cfg.zoneId).toBe('');
    expect(cfg.bridgeUrl).toBe('https://brokkr.lan');
    expect(cfg.environment).toBe('prod');
    expect(cfg.localSimulationEnabled).toBe(false);
    expect(cfg.analyticsEnabled).toBe(false);
    expect(cfg.bridgeSyncEnabled).toBe(true);
  });

  describe('assets dir resolution', () => {
    it('resolveAssetsDir() with empty env points at an existing directory', () => {
      const dir = resolveAssetsDir({});
      expect(existsSync(dir)).toBe(true);
    });

    it('docs and ipxe configs resolve under the same existing assets dir with no override', () => {
      const docsPath = buildDocsConfig({}).docsAssetsPath;
      const ipxePath = buildIpxeConfig({}).assetsDir;
      expect(existsSync(docsPath)).toBe(true);
      expect(existsSync(ipxePath)).toBe(true);
      expect(dirname(docsPath)).toBe(resolveAssetsDir({}));
      expect(dirname(ipxePath)).toBe(resolveAssetsDir({}));
    });

    it('honors an explicit override via BRIDGE_ASSETS_DIR or ASSETS_DIR', () => {
      expect(resolveAssetsDir({ BRIDGE_ASSETS_DIR: '/custom/a' })).toBe('/custom/a');
      expect(resolveAssetsDir({ ASSETS_DIR: '/custom/b' })).toBe('/custom/b');
    });
  });

  it('reports the container bind host (0.0.0.0) when HOST is set', () => {
    expect(buildApplicationConfig({ HOST: '0.0.0.0' }).host).toBe('0.0.0.0');
  });

  it('lowercases LOG_LEVEL and sets debug when LOG_LEVEL=DEBUG', () => {
    const cfg = buildApplicationConfig({ LOG_LEVEL: 'DEBUG' });
    expect(cfg.logLevel).toBe('debug');
    expect(cfg.debug).toBe(true);
  });

  it('lowercases LOG_FORMAT', () => {
    const cfg = buildApplicationConfig({ LOG_FORMAT: 'CONSOLE' });
    expect(cfg.logFormat).toBe('console');
  });

  it('parses LOG_SUPPRESS_JOB_ID_PREFIXES (comma split, trim, drop empty)', () => {
    const cfg = buildApplicationConfig({
      LOG_SUPPRESS_JOB_ID_PREFIXES: ' foo- , bar- ,,baz-',
    });
    expect(cfg.logSuppressJobIdPrefixes).toEqual(['foo-', 'bar-', 'baz-']);
  });

  it('respects explicit empty LOG_SUPPRESS_JOB_ID_PREFIXES (no prefixes)', () => {
    const cfg = buildApplicationConfig({ LOG_SUPPRESS_JOB_ID_PREFIXES: '' });
    expect(cfg.logSuppressJobIdPrefixes).toEqual([]);
  });

  it('parses PORT as integer', () => {
    const cfg = buildApplicationConfig({ PORT: '9090' });
    expect(cfg.port).toBe(9090);
  });

  it('rejects non-integer PORT', () => {
    expect(() => buildApplicationConfig({ PORT: 'not-a-number' })).toThrow();
  });

  it('rejects explicit-empty PORT (default only applies when unset)', () => {
    expect(() => buildApplicationConfig({ PORT: '' })).toThrow(/invalid integer/);
  });

  it('trims zoneId whitespace', () => {
    const cfg = buildApplicationConfig({ BROKKR_ZONE_ID: '  abc-zone  ' });
    expect(cfg.zoneId).toBe('abc-zone');
  });

  it('strips trailing slashes from BRIDGE_URL', () => {
    const cfg = buildApplicationConfig({ BRIDGE_URL: 'https://example.com///' });
    expect(cfg.bridgeUrl).toBe('https://example.com');
  });

  it('ANALYTICS_ENABLED=true (case-insensitive) sets analyticsEnabled', () => {
    const cfg = buildApplicationConfig({ ANALYTICS_ENABLED: 'True' });
    expect(cfg.analyticsEnabled).toBe(true);
  });

  it('BRIDGE_SYNC_ENABLED=false disables bridgeSyncEnabled', () => {
    const cfg = buildApplicationConfig({ BRIDGE_SYNC_ENABLED: 'false' });
    expect(cfg.bridgeSyncEnabled).toBe(false);
  });

  it('BRIDGE_SYNC_ENABLED default is true', () => {
    const cfg = buildApplicationConfig({});
    expect(cfg.bridgeSyncEnabled).toBe(true);
  });

  it('does not expose a config-derived phone-home endpoint (hub-rendered by design)', () => {
    const cfg = buildApplicationConfig({ ENVIRONMENT: 'prod', PHONE_HOME_BASE_URL: 'https://operator.example' });
    expect(cfg).not.toHaveProperty('phoneHomeEndpoint');
    expect(JSON.stringify(cfg)).not.toContain('hydrahost.com');
    expect(JSON.stringify(cfg)).not.toContain('operator.example');
  });

  it('BRIDGE_API_VERSION env override wins over package.json/fallback', () => {
    const cfg = buildApplicationConfig({ BRIDGE_API_VERSION: '1.2.3-test' });
    expect(cfg.version).toBe('1.2.3-test');
  });

  it('BRIDGE_ASSETS_DIR override replaces derived assets dir', () => {
    const cfg = buildApplicationConfig({ BRIDGE_ASSETS_DIR: '/opt/custom/assets' });
    expect(cfg.assetsDir).toBe('/opt/custom/assets');
  });

  it('caches the resolved config (returns the same instance)', () => {
    const a = getApplicationConfig();
    const b = getApplicationConfig();
    expect(a).toBe(b);
  });
});

describe('getZoneId', () => {
  it('returns the trimmed zone id when set', () => {
    process.env.BROKKR_ZONE_ID = '  zone-uuid-123  ';
    resetApplicationConfigForTests();
    try {
      expect(getZoneId()).toBe('zone-uuid-123');
    } finally {
      delete process.env.BROKKR_ZONE_ID;
      resetApplicationConfigForTests();
    }
  });

  it('raises when BROKKR_ZONE_ID is unset', () => {
    const prev = process.env.BROKKR_ZONE_ID;
    delete process.env.BROKKR_ZONE_ID;
    resetApplicationConfigForTests();
    try {
      expect(() => getZoneId()).toThrow(/BROKKR_ZONE_ID is not set/);
    } finally {
      if (prev !== undefined) process.env.BROKKR_ZONE_ID = prev;
      resetApplicationConfigForTests();
    }
  });

  it('raises when BROKKR_ZONE_ID is blank whitespace', () => {
    process.env.BROKKR_ZONE_ID = '   ';
    resetApplicationConfigForTests();
    try {
      expect(() => getZoneId()).toThrow(/BROKKR_ZONE_ID is not set/);
    } finally {
      delete process.env.BROKKR_ZONE_ID;
      resetApplicationConfigForTests();
    }
  });
});
