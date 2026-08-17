import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Client } from '@connectrpc/connect';

import type { AgentService } from '../../gen/brokkr/agent/v1/agent_pb';
import { type BufferedEntry, setLevel, setLogSink } from '../../logger';
import { hashDeviceId } from '../hash';
import type { TransportPool } from '../pool';
import { TokenRenewer } from '../token-renewer';

type AgentServiceClient = Client<typeof AgentService>;

function makeFakePool(
  addresses: string[],
  renew: (address: string) => Promise<{ newExpiresInS: number }>,
): { pool: TransportPool; calls: string[] } {
  const calls: string[] = [];
  const pool: TransportPool = {
    listAddresses: () => [...addresses],
    removeBridge: () => {},
    getClient: (address: string) =>
      ({
        renewToken: () => {
          calls.push(address);
          return renew(address);
        },
      }) as unknown as AgentServiceClient,
  };
  return { pool, calls };
}

function renewOnce(r: TokenRenewer): Promise<void> {
  return (r as unknown as { renewOnce(): Promise<void> }).renewOnce();
}

describe('TokenRenewer', () => {
  let captured: BufferedEntry[];

  beforeEach(() => {
    captured = [];
    setLogSink((e) => captured.push(e));
    setLevel('debug');
    vi.useFakeTimers();
  });

  afterEach(() => {
    setLogSink(null);
    setLevel('info');
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('returns early on success at the first selected bridge (no failover)', async () => {
    const addresses = ['bridge-a:443', 'bridge-b:443', 'bridge-c:443'].sort();
    const deviceId = 'device-success';
    const expectedStart = addresses[hashDeviceId(deviceId) % addresses.length]!;
    const { pool, calls } = makeFakePool(addresses, async () => ({ newExpiresInS: 3600 }));

    const renewer = new TokenRenewer({ deviceId, pool, intervalMs: 1000 });
    await renewOnce(renewer);

    expect(calls).toEqual([expectedStart]);
    expect(captured.some((e) => e.log_level === 'debug' && e.message.includes('token renewed'))).toBe(true);
  });

  it('falls through to the next bridge on failure, honoring (startIdx + i) % length wraparound', async () => {
    const addresses = ['bridge-a:443', 'bridge-b:443', 'bridge-c:443'].sort();
    let deviceId = '';
    for (let n = 0; n < 10000; n++) {
      const candidate = `wrap-device-${n}`;
      if (hashDeviceId(candidate) % addresses.length === addresses.length - 1) {
        deviceId = candidate;
        break;
      }
    }
    expect(deviceId).not.toBe('');

    const startIdx = hashDeviceId(deviceId) % addresses.length;
    expect(startIdx).toBe(addresses.length - 1);
    const firstAddr = addresses[startIdx]!;
    const wrappedAddr = addresses[(startIdx + 1) % addresses.length]!;

    const { pool, calls } = makeFakePool(addresses, async (address) => {
      if (address === firstAddr) throw new Error('first bridge down');
      return { newExpiresInS: 3600 };
    });

    const renewer = new TokenRenewer({ deviceId, pool, intervalMs: 1000 });
    await renewOnce(renewer);

    expect(calls).toEqual([firstAddr, wrappedAddr]);
    expect(
      captured.some((e) => e.log_level === 'warn' && e.message.includes('token renew failed on bridge, trying next')),
    ).toBe(true);
  });

  it('logs the aggregate warn when every bridge fails', async () => {
    const addresses = ['bridge-a:443', 'bridge-b:443'].sort();
    const { pool, calls } = makeFakePool(addresses, async () => {
      throw new Error('bridge down');
    });

    const renewer = new TokenRenewer({ deviceId: 'all-fail-device', pool, intervalMs: 1000 });
    await renewOnce(renewer);

    expect(calls).toHaveLength(addresses.length);
    const aggregate = captured.find(
      (e) => e.log_level === 'warn' && e.message.includes('token renew failed on every bridge'),
    );
    expect(aggregate).toBeDefined();
    expect(aggregate!.message).toContain(`attempted=${addresses.length}`);
  });

  it('is a no-op (debug) when the pool has no live sessions', async () => {
    const { pool, calls } = makeFakePool([], async () => ({ newExpiresInS: 3600 }));

    const renewer = new TokenRenewer({ deviceId: 'empty-device', pool, intervalMs: 1000 });
    await renewOnce(renewer);

    expect(calls).toEqual([]);
    expect(
      captured.some(
        (e) => e.log_level === 'debug' && e.message.includes('token renew skipped: pool has no live sessions'),
      ),
    ).toBe(true);
  });

  it('stop() prevents any further scheduled ticks', async () => {
    const { pool, calls } = makeFakePool(['bridge-a:443'], async () => ({ newExpiresInS: 3600 }));
    const renewer = new TokenRenewer({ deviceId: 'stop-device', pool, intervalMs: 1000 });

    renewer.start();
    renewer.stop();

    await vi.advanceTimersByTimeAsync(5000);
    expect(calls).toEqual([]);
  });

  it('reschedules even when renewOnce throws', async () => {
    let ticks = 0;
    const { pool } = makeFakePool(['bridge-a:443'], async () => ({ newExpiresInS: 3600 }));
    const renewer = new TokenRenewer({ deviceId: 'throw-device', pool, intervalMs: 1000 });

    vi.spyOn(renewer as unknown as { renewOnce(): Promise<void> }, 'renewOnce').mockImplementation(async () => {
      ticks++;
      throw new Error('tick blew up');
    });

    renewer.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(ticks).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(ticks).toBe(2);

    renewer.stop();
    expect(captured.some((e) => e.log_level === 'warn' && e.message.includes('token renew tick threw'))).toBe(true);
  });
});
