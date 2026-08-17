import { hostname } from 'node:os';

import { describe, expect, it } from 'vitest';

import { buildLeaderConfig } from '../leader-election.config';

describe('buildLeaderConfig — defaults', () => {
  it('uses default TTL values when env is empty', () => {
    const config = buildLeaderConfig({});
    expect(config.leaderTtlSeconds).toBe(30);
    expect(config.leaderRenewIntervalSeconds).toBe(10);
    expect(config.leaderHeartbeatTimeoutSeconds).toBe(15);
    expect(config.registryTtlSeconds).toBe(120);
  });

  it('falls back to OS hostname for instance_id', () => {
    const config = buildLeaderConfig({});
    expect(config.instanceId).toBe(hostname());
  });

  it('locks the leader key + registry prefix', () => {
    const config = buildLeaderConfig({});
    expect(config.leaderKey).toBe('bridge:leader');
    expect(config.registryKeyPrefix).toBe('bridge:instance:');
  });
});

describe('buildLeaderConfig — overrides', () => {
  it('honors BRIDGE_HOSTNAME for instance_id', () => {
    const config = buildLeaderConfig({ BRIDGE_HOSTNAME: 'my-custom-bridge' });
    expect(config.instanceId).toBe('my-custom-bridge');
  });

  it('coerces numeric env strings', () => {
    const config = buildLeaderConfig({
      LEADER_TTL_SECONDS: '60',
      LEADER_RENEW_INTERVAL_SECONDS: '20',
      LEADER_HEARTBEAT_TIMEOUT_SECONDS: '25',
      REGISTRY_TTL_SECONDS: '120',
    });
    expect(config.leaderTtlSeconds).toBe(60);
    expect(config.leaderRenewIntervalSeconds).toBe(20);
    expect(config.leaderHeartbeatTimeoutSeconds).toBe(25);
    expect(config.registryTtlSeconds).toBe(120);
  });

  it('rejects empty-string env values (parity with strict int parsing)', () => {
    expect(() => buildLeaderConfig({ LEADER_TTL_SECONDS: '' })).toThrow();
  });

  it('rejects non-numeric env values', () => {
    expect(() => buildLeaderConfig({ LEADER_TTL_SECONDS: 'abc' })).toThrow();
  });

  it('rejects float-shaped strings (parity with strict int parsing)', () => {
    expect(() => buildLeaderConfig({ LEADER_TTL_SECONDS: '30.0' })).toThrow();
  });

  it('rejects hex-prefixed strings (parity with strict int parsing)', () => {
    expect(() => buildLeaderConfig({ LEADER_TTL_SECONDS: '0x10' })).toThrow();
  });

  it('rejects exponent-shaped strings (parity with strict int parsing)', () => {
    expect(() => buildLeaderConfig({ LEADER_TTL_SECONDS: '3e10' })).toThrow();
  });

  it('accepts underscore digit grouping (parity with strict int parsing)', () => {
    const config = buildLeaderConfig({ LEADER_TTL_SECONDS: '1_000' });
    expect(config.leaderTtlSeconds).toBe(1000);
  });

  it('accepts surrounding whitespace and leading sign', () => {
    const config = buildLeaderConfig({
      LEADER_TTL_SECONDS: ' 30 ',
      LEADER_RENEW_INTERVAL_SECONDS: '+10',
    });
    expect(config.leaderTtlSeconds).toBe(30);
    expect(config.leaderRenewIntervalSeconds).toBe(10);
  });
});

describe('buildLeaderConfig — TTL invariant', () => {
  it('fails fast when TTL <= renew + heartbeat-timeout', () => {
    expect(() =>
      buildLeaderConfig({
        LEADER_TTL_SECONDS: '20',
        LEADER_RENEW_INTERVAL_SECONDS: '10',
        LEADER_HEARTBEAT_TIMEOUT_SECONDS: '15',
      }),
    ).toThrow(/LEADER_TTL_SECONDS/);
  });

  it('rejects TTL exactly equal to renew + heartbeat-timeout (strict >)', () => {
    expect(() =>
      buildLeaderConfig({
        LEADER_TTL_SECONDS: '25',
        LEADER_RENEW_INTERVAL_SECONDS: '10',
        LEADER_HEARTBEAT_TIMEOUT_SECONDS: '15',
      }),
    ).toThrow(/LEADER_TTL_SECONDS/);
  });

  it('accepts TTL strictly greater than renew + heartbeat-timeout', () => {
    const config = buildLeaderConfig({
      LEADER_TTL_SECONDS: '26',
      LEADER_RENEW_INTERVAL_SECONDS: '10',
      LEADER_HEARTBEAT_TIMEOUT_SECONDS: '15',
    });
    expect(config.leaderTtlSeconds).toBe(26);
  });

  it('the shipped defaults satisfy the invariant', () => {
    expect(() => buildLeaderConfig({})).not.toThrow();
  });
});
