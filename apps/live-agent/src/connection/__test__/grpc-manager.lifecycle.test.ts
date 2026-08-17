import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentConfig } from '../../config';

const h = vi.hoisted(() => {
  type Call = {
    addr: string;
    callbacks: { onRegistered: (b: unknown[]) => void; onTopologyUpdate: (b: unknown[], e: unknown[]) => void };
    signal: AbortSignal;
    phoneHomeProvider: () => unknown;
    resolve: (r: { permanent: boolean }) => void;
    reject: (e: unknown) => void;
  };
  const sessionCalls: Call[] = [];
  const runSession = vi.fn(
    (
      _client: unknown,
      addr: string,
      _config: unknown,
      _reporter: unknown,
      callbacks: Call['callbacks'],
      signal: AbortSignal,
      phoneHomeProvider: () => unknown,
    ) => {
      return new Promise<{ permanent: boolean }>((resolve, reject) => {
        sessionCalls.push({ addr, callbacks, signal, phoneHomeProvider, resolve, reject });
      });
    },
  );
  return {
    sessionCalls,
    runSession,
    pool: { getClient: vi.fn((a: string) => ({ __addr: a })), removeBridge: vi.fn(), listAddresses: vi.fn(() => []) },
    logShipper: { start: vi.fn(), stop: vi.fn() },
    tokenRenewer: { start: vi.fn(), stop: vi.fn() },
    sleepWithAbort: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('../session', () => ({ runSession: h.runSession }));
vi.mock('../pool', () => ({ createTransportPool: () => h.pool }));
vi.mock('../result-reporter', () => ({ createResultReporter: () => ({}) }));
vi.mock('../log-shipper', () => ({ LogShipper: vi.fn(() => h.logShipper) }));
vi.mock('../token-renewer', () => ({ TokenRenewer: vi.fn(() => h.tokenRenewer) }));
vi.mock('../sleep', () => ({ sleepWithAbort: h.sleepWithAbort }));

import { GrpcConnectionManager } from '../grpc-manager';

function makeConfig(addresses: string[]): AgentConfig {
  return {
    device_id: 'dev-1',
    zone_id: '00000000-0000-4000-8000-000000000001',
    insecure: false,
    bridges: addresses.map((address) => ({ address })),
    auth: { token: 't' },
    tls: { ca_bundle_path: '/nonexistent/ca.crt', reject_unauthorized: false },
    telemetry: { traces_enabled: false },
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
  };
}

describe('GrpcConnectionManager lifecycle', () => {
  let mgr: GrpcConnectionManager | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    h.sessionCalls.length = 0;
  });

  afterEach(() => {
    mgr?.stop();
    mgr = null;
  });

  it('reconcile starts one session per configured bridge', async () => {
    mgr = new GrpcConnectionManager(makeConfig(['b1:443', 'b2:443']));
    mgr.start();

    await vi.waitFor(() => expect(h.runSession).toHaveBeenCalledTimes(2));
    expect(h.pool.getClient).toHaveBeenCalledTimes(2);
    expect(h.logShipper.start).toHaveBeenCalledOnce();
    expect(h.tokenRenewer.start).toHaveBeenCalledOnce();
  });

  it('a permanent result evicts the bridge and a later reconcile does not re-add it', async () => {
    mgr = new GrpcConnectionManager(makeConfig(['b1:443']));
    mgr.start();
    await vi.waitFor(() => expect(h.sessionCalls).toHaveLength(1));

    const first = h.sessionCalls[0]!;
    first.resolve({ permanent: true });

    await vi.waitFor(() => expect(h.pool.removeBridge).toHaveBeenCalledWith(first.addr));

    first.callbacks.onTopologyUpdate([{ address: 'b1:443', bridge_id: 'x' }], []);
    await Promise.resolve();
    expect(h.runSession).toHaveBeenCalledTimes(1);
  });

  it('a non-permanent result reconnects after a backoff sleep', async () => {
    mgr = new GrpcConnectionManager(makeConfig(['b1:443']));
    mgr.start();
    await vi.waitFor(() => expect(h.sessionCalls).toHaveLength(1));

    h.sessionCalls[0]!.resolve({ permanent: false });

    await vi.waitFor(() => expect(h.sessionCalls).toHaveLength(2));
    expect(h.sleepWithAbort).toHaveBeenCalled();
    expect(h.sessionCalls[1]!.addr).toBe(h.sessionCalls[0]!.addr);
    expect(h.sleepWithAbort.mock.calls[0]![0]).toBeGreaterThanOrEqual(1_000);
  });

  it('reconcile is idempotent — re-listing an active bridge does not start a second session', async () => {
    mgr = new GrpcConnectionManager(makeConfig(['b1:443']));
    mgr.start();
    await vi.waitFor(() => expect(h.sessionCalls).toHaveLength(1));

    h.sessionCalls[0]!.callbacks.onTopologyUpdate([{ address: 'b1:443', bridge_id: 'x' }], []);
    await Promise.resolve();
    expect(h.runSession).toHaveBeenCalledTimes(1);
  });

  it('reconcile removes a dropped bridge: aborts its session and calls pool.removeBridge', async () => {
    mgr = new GrpcConnectionManager(makeConfig(['b1:443', 'b2:443']));
    mgr.start();
    await vi.waitFor(() => expect(h.sessionCalls).toHaveLength(2));

    const b2 = h.sessionCalls.find((c) => c.addr.includes('b2'))!;
    h.sessionCalls[0]!.callbacks.onTopologyUpdate([{ address: 'b1:443', bridge_id: 'x' }], []);
    await Promise.resolve();

    expect(b2.signal.aborted).toBe(true);
    expect(h.pool.removeBridge).toHaveBeenCalledWith(b2.addr);
  });

  it('stop() aborts all sessions and stops the log shipper and token renewer', async () => {
    mgr = new GrpcConnectionManager(makeConfig(['b1:443', 'b2:443']));
    mgr.start();
    await vi.waitFor(() => expect(h.sessionCalls).toHaveLength(2));
    const signals = h.sessionCalls.map((c) => c.signal);

    mgr.stop();
    mgr = null;

    expect(signals.every((s) => s.aborted)).toBe(true);
    expect(h.logShipper.stop).toHaveBeenCalledOnce();
    expect(h.tokenRenewer.stop).toHaveBeenCalledOnce();
  });

  it('stop() clears the keep-alive interval timer', async () => {
    const clearSpy = vi.spyOn(globalThis, 'clearInterval');
    mgr = new GrpcConnectionManager(makeConfig(['b1:443']));
    mgr.start();
    await vi.waitFor(() => expect(h.sessionCalls).toHaveLength(1));

    mgr.stop();
    mgr = null;

    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });

  it('a thrown session iteration backs off at max and retries the same address (no leak)', async () => {
    mgr = new GrpcConnectionManager(makeConfig(['b1:443']));
    mgr.start();
    await vi.waitFor(() => expect(h.sessionCalls).toHaveLength(1));

    const first = h.sessionCalls[0]!;
    first.reject(new Error('boom'));

    await vi.waitFor(() => expect(h.sessionCalls).toHaveLength(2));
    expect(h.sleepWithAbort).toHaveBeenCalledWith(60_000, expect.anything());
    expect(h.sessionCalls[1]!.addr).toBe(first.addr);
    expect(h.pool.removeBridge).not.toHaveBeenCalled();
    expect(h.runSession.mock.calls.every((c) => c[1] === first.addr)).toBe(true);
  });

  it('a crashed session loop aborts the session and deletes its entry (no leak)', async () => {
    h.sleepWithAbort.mockRejectedValueOnce(new Error('sleep crashed'));
    mgr = new GrpcConnectionManager(makeConfig(['b1:443']));
    mgr.start();
    await vi.waitFor(() => expect(h.sessionCalls).toHaveLength(1));

    const first = h.sessionCalls[0]!;
    first.reject(new Error('boom'));

    await vi.waitFor(() => expect(first.signal.aborted).toBe(true));
    first.callbacks.onTopologyUpdate([{ address: 'b1:443', bridge_id: 'x' }], []);
    await vi.waitFor(() => expect(h.sessionCalls).toHaveLength(2));
  });

  it('a sustained session resets backoff so the next reconnect delay drops to the floor', async () => {
    vi.useFakeTimers();
    const rnd = vi.spyOn(Math, 'random').mockReturnValue(0.999);
    try {
      mgr = new GrpcConnectionManager(makeConfig(['b1:443']));
      mgr.start();
      await vi.waitFor(() => expect(h.sessionCalls).toHaveLength(1));

      h.sessionCalls[0]!.resolve({ permanent: false });
      await vi.waitFor(() => expect(h.sessionCalls).toHaveLength(2));
      h.sessionCalls[1]!.resolve({ permanent: false });
      await vi.waitFor(() => expect(h.sessionCalls).toHaveLength(3));
      const escalatedDelay = h.sleepWithAbort.mock.calls[1]![0] as number;
      expect(escalatedDelay).toBeGreaterThan(1_000);

      h.sessionCalls[2]!.callbacks.onRegistered([]);
      vi.setSystemTime(Date.now() + 30_000);
      h.sessionCalls[2]!.resolve({ permanent: false });
      await vi.waitFor(() => expect(h.sessionCalls).toHaveLength(4));

      const postResetDelay = h.sleepWithAbort.mock.calls[2]![0] as number;
      expect(postResetDelay).toBe(1_000);
      expect(postResetDelay).toBeLessThan(escalatedDelay);
    } finally {
      rnd.mockRestore();
      vi.useRealTimers();
    }
  });

  it('an accept-then-drop session under one heartbeat interval does not reset backoff', async () => {
    vi.useFakeTimers();
    const rnd = vi.spyOn(Math, 'random').mockReturnValue(0.999);
    try {
      mgr = new GrpcConnectionManager(makeConfig(['b1:443']));
      mgr.start();
      await vi.waitFor(() => expect(h.sessionCalls).toHaveLength(1));

      h.sessionCalls[0]!.resolve({ permanent: false });
      await vi.waitFor(() => expect(h.sessionCalls).toHaveLength(2));
      h.sessionCalls[1]!.resolve({ permanent: false });
      await vi.waitFor(() => expect(h.sessionCalls).toHaveLength(3));
      const escalatedDelay = h.sleepWithAbort.mock.calls[1]![0] as number;
      expect(escalatedDelay).toBeGreaterThan(1_000);

      h.sessionCalls[2]!.callbacks.onRegistered([]);
      vi.setSystemTime(Date.now() + 5_000);
      h.sessionCalls[2]!.resolve({ permanent: false });
      await vi.waitFor(() => expect(h.sessionCalls).toHaveLength(4));

      const nextDelay = h.sleepWithAbort.mock.calls[2]![0] as number;
      expect(nextDelay).toBeGreaterThan(escalatedDelay);
      expect(nextDelay).not.toBe(1_000);
    } finally {
      rnd.mockRestore();
      vi.useRealTimers();
    }
  });

  function addrOf(client: unknown): string {
    if (client !== null && typeof client === 'object' && '__addr' in client && typeof client.__addr === 'string') {
      return client.__addr;
    }
    throw new Error('expected stub client with __addr');
  }

  it('phone-home provider rotates across live bridges instead of pinning to index 0', async () => {
    mgr = new GrpcConnectionManager(makeConfig(['b1:443', 'b2:443', 'b3:443']));
    mgr.start();
    await vi.waitFor(() => expect(h.sessionCalls).toHaveLength(3));

    const provider = h.sessionCalls[0]!.phoneHomeProvider;
    const picks = [provider(), provider(), provider()].map(addrOf);

    expect(new Set(picks).size).toBeGreaterThan(1);
    expect(picks).toEqual([...new Set(picks)]);
  });

  it('phone-home provider never returns a permanently-rejected / removed bridge', async () => {
    mgr = new GrpcConnectionManager(makeConfig(['b1:443', 'b2:443', 'b3:443']));
    mgr.start();
    await vi.waitFor(() => expect(h.sessionCalls).toHaveLength(3));

    const provider = h.sessionCalls[0]!.phoneHomeProvider;
    const evicted = h.sessionCalls.find((c) => c.addr.includes('b2'))!;
    evicted.resolve({ permanent: true });
    await vi.waitFor(() => expect(h.pool.removeBridge).toHaveBeenCalledWith(evicted.addr));

    const picks = Array.from({ length: 6 }, () => provider()).map(addrOf);
    expect(picks).not.toContain(evicted.addr);
    expect(new Set(picks)).toEqual(new Set([h.sessionCalls[0]!.addr, h.sessionCalls[2]!.addr]));
  });

  it('phone-home provider returns null when no bridge is live', async () => {
    mgr = new GrpcConnectionManager(makeConfig(['b1:443']));
    mgr.start();
    await vi.waitFor(() => expect(h.sessionCalls).toHaveLength(1));

    const provider = h.sessionCalls[0]!.phoneHomeProvider;
    h.sessionCalls[0]!.resolve({ permanent: true });
    await vi.waitFor(() => expect(h.pool.removeBridge).toHaveBeenCalled());

    expect(provider()).toBeNull();
  });
});
