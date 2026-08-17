import { afterEach, describe, expect, it } from 'vitest';

import { buildZoneCryptoConfig, getZoneCryptoConfig, resetZoneCryptoConfigForTests } from '../zone-crypto.config';

afterEach(() => {
  resetZoneCryptoConfigForTests();
});

describe('ZoneCryptoConfig — defaults', () => {
  it('master switch off when env empty', () => {
    const cfg = buildZoneCryptoConfig({});
    expect(cfg.hubUrl).toBe('');
    expect(cfg.registrationToken).toBe('');
  });

  it('default http timeout 30s', () => {
    expect(buildZoneCryptoConfig({}).httpTimeoutSeconds).toBe(30.0);
  });

  it('default polling schedule (1s -> 5min cap, 10min total)', () => {
    const cfg = buildZoneCryptoConfig({});
    expect(cfg.pollInitialBackoffSeconds).toBe(1.0);
    expect(cfg.pollMaxBackoffSeconds).toBe(300.0);
    expect(cfg.pollTotalTimeoutSeconds).toBe(600.0);
  });

  it('cacheKey is the literal "zone_crypto"', () => {
    expect(buildZoneCryptoConfig({}).cacheKey).toBe('zone_crypto');
  });

  it('default marker path', () => {
    expect(buildZoneCryptoConfig({}).markerPath).toBe('/var/lib/brokkr-bridge/zone-crypto.lock');
  });

  it('marker path override is stripped', () => {
    const cfg = buildZoneCryptoConfig({
      BRIDGE_ZONE_CRYPTO_MARKER_PATH: '  /custom/path/marker.lock  ',
    });
    expect(cfg.markerPath).toBe('/custom/path/marker.lock');
  });
});

describe('ZoneCryptoConfig — overrides', () => {
  it('hub_url and registration_token from env', () => {
    const cfg = buildZoneCryptoConfig({
      BROKKR_HUB_URL: 'https://hub.example.com',
      BROKKR_REGISTRATION_TOKEN: 'tok-abc123',
    });
    expect(cfg.hubUrl).toBe('https://hub.example.com');
    expect(cfg.registrationToken).toBe('tok-abc123');
  });

  it('hub_url is stripped of surrounding whitespace', () => {
    const cfg = buildZoneCryptoConfig({
      BROKKR_HUB_URL: '  https://hub.example.com/  ',
    });
    expect(cfg.hubUrl).toBe('https://hub.example.com/');
  });

  it('registration_token is stripped', () => {
    const cfg = buildZoneCryptoConfig({
      BROKKR_REGISTRATION_TOKEN: '  tok-abc123  ',
    });
    expect(cfg.registrationToken).toBe('tok-abc123');
  });

  it('honors custom timing env vars', () => {
    const cfg = buildZoneCryptoConfig({
      ZONE_CRYPTO_HTTP_TIMEOUT_SECONDS: '45',
      ZONE_CRYPTO_POLL_INITIAL_BACKOFF_SECONDS: '2',
      ZONE_CRYPTO_POLL_MAX_BACKOFF_SECONDS: '60',
      ZONE_CRYPTO_POLL_TOTAL_TIMEOUT_SECONDS: '120',
    });
    expect(cfg.httpTimeoutSeconds).toBe(45.0);
    expect(cfg.pollInitialBackoffSeconds).toBe(2.0);
    expect(cfg.pollMaxBackoffSeconds).toBe(60.0);
    expect(cfg.pollTotalTimeoutSeconds).toBe(120.0);
  });

  it('accepts fractional timeouts', () => {
    const cfg = buildZoneCryptoConfig({ ZONE_CRYPTO_HTTP_TIMEOUT_SECONDS: '0.5' });
    expect(cfg.httpTimeoutSeconds).toBe(0.5);
  });
});

describe('getZoneCryptoConfig', () => {
  it('returns the cached instance on subsequent calls', () => {
    const a = getZoneCryptoConfig();
    const b = getZoneCryptoConfig();
    expect(a).toBe(b);
  });
});
