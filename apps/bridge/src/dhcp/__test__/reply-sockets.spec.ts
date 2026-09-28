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
      vi.fn(),
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
      vi.fn(),
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
      vi.fn(),
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
      vi.fn(),
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
      vi.fn(),
    );

    const refresh = set.refresh();
    eth0.completeBind();
    await flush();
    eth1.completeBind();
    await refresh;

    expect(set.socketFor('10.0.0.50')).toBe(asSocket(eth0));
    expect(set.socketFor('192.168.1.50')).toBe(asSocket(eth1));
  });

  it('forwards a datagram received on a bound socket to onMessage with that socket', async () => {
    const fake = new FakeSocket();
    const onMessage = vi.fn();
    const set = new ReplySocketSet(
      () => asSocket(fake),
      () => [iface()],
      logger,
      onMessage,
    );
    const refresh = set.refresh();
    fake.completeBind();
    await refresh;

    const msg = Buffer.from([0x01]);
    const rinfo: dgram.RemoteInfo = { address: '10.0.0.10', port: 68, family: 'IPv4', size: 1 };
    fake.emit('message', msg, rinfo);

    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledWith(asSocket(fake), msg, rinfo);
  });

  it('never forwards from a socket discarded by a concurrent refresh', async () => {
    const fake = new FakeSocket();
    let ifaces: NetworkInterface[] = [iface()];
    const set = new ReplySocketSet(
      () => asSocket(fake),
      () => ifaces,
      logger,
      vi.fn(),
    );

    const inflight = set.refresh();
    ifaces = [];
    await set.refresh();
    fake.completeBind();
    await inflight;

    expect(fake.listenerCount('message')).toBe(0);
  });
});
