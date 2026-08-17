import { Code, ConnectError } from '@connectrpc/connect';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLogSink, type BufferedEntry } from '../../logger';
import { LogShipper } from '../log-shipper';
import type { TransportPool } from '../pool';

function makeEntry(i: number): BufferedEntry {
  return {
    timestamp: new Date(2026, 4, 31, 12, 0, 0, i % 1000).toISOString(),
    app_class_name: 'test',
    job_id: '',
    work_id: '',
    log_level: 'info',
    message: `entry-${i}`,
  } as BufferedEntry;
}

interface MockClient {
  reportLogs: ReturnType<typeof vi.fn>;
}

function makePool(clients: Record<string, MockClient>): TransportPool {
  return {
    listAddresses: () => Object.keys(clients).sort(),
    getClient: (addr: string) => clients[addr]! as never,
  } as unknown as TransportPool;
}

async function flushOnce(shipper: LogShipper): Promise<void> {
  await shipper['flush']();
}

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  vi.restoreAllMocks();
  setLogSink(null);
});

describe('LogShipper chunking', () => {
  it('splits a >CHUNK_SIZE buffer into multiple chunked RPCs', async () => {
    const reportLogs = vi.fn().mockResolvedValue({});
    const pool = makePool({ a: { reportLogs } });
    const shipper = new LogShipper({ deviceId: 'd', pool, maxBufferSize: 5000 });
    shipper.start();

    for (let i = 0; i < 2500; i++) {
      shipper['push'](makeEntry(i));
    }

    await flushOnce(shipper);

    expect(reportLogs).toHaveBeenCalledTimes(3);
    const entriesPerCall = reportLogs.mock.calls.map((c) => (c[0] as { entries: unknown[] }).entries.length);
    expect(entriesPerCall).toEqual([900, 900, 700]);

    shipper.stop();
  });

  it('drops a chunk on RESOURCE_EXHAUSTED instead of looping forever', async () => {
    const reportLogs = vi.fn().mockImplementation((batch: { entries: unknown[] }) => {
      if (batch.entries.length > 500) {
        return Promise.reject(new ConnectError('too big', Code.ResourceExhausted));
      }
      return Promise.resolve({});
    });
    const pool = makePool({ a: { reportLogs } });
    const shipper = new LogShipper({ deviceId: 'd', pool, maxBufferSize: 5000 });
    shipper.start();

    for (let i = 0; i < 1500; i++) {
      shipper['push'](makeEntry(i));
    }

    await flushOnce(shipper);

    expect(reportLogs).toHaveBeenCalled();
    expect(shipper['liveCount']).toBe(0);

    shipper.stop();
  });

  it('retains chunks for next flush on transient (non-RESOURCE_EXHAUSTED) error', async () => {
    const reportLogs = vi
      .fn()
      .mockRejectedValueOnce(new ConnectError('outage', Code.Unavailable))
      .mockResolvedValue({});
    const pool = makePool({ a: { reportLogs } });
    const shipper = new LogShipper({ deviceId: 'd', pool, maxBufferSize: 5000 });
    shipper.start();

    for (let i = 0; i < 600; i++) {
      shipper['push'](makeEntry(i));
    }

    await flushOnce(shipper);

    expect(shipper['liveCount']).toBe(600);

    await flushOnce(shipper);
    expect(shipper['liveCount']).toBe(0);

    shipper.stop();
  });

  it('retains droppedSinceLastFlush when the drop-warning chunk is RESOURCE_EXHAUSTED', async () => {
    const reportLogs = vi.fn().mockRejectedValue(new ConnectError('too big', Code.ResourceExhausted));
    const pool = makePool({ a: { reportLogs } });
    const shipper = new LogShipper({ deviceId: 'd', pool, maxBufferSize: 100 });
    shipper.start();

    for (let i = 0; i < 250; i++) {
      shipper['push'](makeEntry(i));
    }
    const dropsBeforeFlush = shipper['droppedSinceLastFlush'];
    expect(dropsBeforeFlush).toBeGreaterThan(0);

    await flushOnce(shipper);

    expect(shipper['liveCount']).toBe(0);
    expect(shipper['droppedSinceLastFlush']).toBeGreaterThanOrEqual(dropsBeforeFlush);

    shipper.stop();
  });

  it('partial flush with evictions does not inflate droppedSinceLastFlush by the shipped portion', async () => {
    let calls = 0;
    const reportLogs = vi.fn().mockImplementation(() => {
      calls += 1;
      if (calls === 1) return Promise.resolve({});
      return Promise.reject(new ConnectError('outage', Code.Unavailable));
    });
    const pool = makePool({ a: { reportLogs } });
    const shipper = new LogShipper({ deviceId: 'd', pool, maxBufferSize: 5000 });
    shipper.start();

    for (let i = 0; i < 1500; i++) {
      shipper['push'](makeEntry(i));
    }
    shipper['evictionsDuringFlush'] = 500;

    const dropsBefore = shipper['droppedSinceLastFlush'];
    await flushOnce(shipper);

    expect(shipper['droppedSinceLastFlush']).toBe(dropsBefore);

    shipper.stop();
  });

  it('RE drops go to reDropsSinceLastFlush, not droppedSinceLastFlush', async () => {
    const reportLogs = vi.fn().mockRejectedValue(new ConnectError('too big', Code.ResourceExhausted));
    const pool = makePool({ a: { reportLogs } });
    const shipper = new LogShipper({ deviceId: 'd', pool, maxBufferSize: 5000 });
    shipper.start();

    for (let i = 0; i < 600; i++) {
      shipper['push'](makeEntry(i));
    }
    expect(shipper['droppedSinceLastFlush']).toBe(0);
    expect(shipper['reDropsSinceLastFlush']).toBe(0);

    await flushOnce(shipper);

    expect(shipper['droppedSinceLastFlush']).toBe(0);
    expect(shipper['reDropsSinceLastFlush']).toBe(600);

    shipper.stop();
  });

  it('drop-warning message attributes overflow vs RE separately', async () => {
    const reportLogs = vi.fn().mockResolvedValue({});
    const pool = makePool({ a: { reportLogs } });
    const shipper = new LogShipper({ deviceId: 'd', pool, maxBufferSize: 5000 });
    shipper.start();
    shipper['droppedSinceLastFlush'] = 42;
    shipper['reDropsSinceLastFlush'] = 17;
    for (let i = 0; i < 10; i++) {
      shipper['push'](makeEntry(i));
    }
    await flushOnce(shipper);

    const call = reportLogs.mock.calls[0]?.[0] as { entries: { message: string }[] };
    const warning = call.entries.find((e) => e.message.includes('log-shipper dropped'));
    expect(warning?.message).toMatch(/59 entries/);
    expect(warning?.message).toMatch(/42 from buffer overflow/);
    expect(warning?.message).toMatch(/17 from ReportLogs RESOURCE_EXHAUSTED/);

    expect(shipper['droppedSinceLastFlush']).toBe(0);
    expect(shipper['reDropsSinceLastFlush']).toBe(0);

    shipper.stop();
  });

  it('partial flush with head-advanced unshipped rows counts them as drops', async () => {
    let call = 0;
    const reportLogs = vi.fn().mockImplementation(() => {
      call += 1;
      if (call === 1) return Promise.resolve({});
      return Promise.reject(new ConnectError('outage', Code.Unavailable));
    });
    const pool = makePool({ a: { reportLogs } });
    const shipper = new LogShipper({ deviceId: 'd', pool, maxBufferSize: 5000 });
    shipper.start();

    for (let i = 0; i < 1800; i++) shipper['push'](makeEntry(i));
    const dropsBefore = shipper['droppedSinceLastFlush'];

    shipper['evictionsDuringFlush'] = 950;

    await flushOnce(shipper);

    expect(shipper['droppedSinceLastFlush']).toBe(dropsBefore + 50);
  });

  it('partial flush with evictions < shipped.length counts zero drops (FIFO invariant)', async () => {
    let call = 0;
    const reportLogs = vi.fn().mockImplementation(() => {
      call += 1;
      if (call <= 2) return Promise.resolve({});
      return Promise.reject(new ConnectError('outage', Code.Unavailable));
    });
    const pool = makePool({ a: { reportLogs } });
    const shipper = new LogShipper({ deviceId: 'd', pool, maxBufferSize: 5000 });
    shipper.start();
    for (let i = 0; i < 2700; i++) shipper['push'](makeEntry(i));
    const dropsBefore = shipper['droppedSinceLastFlush'];

    shipper['evictionsDuringFlush'] = 100;
    await flushOnce(shipper);

    expect(shipper['droppedSinceLastFlush']).toBe(dropsBefore);
  });

  it('flushes a drop-warning even when the buffer is empty', async () => {
    const reportLogs = vi.fn().mockResolvedValue({});
    const pool = makePool({ a: { reportLogs } });
    const shipper = new LogShipper({ deviceId: 'd', pool, maxBufferSize: 5000 });
    shipper.start();

    shipper['droppedSinceLastFlush'] = 11;
    shipper['reDropsSinceLastFlush'] = 7;
    expect(shipper['liveCount']).toBe(0);

    await flushOnce(shipper);

    expect(reportLogs).toHaveBeenCalledTimes(1);
    const call = reportLogs.mock.calls[0]?.[0] as { entries: { message: string }[] };
    expect(call.entries.length).toBe(1);
    expect(call.entries[0]?.message).toMatch(/18 entries/);
    expect(call.entries[0]?.message).toMatch(/11 from buffer overflow/);
    expect(call.entries[0]?.message).toMatch(/7 from ReportLogs RESOURCE_EXHAUSTED/);

    expect(shipper['droppedSinceLastFlush']).toBe(0);
    expect(shipper['reDropsSinceLastFlush']).toBe(0);

    shipper.stop();
  });

  it('does not livelock when warning-only flush is RESOURCE_EXHAUSTED', async () => {
    const reportLogs = vi.fn().mockRejectedValue(new ConnectError('cap=0', Code.ResourceExhausted));
    const pool = makePool({ a: { reportLogs } });
    const shipper = new LogShipper({ deviceId: 'd', pool, maxBufferSize: 5000 });
    shipper.start();
    shipper['droppedSinceLastFlush'] = 11;
    shipper['reDropsSinceLastFlush'] = 7;

    await flushOnce(shipper);

    expect(reportLogs).toHaveBeenCalledTimes(1);
    expect(shipper['droppedSinceLastFlush']).toBe(0);
    expect(shipper['reDropsSinceLastFlush']).toBe(0);

    await flushOnce(shipper);
    expect(reportLogs).toHaveBeenCalledTimes(1);

    shipper.stop();
  });

  it('does nothing when liveCount=0 and drop counters are also 0', async () => {
    const reportLogs = vi.fn().mockResolvedValue({});
    const pool = makePool({ a: { reportLogs } });
    const shipper = new LogShipper({ deviceId: 'd', pool, maxBufferSize: 5000 });
    shipper.start();
    await flushOnce(shipper);
    expect(reportLogs).not.toHaveBeenCalled();
    shipper.stop();
  });

  it('handles a buffer exactly at CHUNK_SIZE (single full chunk)', async () => {
    const reportLogs = vi.fn().mockResolvedValue({});
    const pool = makePool({ a: { reportLogs } });
    const shipper = new LogShipper({ deviceId: 'd', pool });
    shipper.start();
    for (let i = 0; i < 900; i++) {
      shipper['push'](makeEntry(i));
    }
    await flushOnce(shipper);
    expect(reportLogs).toHaveBeenCalledTimes(1);
    const call = reportLogs.mock.calls[0]?.[0] as { entries: unknown[] };
    expect(call.entries.length).toBe(900);
    shipper.stop();
  });
});
