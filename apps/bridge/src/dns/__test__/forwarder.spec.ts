import * as dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ForwardError,
  type ForwardOptions,
  type ForwardSocket,
  type ForwardTcpSocket,
  type UpstreamAffinity,
  forwardQuery as forwardQueryRaw,
  forwardQueryTcp as forwardQueryTcpRaw,
} from '../forwarder.js';
import { frameMessage } from '../tcp-framing.js';

type ForwardTestOptions = Omit<ForwardOptions, 'affinity'> & { affinity?: UpstreamAffinity };

function forwardQuery(query: Buffer, opts: ForwardTestOptions): Promise<Buffer> {
  return forwardQueryRaw(query, { ...opts, affinity: opts.affinity ?? { udp: -1, tcp: -1 } });
}

function forwardQueryTcp(query: Buffer, opts: ForwardTestOptions): Promise<Buffer> {
  return forwardQueryTcpRaw(query, { ...opts, affinity: opts.affinity ?? { udp: -1, tcp: -1 } });
}

const FAKE_QUERY = Buffer.from('dead0100000100000000000003666f6f0000010001', 'hex');
const FAKE_RESPONSE = Buffer.from('dead8580000100010000000003666f6f0000010001c00c000100010000000100040a000001', 'hex');

interface MockUpstream {
  socket: dgram.Socket;
  port: number;
  received: Buffer[];
}

const openSockets: dgram.Socket[] = [];

function spawnUpstream(response: Buffer | null, delayMs = 0): Promise<MockUpstream> {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    openSockets.push(socket);
    const received: Buffer[] = [];

    socket.on('error', reject);

    socket.on('message', (msg, rinfo) => {
      received.push(msg);
      if (response === null) {
        return;
      }
      const send = (): void => {
        socket.send(response, rinfo.port, rinfo.address);
      };
      if (delayMs > 0) {
        setTimeout(send, delayMs);
      } else {
        send();
      }
    });

    socket.bind(0, '127.0.0.1', () => {
      const address = socket.address();
      resolve({ socket, port: address.port, received });
    });
  });
}

afterEach(() => {
  for (const socket of openSockets.splice(0)) {
    try {
      socket.close();
    } catch (error) {
      void error;
    }
  }
});

describe('forwardQuery (real loopback)', () => {
  it('returns a valid upstream response verbatim', async () => {
    const upstream = await spawnUpstream(FAKE_RESPONSE);
    const response = await forwardQuery(FAKE_QUERY, {
      upstreams: ['127.0.0.1'],
      port: upstream.port,
      timeoutMs: 1000,
    });
    expect(response.equals(FAKE_RESPONSE)).toBe(true);
    expect(upstream.received).toHaveLength(1);
    expect(upstream.received[0].equals(FAKE_QUERY)).toBe(true);
  });

  it('falls through to the second upstream when the first times out', async () => {
    const ok = await spawnUpstream(FAKE_RESPONSE);

    const response = await forwardQuery(FAKE_QUERY, {
      upstreams: ['127.0.0.2', '127.0.0.1'],
      port: ok.port,
      timeoutMs: 200,
    });

    expect(response.equals(FAKE_RESPONSE)).toBe(true);
    expect(ok.received).toHaveLength(1);
    expect(ok.received[0].equals(FAKE_QUERY)).toBe(true);
  });

  it('throws ForwardError when all upstreams fail', async () => {
    const silent = await spawnUpstream(null);

    await expect(
      forwardQuery(FAKE_QUERY, {
        upstreams: ['127.0.0.1'],
        port: silent.port,
        timeoutMs: 80,
      }),
    ).rejects.toThrow(ForwardError);

    expect(silent.received).toHaveLength(1);
    expect(silent.received[0].equals(FAKE_QUERY)).toBe(true);
  });

  it('worst-case latency is bounded by upstream count × timeout', async () => {
    const silent = await spawnUpstream(null);

    const start = Date.now();
    await expect(
      forwardQuery(FAKE_QUERY, {
        upstreams: ['127.0.0.1', '127.0.0.1'],
        port: silent.port,
        timeoutMs: 80,
      }),
    ).rejects.toThrow(ForwardError);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeGreaterThan(120);
    expect(elapsed).toBeLessThan(500);
  });

  it('is byte-transparent for a valid reply — returns its bytes unchanged', async () => {
    const upstream = await spawnUpstream(FAKE_RESPONSE);
    const response = await forwardQuery(FAKE_QUERY, {
      upstreams: ['127.0.0.1'],
      port: upstream.port,
      timeoutMs: 1000,
    });
    expect(response.equals(FAKE_RESPONSE)).toBe(true);
  });

  it('drops a garbage datagram that fails validation (the adapted boss byte-transparency case) → ForwardError', async () => {
    const garbage = Buffer.alloc(32, 0);
    const upstream = await spawnUpstream(garbage);

    await expect(
      forwardQuery(FAKE_QUERY, {
        upstreams: ['127.0.0.1'],
        port: upstream.port,
        timeoutMs: 80,
      }),
    ).rejects.toThrow(ForwardError);
    expect(upstream.received).toHaveLength(1);
  });
});

class FakeSocket extends EventEmitter {
  closed = false;

  constructor(private readonly onSend: (sock: FakeSocket, dest: string) => void) {
    super();
  }

  send(_msg: Buffer, _port: number, address: string, cb?: (err?: Error | null) => void): void {
    cb?.();
    queueMicrotask(() => {
      if (!this.closed) {
        this.onSend(this, address);
      }
    });
  }

  close(): void {
    this.closed = true;
  }

  emitMessage(msg: Buffer, address: string, port = 53): void {
    if (!this.closed) {
      this.emit('message', msg, { address, port, family: 'IPv4', size: msg.length });
    }
  }
}

function buildQuery(qname: string, txnId: number): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(txnId, 0);
  header.writeUInt16BE(0x0100, 2);
  header.writeUInt16BE(1, 4);
  const labels: Buffer[] = [];
  for (const part of qname.split('.')) {
    labels.push(Buffer.from([part.length]), Buffer.from(part, 'ascii'));
  }
  labels.push(Buffer.from([0]));
  const tail = Buffer.alloc(4);
  tail.writeUInt16BE(1, 0);
  tail.writeUInt16BE(1, 2);
  return Buffer.concat([header, ...labels, tail]);
}

function replyFor(query: Buffer, opts: { txnId?: number; upperCaseName?: boolean } = {}): Buffer {
  const reply = Buffer.from(query);
  reply.writeUInt16BE(opts.txnId ?? query.readUInt16BE(0), 0);
  reply.writeUInt16BE(0x8180, 2);
  if (opts.upperCaseName) {
    for (let i = 12; i < reply.length - 4; i++) {
      if (reply[i] >= 0x61 && reply[i] <= 0x7a) {
        reply[i] -= 0x20;
      }
    }
  }
  return reply;
}

describe('forwardQuery (reply validation)', () => {
  it('accepts a reply matching source, txn-id, QR, and question', async () => {
    const query = buildQuery('example.com', 0x1234);
    const reply = replyFor(query);

    const opts: ForwardTestOptions = {
      upstreams: ['9.9.9.9'],
      timeoutMs: 100,
      createSocket: () => new FakeSocket((sock, dest) => sock.emitMessage(reply, dest)),
    };

    const out = await forwardQuery(query, opts);
    expect(out.equals(reply)).toBe(true);
  });

  it('accepts a reply whose question differs only in label case', async () => {
    const query = buildQuery('example.com', 0x1234);
    const reply = replyFor(query, { upperCaseName: true });

    const out = await forwardQuery(query, {
      upstreams: ['9.9.9.9'],
      timeoutMs: 100,
      createSocket: () => new FakeSocket((sock, dest) => sock.emitMessage(reply, dest)),
    });
    expect(out.equals(reply)).toBe(true);
  });

  it('rejects a datagram from the wrong source, then returns the real reply', async () => {
    const query = buildQuery('example.com', 0x1234);
    const spoof = replyFor(query);
    const real = replyFor(query);
    real.writeUInt16BE(1, 6);

    const out = await forwardQuery(query, {
      upstreams: ['9.9.9.9'],
      timeoutMs: 200,
      createSocket: () =>
        new FakeSocket((sock) => {
          sock.emitMessage(spoof, '6.6.6.6');
          sock.emitMessage(real, '9.9.9.9');
        }),
    });

    expect(out.equals(real)).toBe(true);
  });

  it('rejects a datagram from the wrong source port, then returns the real reply', async () => {
    const query = buildQuery('example.com', 0x1234);
    const spoof = replyFor(query);
    const real = replyFor(query);
    real.writeUInt16BE(1, 6);

    const out = await forwardQuery(query, {
      upstreams: ['9.9.9.9'],
      timeoutMs: 200,
      createSocket: () =>
        new FakeSocket((sock) => {
          sock.emitMessage(spoof, '9.9.9.9', 5353);
          sock.emitMessage(real, '9.9.9.9', 53);
        }),
    });

    expect(out.equals(real)).toBe(true);
  });

  it('rejects a datagram with the wrong txn-id, then returns the real reply', async () => {
    const query = buildQuery('example.com', 0x1234);
    const spoof = replyFor(query, { txnId: 0x9999 });
    const real = replyFor(query);

    const out = await forwardQuery(query, {
      upstreams: ['9.9.9.9'],
      timeoutMs: 200,
      createSocket: () =>
        new FakeSocket((sock, dest) => {
          sock.emitMessage(spoof, dest);
          sock.emitMessage(real, dest);
        }),
    });

    expect(out.readUInt16BE(0)).toBe(0x1234);
    expect(out.equals(real)).toBe(true);
  });

  it('rejects a datagram with a mismatched question, then returns the real reply', async () => {
    const query = buildQuery('example.com', 0x1234);
    const spoof = replyFor(buildQuery('evil.com', 0x1234));
    const real = replyFor(query);

    const out = await forwardQuery(query, {
      upstreams: ['9.9.9.9'],
      timeoutMs: 200,
      createSocket: () =>
        new FakeSocket((sock, dest) => {
          sock.emitMessage(spoof, dest);
          sock.emitMessage(real, dest);
        }),
    });

    expect(out.equals(real)).toBe(true);
  });

  it('D18: rejects a reply whose qtype differs only by a case-foldable byte, then returns the real reply', async () => {
    const query = buildQuery('example.com', 0x1234);
    query.writeUInt16BE(0x4141, query.length - 4);

    const spoof = replyFor(query);
    spoof.writeUInt16BE(0x6161, spoof.length - 4);
    const real = replyFor(query);

    const out = await forwardQuery(query, {
      upstreams: ['9.9.9.9'],
      timeoutMs: 200,
      createSocket: () =>
        new FakeSocket((sock, dest) => {
          sock.emitMessage(spoof, dest);
          sock.emitMessage(real, dest);
        }),
    });
    expect(out.equals(real)).toBe(true);
  });

  it('D18: accepts an exact qtype/qclass match with a mixed-case qname', async () => {
    const query = buildQuery('example.com', 0x1234);
    const reply = replyFor(query, { upperCaseName: true });

    const out = await forwardQuery(query, {
      upstreams: ['9.9.9.9'],
      timeoutMs: 100,
      createSocket: () => new FakeSocket((sock, dest) => sock.emitMessage(reply, dest)),
    });
    expect(out.equals(reply)).toBe(true);
  });

  it('rejects a datagram without the QR bit set', async () => {
    const query = buildQuery('example.com', 0x1234);
    const notAResponse = Buffer.from(query);
    const real = replyFor(query);

    const out = await forwardQuery(query, {
      upstreams: ['9.9.9.9'],
      timeoutMs: 200,
      createSocket: () =>
        new FakeSocket((sock, dest) => {
          sock.emitMessage(notAResponse, dest);
          sock.emitMessage(real, dest);
        }),
    });
    expect(out.equals(real)).toBe(true);
  });

  it('rejects a reply whose qdcount != 1, then returns the real reply', async () => {
    const query = buildQuery('example.com', 0x1234);
    const spoof = replyFor(query);
    spoof.writeUInt16BE(2, 4);
    const real = replyFor(query);
    real.writeUInt16BE(1, 6);

    const out = await forwardQuery(query, {
      upstreams: ['9.9.9.9'],
      timeoutMs: 200,
      createSocket: () =>
        new FakeSocket((sock, dest) => {
          sock.emitMessage(spoof, dest);
          sock.emitMessage(real, dest);
        }),
    });
    expect(out.equals(real)).toBe(true);
  });

  it('rejects a too-short datagram (< 12 bytes), then returns the real reply', async () => {
    const query = buildQuery('example.com', 0x1234);
    const real = replyFor(query);

    const out = await forwardQuery(query, {
      upstreams: ['9.9.9.9'],
      timeoutMs: 200,
      createSocket: () =>
        new FakeSocket((sock, dest) => {
          sock.emitMessage(Buffer.alloc(4), dest);
          sock.emitMessage(real, dest);
        }),
    });
    expect(out.equals(real)).toBe(true);
  });

  it('times out (no genuine reply) when every datagram mismatches → ForwardError', async () => {
    vi.useFakeTimers();
    try {
      const query = buildQuery('example.com', 0x1234);
      const spoof = replyFor(query, { txnId: 0x9999 });

      const sockets: FakeSocket[] = [];
      const promise = forwardQuery(query, {
        upstreams: ['9.9.9.9'],
        timeoutMs: 50,
        createSocket: () => {
          const sock = new FakeSocket((s, dest) => s.emitMessage(spoof, dest));
          sockets.push(sock);
          return sock;
        },
      });
      const assertion = expect(promise).rejects.toThrow(ForwardError);
      await vi.advanceTimersByTimeAsync(60);
      await assertion;
      expect(sockets.every((s) => s.closed)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('sends only to the single upstream passed in opts.upstreams', async () => {
    const query = buildQuery('corp.example', 0x1234);
    const reply = replyFor(query);
    const dialed: string[] = [];
    const out = await forwardQuery(query, {
      upstreams: ['10.0.0.53'],
      timeoutMs: 100,
      createSocket: () =>
        new FakeSocket((sock, dest) => {
          dialed.push(dest);
          sock.emitMessage(reply, dest);
        }),
    });
    expect(out.equals(reply)).toBe(true);
    expect(dialed).toEqual(['10.0.0.53']);
  });
});

describe('forwardQuery (last-good upstream)', () => {
  it('prefers the last upstream that answered on the next query', async () => {
    const query = buildQuery('example.com', 0x1234);
    const reply = replyFor(query);
    const upstreams = ['1.1.1.1', '2.2.2.2', '3.3.3.3'];
    const sentOrders: string[][] = [];

    const makeSocket = (): ForwardSocket => {
      const attempt: string[] = [];
      sentOrders.push(attempt);
      return new FakeSocket((sock, dest) => {
        attempt.push(dest);
        if (dest === '3.3.3.3') {
          sock.emitMessage(reply, dest);
        }
      });
    };

    const affinity: UpstreamAffinity = { udp: -1, tcp: -1 };
    const opts: ForwardTestOptions = { upstreams, timeoutMs: 30, createSocket: makeSocket, affinity };

    const first = await forwardQuery(query, opts);
    expect(first.equals(reply)).toBe(true);

    const before = sentOrders.length;
    const second = await forwardQuery(query, opts);
    expect(second.equals(reply)).toBe(true);
    expect(sentOrders[before][0]).toBe('3.3.3.3');
  });

  it('a fresh affinity restores declared order (last-good is per-affinity, not global)', async () => {
    const query = buildQuery('example.com', 0x1234);
    const reply = replyFor(query);
    const upstreams = ['1.1.1.1', '2.2.2.2'];
    const sentOrders: string[][] = [];

    const makeSocket = (): ForwardSocket => {
      const attempt: string[] = [];
      sentOrders.push(attempt);
      return new FakeSocket((sock, dest) => {
        attempt.push(dest);
        if (dest === '2.2.2.2') {
          sock.emitMessage(reply, dest);
        }
      });
    };

    const affinity: UpstreamAffinity = { udp: -1, tcp: -1 };
    await forwardQuery(query, { upstreams, timeoutMs: 30, createSocket: makeSocket, affinity });

    const before = sentOrders.length;
    await forwardQuery(query, { upstreams, timeoutMs: 30, createSocket: makeSocket, affinity: { udp: -1, tcp: -1 } });
    expect(sentOrders[before][0]).toBe('1.1.1.1');
  });

  it('a per-call affinity does not bias a later query that uses a different affinity', async () => {
    const query = buildQuery('example.com', 0x1234);
    const reply = replyFor(query);
    const upstreams = ['1.1.1.1', '9.9.9.9'];
    const a: UpstreamAffinity = { udp: -1, tcp: -1 };

    await forwardQuery(query, {
      upstreams,
      timeoutMs: 30,
      affinity: a,
      createSocket: () =>
        new FakeSocket((sock, dest) => {
          if (dest === '9.9.9.9') sock.emitMessage(reply, dest);
        }),
    });
    expect(a.udp).not.toBe(-1);

    const otherDialed: string[] = [];
    await forwardQuery(query, {
      upstreams,
      timeoutMs: 30,
      affinity: { udp: -1, tcp: -1 },
      createSocket: () =>
        new FakeSocket((sock, dest) => {
          otherDialed.push(dest);
          sock.emitMessage(reply, dest);
        }),
    });
    expect(otherDialed[0]).toBe('1.1.1.1');
  });
});

class FakeTcpSocket implements ForwardTcpSocket {
  connectedTo: string | null = null;
  readonly writes: Buffer[] = [];
  destroyed = false;
  private dataHandler: ((chunk: Buffer) => void) | null = null;
  private errorHandler: ((err: Error) => void) | null = null;
  private closeHandler: (() => void) | null = null;
  private timeoutCallback: (() => void) | null = null;

  constructor(private readonly onConnect: (sock: FakeTcpSocket, host: string) => void) {}

  on(event: 'data', listener: (chunk: Buffer) => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
  on(event: 'close', listener: () => void): unknown;
  on(event: string, listener: (...args: never[]) => void): unknown {
    if (event === 'data') this.dataHandler = listener as (chunk: Buffer) => void;
    else if (event === 'error') this.errorHandler = listener as (err: Error) => void;
    else if (event === 'close') this.closeHandler = listener as () => void;
    return this;
  }

  connect(_port: number, host: string, callback: () => void): unknown {
    this.connectedTo = host;
    callback();
    queueMicrotask(() => {
      if (!this.destroyed) this.onConnect(this, host);
    });
    return this;
  }

  write(buffer: Buffer): unknown {
    this.writes.push(Buffer.from(buffer));
    return true;
  }

  destroy(): unknown {
    this.destroyed = true;
    return this;
  }

  setTimeout(_ms: number, callback: () => void): unknown {
    this.timeoutCallback = callback;
    return this;
  }

  emitData(chunk: Buffer): void {
    if (!this.destroyed) this.dataHandler?.(chunk);
  }
  emitError(err: Error): void {
    if (!this.destroyed) this.errorHandler?.(err);
  }
  emitClose(): void {
    if (!this.destroyed) this.closeHandler?.();
  }
  fireTimeout(): void {
    this.timeoutCallback?.();
  }
}

describe('forwardQueryTcp', () => {
  it('37: connects, writes the framed query, and resolves the length-stripped reply', async () => {
    const query = buildQuery('example.com', 0x1234);
    const reply = replyFor(query);
    let captured: FakeTcpSocket | null = null;

    const out = await forwardQueryTcp(query, {
      upstreams: ['9.9.9.9'],
      timeoutMs: 100,
      createTcpSocket: () =>
        new FakeTcpSocket((sock) => {
          captured = sock;
          sock.emitData(frameMessage(reply));
        }),
    });

    expect(out.equals(reply)).toBe(true);
    expect(captured!.connectedTo).toBe('9.9.9.9');
    expect(captured!.writes).toHaveLength(1);
    expect(captured!.writes[0].equals(frameMessage(query))).toBe(true);
  });

  it('38: reassembles a reply delivered across two chunks', async () => {
    const query = buildQuery('example.com', 0x1234);
    const reply = replyFor(query);
    const framed = frameMessage(reply);

    const out = await forwardQueryTcp(query, {
      upstreams: ['9.9.9.9'],
      timeoutMs: 100,
      createTcpSocket: () =>
        new FakeTcpSocket((sock) => {
          sock.emitData(framed.subarray(0, 3));
          sock.emitData(framed.subarray(3));
        }),
    });

    expect(out.equals(reply)).toBe(true);
  });

  it('39: validates the reply by question match with no source check', async () => {
    const query = buildQuery('example.com', 0x1234);
    const reply = replyFor(query, { upperCaseName: true });

    const out = await forwardQueryTcp(query, {
      upstreams: ['9.9.9.9'],
      timeoutMs: 100,
      createTcpSocket: () => new FakeTcpSocket((sock) => sock.emitData(frameMessage(reply))),
    });

    expect(out.equals(reply)).toBe(true);
  });

  it('40: a mismatched question reply falls through; a single upstream → ForwardError', async () => {
    const query = buildQuery('example.com', 0x1234);
    const wrong = replyFor(buildQuery('evil.com', 0x1234));

    await expect(
      forwardQueryTcp(query, {
        upstreams: ['9.9.9.9'],
        timeoutMs: 50,
        createTcpSocket: () => new FakeTcpSocket((sock) => sock.emitData(frameMessage(wrong))),
      }),
    ).rejects.toThrow(ForwardError);
  });

  it('41: a connect failure on #1 falls through to #2 (last-good order)', async () => {
    const query = buildQuery('example.com', 0x1234);
    const reply = replyFor(query);
    const dialed: string[] = [];

    const out = await forwardQueryTcp(query, {
      upstreams: ['1.1.1.1', '2.2.2.2'],
      timeoutMs: 100,
      createTcpSocket: () =>
        new FakeTcpSocket((sock, host) => {
          dialed.push(host);
          if (host === '1.1.1.1') {
            sock.emitError(new Error('ECONNREFUSED'));
          } else {
            sock.emitData(frameMessage(reply));
          }
        }),
    });

    expect(out.equals(reply)).toBe(true);
    expect(dialed).toEqual(['1.1.1.1', '2.2.2.2']);
  });

  it('42: all upstreams failing → ForwardError', async () => {
    const query = buildQuery('example.com', 0x1234);

    await expect(
      forwardQueryTcp(query, {
        upstreams: ['1.1.1.1', '2.2.2.2'],
        timeoutMs: 50,
        createTcpSocket: () => new FakeTcpSocket((sock) => sock.emitError(new Error('down'))),
      }),
    ).rejects.toThrow(ForwardError);
  });

  it('43: a successful TCP forward updates lastGoodUpstream', async () => {
    const query = buildQuery('example.com', 0x1234);
    const reply = replyFor(query);
    const dialedPerCall: string[][] = [];

    const makeSocket = (): ForwardTcpSocket => {
      const dialed: string[] = [];
      dialedPerCall.push(dialed);
      return new FakeTcpSocket((sock, host) => {
        dialed.push(host);
        if (host === '3.3.3.3') {
          sock.emitData(frameMessage(reply));
        } else {
          sock.emitError(new Error('down'));
        }
      });
    };

    const affinity: UpstreamAffinity = { udp: -1, tcp: -1 };
    const opts: ForwardTestOptions = {
      upstreams: ['1.1.1.1', '2.2.2.2', '3.3.3.3'],
      timeoutMs: 50,
      createTcpSocket: makeSocket,
      affinity,
    };

    await forwardQueryTcp(query, opts);
    const before = dialedPerCall.length;
    await forwardQueryTcp(query, opts);
    expect(dialedPerCall[before][0]).toBe('3.3.3.3');
  });

  it('D7: a TCP success does not bias the next UDP query (per-transport affinity)', async () => {
    const query = buildQuery('example.com', 0x1234);
    const reply = replyFor(query);
    const upstreams = ['1.1.1.1', '2.2.2.2', '3.3.3.3'];

    const affinity: UpstreamAffinity = { udp: -1, tcp: -1 };

    await forwardQueryTcp(query, {
      upstreams,
      timeoutMs: 50,
      affinity,
      createTcpSocket: () =>
        new FakeTcpSocket((sock, host) => {
          if (host === '3.3.3.3') sock.emitData(frameMessage(reply));
          else sock.emitError(new Error('down'));
        }),
    });
    expect(affinity.tcp).toBe(2);
    expect(affinity.udp).toBe(-1);

    const udpOrders: string[][] = [];
    await forwardQuery(query, {
      upstreams,
      timeoutMs: 30,
      affinity,
      createSocket: (): ForwardSocket => {
        const attempt: string[] = [];
        udpOrders.push(attempt);
        return new FakeSocket((sock, dest) => {
          attempt.push(dest);
          sock.emitMessage(reply, dest);
        });
      },
    });
    expect(udpOrders[0][0]).toBe('1.1.1.1');
  });

  it('44: aborts an upstream that streams past the max TCP message size (heap-exhaustion guard) → ForwardError', async () => {
    const query = buildQuery('example.com', 0x1234);
    const prefix = Buffer.alloc(2);
    prefix.writeUInt16BE(0xffff, 0);

    await expect(
      forwardQueryTcp(query, {
        upstreams: ['9.9.9.9'],
        timeoutMs: 1000,
        createTcpSocket: () =>
          new FakeTcpSocket((sock) => {
            sock.emitData(Buffer.concat([prefix, Buffer.alloc(40_000, 0x41)]));
            sock.emitData(Buffer.alloc(40_000, 0x42));
          }),
      }),
    ).rejects.toThrow(ForwardError);
  });

  it('45: reassembles a reply dribbled byte-by-byte (gated single concat, no quadratic growth)', async () => {
    const query = buildQuery('example.com', 0x1234);
    const reply = replyFor(query);
    const framed = frameMessage(reply);

    const out = await forwardQueryTcp(query, {
      upstreams: ['9.9.9.9'],
      timeoutMs: 100,
      createTcpSocket: () =>
        new FakeTcpSocket((sock) => {
          for (const byte of framed) {
            sock.emitData(Buffer.from([byte]));
          }
        }),
    });

    expect(out.equals(reply)).toBe(true);
  });

  it('46: an idle timeout on the sole upstream rejects and destroys the socket', async () => {
    const query = buildQuery('example.com', 0x1234);
    let captured: FakeTcpSocket | null = null;

    const promise = forwardQueryTcp(query, {
      upstreams: ['9.9.9.9'],
      timeoutMs: 50,
      createTcpSocket: () =>
        new FakeTcpSocket((sock) => {
          captured = sock;
        }),
    });

    await Promise.resolve();
    captured!.fireTimeout();

    await expect(promise).rejects.toThrow(ForwardError);
    expect(captured!.destroyed).toBe(true);
  });

  it('47: a peer close on the sole upstream rejects and destroys the socket', async () => {
    const query = buildQuery('example.com', 0x1234);
    let captured: FakeTcpSocket | null = null;

    const promise = forwardQueryTcp(query, {
      upstreams: ['9.9.9.9'],
      timeoutMs: 50,
      createTcpSocket: () =>
        new FakeTcpSocket((sock) => {
          captured = sock;
        }),
    });

    await Promise.resolve();
    captured!.emitClose();

    await expect(promise).rejects.toThrow(ForwardError);
    expect(captured!.destroyed).toBe(true);
  });
});
