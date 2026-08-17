import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildGrpcConfig, getGrpcConfig, resetGrpcConfigForTests } from '../grpc.config';

describe('buildGrpcConfig — defaults', () => {
  it('uses default values when env is empty', () => {
    const config = buildGrpcConfig({});
    expect(config.enabled).toBe(true);
    expect(config.internalHost).toBe('127.0.0.1');
    expect(config.internalPort).toBe(9082);
    expect(config.externalPort).toBe(443);
  });
});

describe('buildGrpcConfig — GRPC_ENABLED', () => {
  it('reads "true" case-insensitively', () => {
    expect(buildGrpcConfig({ GRPC_ENABLED: 'true' }).enabled).toBe(true);
    expect(buildGrpcConfig({ GRPC_ENABLED: 'TRUE' }).enabled).toBe(true);
    expect(buildGrpcConfig({ GRPC_ENABLED: 'True' }).enabled).toBe(true);
  });

  it('treats any non-"true" value as false', () => {
    expect(buildGrpcConfig({ GRPC_ENABLED: 'false' }).enabled).toBe(false);
    expect(buildGrpcConfig({ GRPC_ENABLED: '0' }).enabled).toBe(false);
    expect(buildGrpcConfig({ GRPC_ENABLED: '' }).enabled).toBe(false);
    expect(buildGrpcConfig({ GRPC_ENABLED: 'yes' }).enabled).toBe(false);
  });
});

describe('buildGrpcConfig — host/port overrides', () => {
  it('honors GRPC_INTERNAL_HOST override', () => {
    expect(buildGrpcConfig({ GRPC_INTERNAL_HOST: '0.0.0.0' }).internalHost).toBe('0.0.0.0');
  });

  it('coerces numeric port strings', () => {
    const config = buildGrpcConfig({
      GRPC_INTERNAL_PORT: '9090',
      GRPC_EXTERNAL_PORT: '8443',
    });
    expect(config.internalPort).toBe(9090);
    expect(config.externalPort).toBe(8443);
  });

  it('accepts underscore digit grouping (e.g. "1_000")', () => {
    const config = buildGrpcConfig({ GRPC_INTERNAL_PORT: '10_000' });
    expect(config.internalPort).toBe(10000);
  });

  it('accepts surrounding whitespace and leading sign (e.g. " +9090 ")', () => {
    const config = buildGrpcConfig({
      GRPC_INTERNAL_PORT: ' 9090 ',
      GRPC_EXTERNAL_PORT: '+443',
    });
    expect(config.internalPort).toBe(9090);
    expect(config.externalPort).toBe(443);
  });
});

describe('buildGrpcConfig — malformed integer fallback', () => {
  beforeEach(() => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('falls back to default on non-numeric value', () => {
    const config = buildGrpcConfig({ GRPC_INTERNAL_PORT: 'abc' });
    expect(config.internalPort).toBe(9082);
  });

  it('falls back to default on float-shaped string (e.g. "30.0")', () => {
    const config = buildGrpcConfig({ GRPC_INTERNAL_PORT: '9082.0' });
    expect(config.internalPort).toBe(9082);
  });

  it('falls back to default on empty string', () => {
    const config = buildGrpcConfig({ GRPC_INTERNAL_PORT: '' });
    expect(config.internalPort).toBe(9082);
  });

  it('falls back to default on hex-prefixed string (e.g. "0x10")', () => {
    const config = buildGrpcConfig({ GRPC_EXTERNAL_PORT: '0x1bb' });
    expect(config.externalPort).toBe(443);
  });
});

describe('getGrpcConfig — singleton', () => {
  beforeEach(() => {
    resetGrpcConfigForTests();
  });

  afterEach(() => {
    resetGrpcConfigForTests();
  });

  it('returns the same instance across calls', () => {
    const first = getGrpcConfig();
    const second = getGrpcConfig();
    expect(second).toBe(first);
  });

  it('rebuilds after resetGrpcConfigForTests', () => {
    const first = getGrpcConfig();
    resetGrpcConfigForTests();
    const second = getGrpcConfig();
    expect(second).not.toBe(first);
  });
});
