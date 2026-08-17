import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentConfig } from '../../config';
import { createTransportPool, type TransportFactory } from '../pool';

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    device_id: 'test-device',
    zone_id: '00000000-0000-4000-8000-000000000001',
    insecure: false,
    bridges: [{ address: 'bridge-a.example:443' }],
    auth: { token: 'test-token' },
    tls: {
      ca_bundle_path: '/nonexistent/ca.crt',
      reject_unauthorized: false,
    },
    agent: {
      heartbeat_interval_ms: 30_000,
      heartbeat_timeout_ms: 90_000,
      reconnect_backoff_initial_ms: 1_000,
      reconnect_backoff_max_ms: 60_000,
      work_timeout_default_ms: 300_000,
      max_concurrent_dispatches: 96,
      token_renew_interval_ms: 3_600_000,
      log_level: 'info',
      collection_snapshot_path: '/tmp/brokkr-test-snapshots',
    },
    telemetry: { traces_enabled: false },
    ...overrides,
  };
}

describe('TransportPool', () => {
  let factory: TransportFactory;

  beforeEach(() => {
    factory = vi.fn().mockImplementation((baseUrl: string) => ({
      baseUrl,
    }));
  });

  it('creates a client on first getClient and reuses on second', () => {
    const pool = createTransportPool(makeConfig(), factory);
    const addr = 'https://bridge-a.example:443';

    const c1 = pool.getClient(addr);
    const c2 = pool.getClient(addr);

    expect(c1).toBe(c2);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('creates separate clients for different addresses', () => {
    const pool = createTransportPool(makeConfig(), factory);

    pool.getClient('https://bridge-a.example:443');
    pool.getClient('https://bridge-b.example:443');

    expect(factory).toHaveBeenCalledTimes(2);
    expect(pool.listAddresses()).toEqual(['https://bridge-a.example:443', 'https://bridge-b.example:443']);
  });

  it('removeBridge evicts the entry', () => {
    const pool = createTransportPool(makeConfig(), factory);
    pool.getClient('https://bridge-a.example:443');
    expect(pool.listAddresses()).toHaveLength(1);

    pool.removeBridge('https://bridge-a.example:443');

    expect(pool.listAddresses()).toHaveLength(0);
  });

  it('removeBridge is a no-op for unknown addresses', () => {
    const pool = createTransportPool(makeConfig(), factory);
    pool.removeBridge('https://nonexistent:443');
    expect(pool.listAddresses()).toHaveLength(0);
  });

  it('getClient creates a fresh client after removeBridge', () => {
    const pool = createTransportPool(makeConfig(), factory);
    const addr = 'https://bridge-a.example:443';

    const c1 = pool.getClient(addr);
    pool.removeBridge(addr);
    const c2 = pool.getClient(addr);

    expect(c1).not.toBe(c2);
    expect(factory).toHaveBeenCalledTimes(2);
  });
});
