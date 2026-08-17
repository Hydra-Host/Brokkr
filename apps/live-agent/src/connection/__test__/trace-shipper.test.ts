import { Code, ConnectError } from '@connectrpc/connect';
import { describe, expect, it, vi } from 'vitest';

import type { TransportPool } from '../pool';
import { createTraceSender } from '../trace-shipper';

interface MockClient {
  reportTraces: ReturnType<typeof vi.fn>;
}

function makePool(clients: Record<string, MockClient>): TransportPool {
  return {
    listAddresses: () => Object.keys(clients),
    getClient: (addr: string) => clients[addr]! as never,
  } as unknown as TransportPool;
}

const BYTES = new Uint8Array([1, 2, 3]);

describe('createTraceSender', () => {
  it('sends the batch with the device id to one bridge', async () => {
    const reportTraces = vi.fn().mockResolvedValue({});
    const sender = createTraceSender({ deviceId: 'dev-1', pool: makePool({ a: { reportTraces } }) });

    await sender(BYTES);

    expect(reportTraces).toHaveBeenCalledOnce();
    const batch = reportTraces.mock.calls[0]![0] as { deviceId: string; otlpTraces: Uint8Array };
    expect(batch.deviceId).toBe('dev-1');
    expect(batch.otlpTraces).toEqual(BYTES);
  });

  it('falls through to the next bridge on generic failure', async () => {
    const failing = vi.fn().mockRejectedValue(new ConnectError('down', Code.Unavailable));
    const healthy = vi.fn().mockResolvedValue({});
    const sender = createTraceSender({
      deviceId: 'dev-1',
      pool: makePool({ a: { reportTraces: failing }, b: { reportTraces: healthy } }),
    });

    await sender(BYTES);

    expect(failing.mock.calls.length + healthy.mock.calls.length).toBe(2);
    expect(healthy).toHaveBeenCalledOnce();
  });

  it('silently drops on RESOURCE_EXHAUSTED without trying other bridges', async () => {
    const exhausted = vi.fn().mockRejectedValue(new ConnectError('cap', Code.ResourceExhausted));
    const other = vi.fn().mockResolvedValue({});
    const sender = createTraceSender({
      deviceId: 'dev-1',
      pool: makePool({ a: { reportTraces: exhausted }, b: { reportTraces: other } }),
    });

    await expect(sender(BYTES)).resolves.toBeUndefined();
    expect(exhausted.mock.calls.length + other.mock.calls.length).toBe(1);
  });

  it('silently drops on UNIMPLEMENTED (old bridge during rollout skew)', async () => {
    const unimplemented = vi.fn().mockRejectedValue(new ConnectError('no such rpc', Code.Unimplemented));
    const sender = createTraceSender({ deviceId: 'dev-1', pool: makePool({ a: { reportTraces: unimplemented } }) });

    await expect(sender(BYTES)).resolves.toBeUndefined();
  });

  it('rejects when every bridge fails', async () => {
    const failing = vi.fn().mockRejectedValue(new ConnectError('down', Code.Unavailable));
    const sender = createTraceSender({
      deviceId: 'dev-1',
      pool: makePool({ a: { reportTraces: failing }, b: { reportTraces: failing } }),
    });

    await expect(sender(BYTES)).rejects.toThrow('down');
    expect(failing).toHaveBeenCalledTimes(2);
  });

  it('rejects when no bridges are configured', async () => {
    const sender = createTraceSender({ deviceId: 'dev-1', pool: makePool({}) });
    await expect(sender(BYTES)).rejects.toThrow('no bridge transports available');
  });
});
