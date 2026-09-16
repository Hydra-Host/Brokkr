import { EventEmitter } from 'node:events';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type SocketBehavior = {
  sendError?: Error;
  recvData?: Buffer;
  recvDelayMs?: number;
  emitError?: Error;
};

let nextBehavior: SocketBehavior = {};
let behaviorQueue: SocketBehavior[] = [];
let sendCount = 0;

class FakeSocket extends EventEmitter {
  closed = false;
  send(_data: Buffer, _port: number, _ip: string, cb?: (err: Error | null) => void): void {
    sendCount += 1;
    const behavior = behaviorQueue.length > 0 ? (behaviorQueue.shift() ?? {}) : nextBehavior;
    if (behavior.sendError) {
      if (cb) cb(behavior.sendError);
      return;
    }
    if (cb) cb(null);
    if (behavior.emitError) {
      setImmediate(() => this.emit('error', behavior.emitError));
      return;
    }
    if (behavior.recvData) {
      const delay = behavior.recvDelayMs ?? 0;
      if (delay > 0) {
        setTimeout(() => this.emit('message', behavior.recvData), delay);
      } else {
        setImmediate(() => this.emit('message', behavior.recvData));
      }
    }
  }
  close(): void {
    this.closed = true;
  }
}

vi.mock('node:dgram', () => ({
  createSocket: (): FakeSocket => new FakeSocket(),
}));

let ipmiPing: typeof import('../ping.js').ipmiPing;
let ipmiPingOutcome: typeof import('../ping.js').ipmiPingOutcome;
let ipmiPingWithRetry: typeof import('../ping.js').ipmiPingWithRetry;
let buildIpmiPingPacket: typeof import('../ping.js').buildIpmiPingPacket;
let isValidIpmiResponse: typeof import('../ping.js').isValidIpmiResponse;

beforeEach(async () => {
  nextBehavior = {};
  behaviorQueue = [];
  sendCount = 0;
  vi.resetModules();
  ({ ipmiPing, ipmiPingOutcome, ipmiPingWithRetry, buildIpmiPingPacket, isValidIpmiResponse } = await import(
    '../ping.js'
  ));
});

afterEach(() => {
  vi.useRealTimers();
});

function validResponse(): Buffer {
  const packet = Buffer.alloc(21);
  packet[0] = 0x06;
  packet[3] = 0x07;
  packet[15] = 0x07 << 2;
  return packet;
}

describe('ipmiPing', () => {
  it('returns true on a valid IPMI response', async () => {
    nextBehavior = { recvData: validResponse() };
    expect(await ipmiPing('10.0.0.1')).toBe(true);
  });

  it('returns false on an invalid IPMI response', async () => {
    nextBehavior = { recvData: Buffer.from([0xff, 0x00, 0x00, 0x00]) };
    expect(await ipmiPing('10.0.0.1')).toBe(false);
  });

  it('returns false when send fails (network unreachable analog)', async () => {
    nextBehavior = { sendError: new Error('network unreachable') };
    expect(await ipmiPing('10.0.0.1')).toBe(false);
  });

  it('returns false on socket error emit (connection refused analog)', async () => {
    nextBehavior = { emitError: new Error('ECONNREFUSED') };
    expect(await ipmiPing('10.0.0.1')).toBe(false);
  });

  it('returns false on outer timeout when the socket never responds', async () => {
    vi.useFakeTimers();
    nextBehavior = {};
    const pending = ipmiPing('10.0.0.1', { timeout: 0.1 });
    await vi.advanceTimersByTimeAsync(200);
    expect(await pending).toBe(false);
  });
});

describe('ipmiPingOutcome', () => {
  it('returns reachable on a valid response', async () => {
    nextBehavior = { recvData: validResponse() };
    expect(await ipmiPingOutcome('10.0.0.1')).toBe('reachable');
  });

  it('returns no_response on an invalid response', async () => {
    nextBehavior = { recvData: Buffer.from([0xff, 0x00, 0x00, 0x00]) };
    expect(await ipmiPingOutcome('10.0.0.1')).toBe('no_response');
  });

  it('returns timeout when the socket never responds', async () => {
    vi.useFakeTimers();
    nextBehavior = {};
    const pending = ipmiPingOutcome('10.0.0.1', { timeout: 0.1 });
    await vi.advanceTimersByTimeAsync(200);
    expect(await pending).toBe('timeout');
  });

  it('returns no_response on socket error emit', async () => {
    nextBehavior = { emitError: new Error('ECONNREFUSED') };
    expect(await ipmiPingOutcome('10.0.0.1')).toBe('no_response');
  });
});

describe('ipmiPingWithRetry', () => {
  it('returns true on the first attempt', async () => {
    nextBehavior = { recvData: validResponse() };
    expect(await ipmiPingWithRetry('10.0.0.1', { maxAttempts: 3, backoffSeconds: 0, timeout: 0.05 })).toBe(true);
  });

  it('returns false when every attempt fails', async () => {
    nextBehavior = { recvData: Buffer.from([0xff, 0x00, 0x00, 0x00]) };
    expect(await ipmiPingWithRetry('10.0.0.1', { maxAttempts: 3, backoffSeconds: 0, timeout: 0.05 })).toBe(false);
    expect(sendCount).toBe(3);
  });

  it('reports reachable when a dropped first packet is answered on a later attempt', async () => {
    behaviorQueue = [{ sendError: new Error('EAGAIN') }, { recvData: validResponse() }];
    expect(await ipmiPingWithRetry('10.0.0.1', { maxAttempts: 3, backoffSeconds: 0, timeout: 0.05 })).toBe(true);
    expect(sendCount).toBe(2);
  });

  it('reports reachable when only the final attempt is answered', async () => {
    behaviorQueue = [
      { sendError: new Error('EAGAIN') },
      { emitError: new Error('EHOSTUNREACH') },
      { recvData: validResponse() },
    ];
    expect(await ipmiPingWithRetry('10.0.0.1', { maxAttempts: 3, backoffSeconds: 0, timeout: 0.05 })).toBe(true);
    expect(sendCount).toBe(3);
  });

  it('stops probing as soon as an attempt succeeds', async () => {
    behaviorQueue = [{ recvData: validResponse() }];
    expect(await ipmiPingWithRetry('10.0.0.1', { maxAttempts: 3, backoffSeconds: 0, timeout: 0.05 })).toBe(true);
    expect(sendCount).toBe(1);
  });

  it('waits the backoff before the next attempt', async () => {
    vi.useFakeTimers();
    behaviorQueue = [{ sendError: new Error('EAGAIN') }, { recvData: validResponse(), recvDelayMs: 1 }];
    const pending = ipmiPingWithRetry('10.0.0.1', { maxAttempts: 3, backoffSeconds: 1, timeout: 0.05 });

    await vi.advanceTimersByTimeAsync(999);
    expect(sendCount).toBe(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(sendCount).toBe(2);

    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toBe(true);
  });

  it('makes a single attempt when retries are disabled', async () => {
    nextBehavior = { recvData: Buffer.from([0xff, 0x00, 0x00, 0x00]) };
    expect(await ipmiPingWithRetry('10.0.0.1', { maxAttempts: 1, backoffSeconds: 0, timeout: 0.05 })).toBe(false);
    expect(sendCount).toBe(1);
  });
});

describe('packet helpers', () => {
  it('buildIpmiPingPacket returns a 23-byte buffer', () => {
    const packet = buildIpmiPingPacket(0);
    expect(packet.length).toBe(23);
    expect(packet[0]).toBe(0x06);
  });

  it('isValidIpmiResponse rejects buffers shorter than 21 bytes', () => {
    expect(isValidIpmiResponse(Buffer.alloc(10))).toBe(false);
  });
});
