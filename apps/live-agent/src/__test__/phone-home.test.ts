import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentConfig } from '../config';
import type { BufferedEntry, setLogSink as SetLogSink } from '../logger';
import type {
  cancelPhoneHomeRetry as CancelPhoneHomeRetry,
  firePhoneHomeOverGrpc as FirePhoneHome,
  PhoneHomeClientProvider,
} from '../phone-home';

function makeConfig(): AgentConfig {
  return {
    device_id: 'dev-test',
    zone_id: '00000000-0000-4000-8000-000000000001',
    insecure: false,
    bridges: [{ address: 'test-bridge:443' }],
    auth: { token: 'test-token' },
    tls: { ca_bundle_path: undefined, reject_unauthorized: false },
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
  };
}

interface PhoneHomeReq {
  deviceId: string;
  bootId: string;
}

type AgentClient = ReturnType<PhoneHomeClientProvider> & object;

function makeClient(impl?: () => Promise<unknown>) {
  const phoneHome = vi.fn((_req: PhoneHomeReq) => impl?.() ?? Promise.resolve({}));
  const client = { phoneHome } as unknown as AgentClient;
  return { client, provider: (() => client) as PhoneHomeClientProvider, phoneHome };
}

const FAST_DELAYS = [1, 1, 1];

describe('firePhoneHomeOverGrpc', () => {
  let dir: string;
  let gatePath: string;
  let bootIdPath: string;
  let captured: BufferedEntry[];
  let firePhoneHomeOverGrpc: typeof FirePhoneHome;
  let cancelPhoneHomeRetry: typeof CancelPhoneHomeRetry;
  let setLogSink: typeof SetLogSink;

  beforeEach(async () => {
    vi.resetModules();
    ({ firePhoneHomeOverGrpc, cancelPhoneHomeRetry } = await import('../phone-home'));
    ({ setLogSink } = await import('../logger'));
    dir = mkdtempSync(join(tmpdir(), 'agent-phone-home-'));
    gatePath = join(dir, 'gate');
    bootIdPath = join(dir, 'boot-id');
    captured = [];
    setLogSink((e) => captured.push(e));
  });

  afterEach(() => {
    cancelPhoneHomeRetry();
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
    setLogSink(null);
    vi.restoreAllMocks();
  });

  function writeBootId(value: string) {
    writeFileSync(bootIdPath, `${value}\n`);
  }

  function loggedMessages(): string[] {
    return captured.map((e) => e.message);
  }

  describe('per-boot gate', () => {
    it('sends PhoneHome with device_id + boot_id and writes the gate on success', async () => {
      writeBootId('boot-aaa');
      const { provider, phoneHome } = makeClient();

      await firePhoneHomeOverGrpc(provider, makeConfig(), { gatePath, bootIdPath });

      expect(phoneHome).toHaveBeenCalledTimes(1);
      const req = phoneHome.mock.calls[0]![0];
      expect(req.deviceId).toBe('dev-test');
      expect(req.bootId).toBe('boot-aaa');
      expect(readFileSync(gatePath, 'utf8').trim()).toBe('boot-aaa');
    });

    it('skips when the gate already records the current boot', async () => {
      writeBootId('boot-bbb');
      writeFileSync(gatePath, 'boot-bbb');
      const { provider, phoneHome } = makeClient();

      await firePhoneHomeOverGrpc(provider, makeConfig(), { gatePath, bootIdPath });

      expect(phoneHome).not.toHaveBeenCalled();
    });

    it('re-fires when the gate records a stale (different) boot id', async () => {
      writeBootId('boot-new');
      writeFileSync(gatePath, 'boot-old');
      const { provider, phoneHome } = makeClient();

      await firePhoneHomeOverGrpc(provider, makeConfig(), { gatePath, bootIdPath });

      expect(phoneHome).toHaveBeenCalledTimes(1);
    });

    it('fires only once per process across repeated session-accepts', async () => {
      writeBootId('boot-ddd');
      const { provider, phoneHome } = makeClient();

      await firePhoneHomeOverGrpc(provider, makeConfig(), { gatePath, bootIdPath });
      await firePhoneHomeOverGrpc(provider, makeConfig(), { gatePath, bootIdPath });

      expect(phoneHome).toHaveBeenCalledTimes(1);
    });
  });

  describe('unreadable boot_id sentinel', () => {
    it("sends and gates the 'unknown-boot' sentinel when boot_id is unreadable", async () => {
      const { provider, phoneHome } = makeClient();

      await firePhoneHomeOverGrpc(provider, makeConfig(), { gatePath, bootIdPath });

      expect(phoneHome.mock.calls[0]![0].bootId).toBe('unknown-boot');
      expect(readFileSync(gatePath, 'utf8').trim()).toBe('unknown-boot');
    });

    it('re-fires when the gate holds the sentinel and the current boot_id is still unreadable', async () => {
      writeFileSync(gatePath, 'unknown-boot');
      const { provider, phoneHome } = makeClient();

      await firePhoneHomeOverGrpc(provider, makeConfig(), { gatePath, bootIdPath });

      expect(phoneHome).toHaveBeenCalledTimes(1);
    });
  });

  describe('concurrent coalescing', () => {
    it('coalesces concurrent callers onto a single attempt', async () => {
      writeBootId('boot-conc');
      const { provider, phoneHome } = makeClient();

      const a = firePhoneHomeOverGrpc(provider, makeConfig(), { gatePath, bootIdPath });
      const b = firePhoneHomeOverGrpc(provider, makeConfig(), { gatePath, bootIdPath });
      await Promise.all([a, b]);

      expect(phoneHome).toHaveBeenCalledTimes(1);
    });
  });

  describe('retry ladder', () => {
    it('does not write the gate while attempts keep failing', async () => {
      writeBootId('boot-ccc');
      const failing = makeClient(() => Promise.reject(new Error('grpc unavailable')));

      await firePhoneHomeOverGrpc(failing.provider, makeConfig(), { gatePath, bootIdPath, retryDelaysMs: FAST_DELAYS });

      expect(existsSync(gatePath)).toBe(false);
    });

    it('retries on the backoff ladder and succeeds mid-ladder', async () => {
      writeBootId('boot-eee');
      let attempt = 0;
      const phoneHome = vi.fn((_req: PhoneHomeReq) => {
        attempt += 1;
        return attempt >= 3 ? Promise.resolve({}) : Promise.reject(new Error('transient'));
      });
      const client = { phoneHome } as unknown as AgentClient;

      await firePhoneHomeOverGrpc(() => client, makeConfig(), { gatePath, bootIdPath, retryDelaysMs: FAST_DELAYS });

      expect(phoneHome).toHaveBeenCalledTimes(3);
      expect(readFileSync(gatePath, 'utf8').trim()).toBe('boot-eee');
    });

    it('re-acquires a live client for each attempt rather than pinning the first', async () => {
      writeBootId('boot-fff');
      const dead = makeClient(() => Promise.reject(new Error('bridge gone')));
      const live = makeClient();
      let n = 0;
      const getClient: PhoneHomeClientProvider = vi.fn(() => (n++ === 0 ? dead.client : live.client));

      await firePhoneHomeOverGrpc(getClient, makeConfig(), { gatePath, bootIdPath, retryDelaysMs: FAST_DELAYS });

      expect(dead.phoneHome).toHaveBeenCalledTimes(1);
      expect(live.phoneHome).toHaveBeenCalledTimes(1);
      expect((getClient as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it('gives up with a distinct terminal log after exhausting the ladder', async () => {
      writeBootId('boot-ggg');
      const failing = makeClient(() => Promise.reject(new Error('always down')));

      await firePhoneHomeOverGrpc(failing.provider, makeConfig(), { gatePath, bootIdPath, retryDelaysMs: FAST_DELAYS });

      expect(failing.phoneHome).toHaveBeenCalledTimes(FAST_DELAYS.length + 1);
      expect(existsSync(gatePath)).toBe(false);
      expect(loggedMessages().some((m) => m.includes('gave up after all retries'))).toBe(true);
    });

    it('a parked concurrent caller does not launch a duplicate attempt on the failure path', async () => {
      writeBootId('boot-hhh');
      let attempt = 0;
      const phoneHome = vi.fn((_req: PhoneHomeReq) => {
        attempt += 1;
        return attempt >= 2 ? Promise.resolve({}) : Promise.reject(new Error('transient'));
      });
      const client = { phoneHome } as unknown as AgentClient;

      const a = firePhoneHomeOverGrpc(() => client, makeConfig(), { gatePath, bootIdPath, retryDelaysMs: FAST_DELAYS });
      const b = firePhoneHomeOverGrpc(() => client, makeConfig(), { gatePath, bootIdPath, retryDelaysMs: FAST_DELAYS });
      await Promise.all([a, b]);

      expect(phoneHome).toHaveBeenCalledTimes(2);
    });
  });

  describe('cancelPhoneHomeRetry', () => {
    it('stops the ladder so no further attempts fire after cancel', async () => {
      writeBootId('boot-iii');
      const failing = makeClient(() => Promise.reject(new Error('down')));

      const p = firePhoneHomeOverGrpc(failing.provider, makeConfig(), {
        gatePath,
        bootIdPath,
        retryDelaysMs: [10_000, 10_000, 10_000],
      });
      await new Promise((r) => setTimeout(r, 20));
      expect(failing.phoneHome).toHaveBeenCalledTimes(1);

      cancelPhoneHomeRetry();
      await p;

      await new Promise((r) => setTimeout(r, 20));
      expect(failing.phoneHome).toHaveBeenCalledTimes(1);
    });
  });
});
