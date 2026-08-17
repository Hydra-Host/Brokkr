
import { describe, expect, it, vi } from 'vitest';

import { frameMessage } from '../tcp-framing.js';
import { type TcpConn, type TcpConnDeps, handleTcpConnection } from '../tcp-listener.js';

function silentLogger(): TcpConnDeps['logger'] {
  return { warn: vi.fn() };
}

function frame(payload: Buffer): Buffer {
  return frameMessage(payload);
}

class FakeTcpConn implements TcpConn {
  localAddress?: string;
  readonly writes: Buffer[] = [];
  destroyed = false;
  destroyCount = 0;

  private dataHandler: ((chunk: Buffer) => void) | null = null;
  private endHandler: (() => void) | null = null;
  private errorHandler: ((err: Error) => void) | null = null;
  private closeHandler: (() => void) | null = null;
  private timeoutHandler: (() => void) | null = null;
  timeoutListenerCount = 0;

  constructor(localAddress?: string) {
    this.localAddress = localAddress;
  }

  on(event: 'data', listener: (chunk: Buffer) => void): unknown;
  on(event: 'end', listener: () => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
  on(event: 'close', listener: () => void): unknown;
  on(event: 'timeout', listener: () => void): unknown;
  on(event: string, listener: (...args: never[]) => void): unknown {
    if (event === 'data') this.dataHandler = listener as (chunk: Buffer) => void;
    else if (event === 'end') this.endHandler = listener as () => void;
    else if (event === 'error') this.errorHandler = listener as (err: Error) => void;
    else if (event === 'close') this.closeHandler = listener as () => void;
    else if (event === 'timeout') {
      this.timeoutHandler = listener as () => void;
      this.timeoutListenerCount += 1;
    }
    return this;
  }

  write(buffer: Buffer): unknown {
    if (this.destroyed) throw new Error('write after destroy');
    this.writes.push(Buffer.from(buffer));
    return true;
  }

  destroy(): unknown {
    this.destroyCount += 1;
    this.destroyed = true;
    return this;
  }

  setTimeout(_ms: number, callback?: () => void): unknown {
    if (callback) this.on('timeout', callback);
    return this;
  }

  emitData(chunk: Buffer): void {
    this.dataHandler?.(chunk);
  }
  emitEnd(): void {
    this.endHandler?.();
  }
  emitError(err: Error): void {
    this.errorHandler?.(err);
  }
  emitClose(): void {
    this.closeHandler?.();
  }
  fireTimeout(): void {
    this.timeoutHandler?.();
  }
}

function makeDeps(overrides: Partial<TcpConnDeps> = {}): TcpConnDeps {
  return {
    resolve: async (query) => query,
    listenIp: '10.0.0.1',
    maxMessageBytes: 4096,
    idleTimeoutMs: 5000,
    maxQueriesPerConn: 100,
    logger: silentLogger(),
    jobId: 'job-test',
    ...overrides,
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 50; i++) {
    await Promise.resolve();
  }
}

describe('handleTcpConnection', () => {
  it('12: resolves a single query and writes one framed response', async () => {
    const conn = new FakeTcpConn();
    const query = Buffer.from('a-query');
    handleTcpConnection(conn, makeDeps({ resolve: async () => Buffer.from('reply') }));

    conn.emitData(frame(query));
    await flush();

    expect(conn.writes).toHaveLength(1);
    expect(conn.writes[0].equals(frame(Buffer.from('reply')))).toBe(true);
    expect(conn.destroyed).toBe(false);
  });

  it('13: resolves multiple queries sequentially, replies in order', async () => {
    const conn = new FakeTcpConn();
    handleTcpConnection(conn, makeDeps({ resolve: async (q) => Buffer.concat([Buffer.from('r:'), q]) }));

    conn.emitData(Buffer.concat([frame(Buffer.from('q1')), frame(Buffer.from('q2')), frame(Buffer.from('q3'))]));
    await flush();

    expect(conn.writes.map((w) => w.subarray(2).toString())).toEqual(['r:q1', 'r:q2', 'r:q3']);
  });

  it('14: preserves response order even when a later query resolves first', async () => {
    const conn = new FakeTcpConn();
    let call = 0;
    handleTcpConnection(
      conn,
      makeDeps({
        resolve: async (q) => {
          call += 1;
          const delay = call === 1 ? 30 : 0;
          await new Promise((r) => setTimeout(r, delay));
          return Buffer.concat([Buffer.from('r:'), q]);
        },
      }),
    );

    conn.emitData(Buffer.concat([frame(Buffer.from('slow')), frame(Buffer.from('fast'))]));
    await new Promise((r) => setTimeout(r, 60));
    await flush();

    expect(conn.writes.map((w) => w.subarray(2).toString())).toEqual(['r:slow', 'r:fast']);
  });

  it('15: reassembles a byte-by-byte query into a single response', async () => {
    const conn = new FakeTcpConn();
    handleTcpConnection(conn, makeDeps({ resolve: async () => Buffer.from('ok') }));

    const framed = frame(Buffer.from('drip-fed'));
    for (const byte of framed) {
      conn.emitData(Buffer.from([byte]));
    }
    await flush();

    expect(conn.writes).toHaveLength(1);
    expect(conn.writes[0].equals(frame(Buffer.from('ok')))).toBe(true);
    expect(conn.timeoutListenerCount).toBe(1);
  });

  it('15b: a valid frame followed by an oversized remainder head answers the query then destroys', async () => {
    const conn = new FakeTcpConn();
    const resolve = vi.fn(async () => Buffer.from('ok'));
    handleTcpConnection(conn, makeDeps({ maxMessageBytes: 8, resolve }));

    const oversizedHead = Buffer.alloc(2);
    oversizedHead.writeUInt16BE(9000, 0);
    conn.emitData(Buffer.concat([frame(Buffer.from('q')), oversizedHead]));
    await flush();

    expect(conn.writes).toHaveLength(1);
    expect(conn.destroyed).toBe(true);
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('16: an oversized message tears the connection down with no write', async () => {
    const conn = new FakeTcpConn();
    const resolve = vi.fn(async (q: Buffer) => q);
    handleTcpConnection(conn, makeDeps({ maxMessageBytes: 8, resolve }));

    conn.emitData(frame(Buffer.alloc(9)));
    await flush();

    expect(conn.writes).toHaveLength(0);
    expect(conn.destroyed).toBe(true);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('16b: a prefix declaring > maxMessageBytes is rejected on arrival, before the body buffers (DoS guard)', async () => {
    const conn = new FakeTcpConn();
    const resolve = vi.fn(async (q: Buffer) => q);
    handleTcpConnection(conn, makeDeps({ maxMessageBytes: 8, resolve }));

    const prefix = Buffer.alloc(2);
    prefix.writeUInt16BE(9000, 0);
    conn.emitData(Buffer.concat([prefix, Buffer.from([0x01, 0x02, 0x03])]));
    await flush();

    expect(conn.destroyed).toBe(true);
    expect(conn.writes).toHaveLength(0);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('17: a zero-length (declared-0) frame tears the connection down', async () => {
    const conn = new FakeTcpConn();
    const resolve = vi.fn(async (q: Buffer) => q);
    handleTcpConnection(conn, makeDeps({ resolve }));

    conn.emitData(Buffer.from([0x00, 0x00]));
    await flush();

    expect(conn.destroyed).toBe(true);
    expect(conn.writes).toHaveLength(0);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('18: a malformed query (resolve → null) closes the connection without a write', async () => {
    const conn = new FakeTcpConn();
    handleTcpConnection(conn, makeDeps({ resolve: async () => null }));

    conn.emitData(frame(Buffer.from('bad-query')));
    await flush();

    expect(conn.writes).toHaveLength(0);
    expect(conn.destroyed).toBe(true);
  });

  it('19: caps queries per connection, destroying once the limit is exceeded', async () => {
    const conn = new FakeTcpConn();
    handleTcpConnection(conn, makeDeps({ maxQueriesPerConn: 2, resolve: async (q) => q }));

    conn.emitData(Buffer.concat([frame(Buffer.from('q1')), frame(Buffer.from('q2')), frame(Buffer.from('q3'))]));
    await flush();

    expect(conn.writes).toHaveLength(2);
    expect(conn.destroyed).toBe(true);
  });

  it('20: an idle timeout destroys the connection', async () => {
    const conn = new FakeTcpConn();
    handleTcpConnection(conn, makeDeps());

    conn.fireTimeout();

    expect(conn.destroyed).toBe(true);
  });

  it('21: a client RST mid-resolve never writes to the destroyed socket, fires no throw', async () => {
    const conn = new FakeTcpConn();
    let release: (() => void) | null = null;
    handleTcpConnection(
      conn,
      makeDeps({
        resolve: async () => {
          await new Promise<void>((r) => {
            release = r;
          });
          return Buffer.from('late-reply');
        },
      }),
    );

    conn.emitData(frame(Buffer.from('q')));
    await flush();
    expect(() => conn.emitError(new Error('ECONNRESET'))).not.toThrow();
    expect(conn.destroyed).toBe(true);

    release?.();
    await flush();
    expect(conn.writes).toHaveLength(0);
  });

  it('22: a half-open end with a trailing partial flushes in-flight then destroys', async () => {
    const conn = new FakeTcpConn();
    handleTcpConnection(conn, makeDeps({ resolve: async (q) => Buffer.concat([Buffer.from('r:'), q]) }));

    const partial = Buffer.concat([Buffer.from([0x00, 0x09]), Buffer.from('abc')]);
    conn.emitData(Buffer.concat([frame(Buffer.from('q1')), partial]));
    await flush();
    expect(conn.writes.map((w) => w.subarray(2).toString())).toEqual(['r:q1']);

    conn.emitEnd();
    await flush();
    expect(conn.destroyed).toBe(true);
    expect(conn.writes).toHaveLength(1);
  });

  it('23: passes listenIp through to the resolver', async () => {
    const conn = new FakeTcpConn();
    const resolve = vi.fn(async (q: Buffer) => q);
    handleTcpConnection(conn, makeDeps({ listenIp: '172.16.9.9', resolve }));

    conn.emitData(frame(Buffer.from('q')));
    await flush();

    expect(resolve).toHaveBeenCalledWith(expect.any(Buffer), '172.16.9.9');
  });

  it('24: defer-site teardown is not raced by a subsequent data event (draining latch)', async () => {
    const conn = new FakeTcpConn();
    let release: (() => void) | null = null;
    const resolve = vi.fn(async () => {
      await new Promise<void>((r) => {
        release = r;
      });
      return Buffer.from('reply');
    });
    handleTcpConnection(conn, makeDeps({ maxMessageBytes: 8, resolve }));

    const oversizedHead = Buffer.alloc(2);
    oversizedHead.writeUInt16BE(9000, 0);
    conn.emitData(Buffer.concat([frame(Buffer.from('q')), oversizedHead]));
    await flush();
    expect(conn.destroyed).toBe(false);

    conn.emitData(frame(Buffer.from('q2')));
    await flush();

    release?.();
    await flush();

    expect(conn.writes).toHaveLength(1);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(conn.destroyCount).toBe(1);
    expect(conn.destroyed).toBe(true);
  });

  it('25: arrival-guard teardown is not raced by a subsequent data event (draining latch)', async () => {
    const conn = new FakeTcpConn();
    let release: (() => void) | null = null;
    const resolve = vi.fn(async () => {
      await new Promise<void>((r) => {
        release = r;
      });
      return Buffer.from('reply');
    });
    handleTcpConnection(conn, makeDeps({ maxMessageBytes: 8, resolve }));

    const oversizedHead = Buffer.alloc(2);
    oversizedHead.writeUInt16BE(9000, 0);
    conn.emitData(frame(Buffer.from('q1')));
    await flush();
    conn.emitData(oversizedHead);
    await flush();
    expect(conn.destroyed).toBe(false);

    conn.emitData(frame(Buffer.from('q2')));
    await flush();

    release?.();
    await flush();

    expect(conn.writes).toHaveLength(1);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(conn.destroyCount).toBe(1);
    expect(conn.destroyed).toBe(true);
  });
});
