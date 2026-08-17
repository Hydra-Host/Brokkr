import type * as dgram from 'node:dgram';
import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import { ReplySocketSet } from '../reply-sockets.js';
import { makeIface, type NetworkInterface } from './test-factories.js';

class FakeSocket extends EventEmitter {
  closed = false;
  private bindCallback: (() => void) | null = null;
  bind = vi.fn((_port: number, _ip: string, cb: () => void) => {
    this.bindCallback = cb;
  });
  setBroadcast = vi.fn();
  close = vi.fn(() => {
    this.closed = true;
  });
  completeBind(): void {
    this.bindCallback?.();
  }
}

const asSocket = (fake: FakeSocket): dgram.Socket => fake as unknown as dgram.Socket;
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const logger = { info: vi.fn(), warn: vi.fn() };

const iface = (overrides: Partial<ReturnType<typeof makeIface>> = {}) =>
  makeIface({ ip: '10.0.0.1', network: '10.0.0.0/24', ...overrides });

describe('ReplySocketSet', () => {
  it('registers a socket in byIp on a successful bind', async () => {
    const fake = new FakeSocket();
    const set = new ReplySocketSet(
      () => asSocket(fake),
      () => [iface()],
      logger,
    );
    const refresh = set.refresh();
    fake.completeBind();
    await refresh;
    expect(set.socketFor('10.0.0.5')).toBe(asSocket(fake));
  });

  it('leaves a failed bind out of byIp and retries it on the next refresh', async () => {
    const first = new FakeSocket();
    const second = new FakeSocket();
    const sockets = [first, second];
    const set = new ReplySocketSet(
      () => asSocket(sockets.shift()!),
      () => [iface()],
      logger,
    );

    const failing = set.refresh();
    first.emit('error', new Error('bind boom'));
    await failing;
    expect(set.socketFor('10.0.0.5')).toBeNull();

    const retry = set.refresh();
    second.completeBind();
    await retry;
    expect(set.socketFor('10.0.0.5')).toBe(asSocket(second));
  });

  it('closes an in-flight socket and skips registration when closeAll fires before bind completes', async () => {
    const fake = new FakeSocket();
    const set = new ReplySocketSet(
      () => asSocket(fake),
      () => [iface()],
      logger,
    );
    const refresh = set.refresh();
    set.closeAll();
    fake.completeBind();
    await refresh;
    expect(fake.closed).toBe(true);
    expect(set.socketFor('10.0.0.5')).toBeNull();
  });

  it('discards an in-flight socket whose interface was dropped by a concurrent refresh', async () => {
    const fake = new FakeSocket();
    let ifaces: NetworkInterface[] = [iface()];
    const set = new ReplySocketSet(
      () => asSocket(fake),
      () => ifaces,
      logger,
    );

    const inflight = set.refresh();
    ifaces = [];
    await set.refresh();
    fake.completeBind();
    await inflight;
    expect(fake.closed).toBe(true);
    expect(set.socketFor('10.0.0.5')).toBeNull();
  });

  it('routes socketFor to the interface whose subnet contains the address', async () => {
    const eth0 = new FakeSocket();
    const eth1 = new FakeSocket();
    const sockets = [eth0, eth1];
    const set = new ReplySocketSet(
      () => asSocket(sockets.shift()!),
      () => [iface(), iface({ name: 'eth1', ip: '192.168.1.1', network: '192.168.1.0/24' })],
      logger,
    );

    const refresh = set.refresh();
    eth0.completeBind();
    await flush();
    eth1.completeBind();
    await refresh;

    expect(set.socketFor('10.0.0.50')).toBe(asSocket(eth0));
    expect(set.socketFor('192.168.1.50')).toBe(asSocket(eth1));
  });
});
