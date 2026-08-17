import { hostname as osHostname } from 'node:os';

import { describe, expect, it } from 'vitest';

import { DEFAULT_CACHE_CAPACITY } from '../cache.js';
import {
  DEFAULT_POLL_MS,
  DEFAULT_TCP_IDLE_TIMEOUT_MS,
  DEFAULT_TCP_MAX_CONNECTIONS,
  DEFAULT_TCP_MAX_MESSAGE_BYTES,
  DEFAULT_TCP_MAX_QUERIES_PER_CONN,
  DEFAULT_TTL_SECONDS,
  DEFAULT_UPSTREAM_TIMEOUT_MS,
  defaultDnsConfig,
} from '../dns.config.js';

describe('defaultDnsConfig baseline', () => {
  it('is disabled — only the hub atom can enable DNS', () => {
    expect(defaultDnsConfig({}).enabled).toBe(false);
  });

  it('starts with no upstream resolvers (atom-carried or self-discovered at merge time)', () => {
    expect(defaultDnsConfig({}).upstreamResolvers).toEqual([]);
  });

  it('carries the fixed service defaults', () => {
    const cfg = defaultDnsConfig({});
    expect(cfg.ttlSeconds).toBe(DEFAULT_TTL_SECONDS);
    expect(cfg.upstreamTimeoutMs).toBe(DEFAULT_UPSTREAM_TIMEOUT_MS);
    expect(cfg.pollMs).toBe(DEFAULT_POLL_MS);
    expect(cfg.cacheSize).toBe(DEFAULT_CACHE_CAPACITY);
    expect(cfg.ownedDomain).toBe('lan');
    expect(cfg.tcpMaxConnections).toBe(DEFAULT_TCP_MAX_CONNECTIONS);
    expect(cfg.tcpMaxQueriesPerConn).toBe(DEFAULT_TCP_MAX_QUERIES_PER_CONN);
    expect(cfg.tcpIdleTimeoutMs).toBe(DEFAULT_TCP_IDLE_TIMEOUT_MS);
    expect(cfg.tcpMaxMessageBytes).toBe(DEFAULT_TCP_MAX_MESSAGE_BYTES);
  });

  it('leaves every TTL clamp dormant (0)', () => {
    const cfg = defaultDnsConfig({});
    expect(cfg.maxTtlSeconds).toBe(0);
    expect(cfg.maxCacheTtlSeconds).toBe(0);
    expect(cfg.minCacheTtlSeconds).toBe(0);
    expect(cfg.negTtlSeconds).toBe(0);
  });

  it('reads no DNS_* env vars — an env full of legacy knobs yields the same baseline', () => {
    const legacyEnv = {
      DNS_ENABLED: 'true',
      DNS_TTL_SECONDS: '999',
      DNS_UPSTREAM_RESOLVERS: '9.9.9.9',
      DNS_CACHE_SIZE: '7',
      DNS_LEADER_POLL_MS: '50',
      DNS_TCP_ENABLED: 'false',
    };
    expect(defaultDnsConfig(legacyEnv)).toEqual(defaultDnsConfig({}));
  });
});

describe('defaultDnsConfig hostname identity', () => {
  it('resolves hostname from BRIDGE_HOSTNAME when set', () => {
    expect(defaultDnsConfig({ BRIDGE_HOSTNAME: 'foo' }).hostname).toBe('foo');
  });

  it('falls back to os.hostname() only when BRIDGE_HOSTNAME is unset (undefined)', () => {
    expect(defaultDnsConfig({}).hostname).toBe(osHostname());
  });

  it('uses a set BRIDGE_HOSTNAME verbatim — byte-identical to leader-election (no trim)', () => {
    expect(defaultDnsConfig({ BRIDGE_HOSTNAME: ' spaced ' }).hostname).toBe(' spaced ');
  });

  it('includes both BRIDGE_HOSTNAME and os.hostname() in hostnames when they differ', () => {
    const cfg = defaultDnsConfig({ BRIDGE_HOSTNAME: 'custom-bridge' });
    expect(cfg.hostnames).toContain('custom-bridge');
    expect(cfg.hostnames).toContain(osHostname());
    expect(cfg.hostnames).toHaveLength(2);
  });

  it('hostnames contains only os.hostname() when BRIDGE_HOSTNAME is unset', () => {
    expect(defaultDnsConfig({}).hostnames).toEqual([osHostname()]);
  });

  it('does not duplicate hostnames when BRIDGE_HOSTNAME equals os.hostname()', () => {
    expect(defaultDnsConfig({ BRIDGE_HOSTNAME: osHostname() }).hostnames).toEqual([osHostname()]);
  });
});
