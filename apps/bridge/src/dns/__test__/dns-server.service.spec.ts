import * as dgram from 'node:dgram';
import { hostname as osHostname } from 'node:os';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { DnsCache } from '../cache.js';
import type { DnsConfigAtomValue, DnsPrefixOverrideAtomValue } from '../dns-atom-value.schema.js';
import type {
  DnsConfigReaderService,
  DnsPrefixOverrideReadResult,
  DnsZoneConfigReadResult,
} from '../dns-config-reader.service.js';
import { DnsRecordsLookup } from '../dns-records-reader.js';
import type { DnsRecordsAtomValue } from '../dns-records-reader.schema.js';
import {
  buildOwnedNames,
  DnsServerService,
  resolveQuery,
  toDnsLabel,
  type ResolveDeps,
} from '../dns-server.service.js';
import { defaultDnsConfig, type DnsConfig } from '../dns.config.js';
import { ForwardError, type ForwardOptions, type UpstreamAffinity } from '../forwarder.js';
import type { TcpConn, TcpServer } from '../tcp-listener.js';

const POLL_MS = 1000;

function makeConfig(overrides: Partial<DnsConfig> = {}): DnsConfig {
  return {
    ...defaultDnsConfig({ BRIDGE_HOSTNAME: 'bridge-1' }),
    enabled: true,
    upstreamResolvers: ['1.1.1.1'],
    pollMs: POLL_MS,
    hostnames: [],
    cacheSize: 0,
    ...overrides,
  };
}

interface FakeSocket {
  on: ReturnType<typeof vi.fn>;
  once: ReturnType<typeof vi.fn>;
  removeListener: ReturnType<typeof vi.fn>;
  bind: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  emitMessage(msg: Buffer, rinfo: dgram.RemoteInfo): void;
}

function makeFakeSocket(): FakeSocket {
  let messageHandler: ((msg: Buffer, rinfo: dgram.RemoteInfo) => void) | null = null;
  const fake: FakeSocket = {
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (event === 'message') messageHandler = handler as (msg: Buffer, rinfo: dgram.RemoteInfo) => void;
    }),
    once: vi.fn(),
    removeListener: vi.fn(),
    bind: vi.fn((_port: number, _ip: string, cb: () => void) => cb()),
    send: vi.fn(),
    close: vi.fn(),
    emitMessage: (msg, rinfo) => messageHandler?.(msg, rinfo),
  };
  return fake;
}

function aQueryWire(name: string): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0x1234, 0);
  header.writeUInt16BE(0x0100, 2);
  header.writeUInt16BE(1, 4);
  const labels: Buffer[] = [];
  for (const part of name.split('.')) {
    labels.push(Buffer.from([part.length]), Buffer.from(part, 'ascii'));
  }
  labels.push(Buffer.from([0]));
  const qtail = Buffer.alloc(4);
  qtail.writeUInt16BE(1, 0);
  qtail.writeUInt16BE(1, 2);
  return Buffer.concat([header, ...labels, qtail]);
}

function aQueryWireClass(name: string, qclass: number): Buffer {
  const q = aQueryWire(name);
  q.writeUInt16BE(qclass, q.length - 2);
  return q;
}

const INTERFACES = [
  { interface: 'eth0', ip: '10.0.0.1' },
  { interface: 'eth1', ip: '172.16.0.1' },
];

interface BuiltService {
  service: DnsServerService;
  sockets: FakeSocket[];
  tcpServers: FakeTcpServer[];
}

function buildService(
  opts: { config?: DnsConfig; interfaces?: { interface: string; ip: string }[] } = {},
): BuiltService {
  const sockets: FakeSocket[] = [];
  const tcpServers: FakeTcpServer[] = [];
  const interfaces = opts.interfaces ?? INTERFACES;
  const service = new DnsServerService({
    config: opts.config ?? makeConfig(),
    listInterfaces: () => interfaces,
    createSocket: () => {
      const s = makeFakeSocket();
      sockets.push(s);
      return s as unknown as dgram.Socket;
    },
    createTcpServer: () => {
      const s = makeFakeTcpServer();
      tcpServers.push(s);
      return s;
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  });
  return { service, sockets, tcpServers };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

function boundIps(sockets: FakeSocket[]): string[] {
  return sockets.filter((s) => s.bind.mock.calls.length > 0).map((s) => s.bind.mock.calls[0][1]);
}

describe('DnsServerService binding', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('binds a :53 listener on every interface unconditionally (active/active)', async () => {
    vi.useFakeTimers();
    const { service, sockets } = buildService();

    const start = service.start('job-1');
    await flush();

    expect(sockets).toHaveLength(2);
    expect(sockets[0].bind).toHaveBeenCalledWith(53, '10.0.0.1', expect.any(Function));
    expect(sockets[1].bind).toHaveBeenCalledWith(53, '172.16.0.1', expect.any(Function));
    expect(boundIps(sockets)).toEqual(['10.0.0.1', '172.16.0.1']);

    service.stop('job-1');
    await expect(start).resolves.toBeUndefined();
    expect(sockets[0].close).toHaveBeenCalledTimes(1);
    expect(sockets[1].close).toHaveBeenCalledTimes(1);
  });

  it('calls onStop callback during stop() for external resource cleanup', async () => {
    vi.useFakeTimers();
    const onStop = vi.fn();
    const sockets: FakeSocket[] = [];
    const service = new DnsServerService({
      config: makeConfig(),
      listInterfaces: () => INTERFACES,
      createSocket: () => {
        const s = makeFakeSocket();
        sockets.push(s);
        return s as unknown as dgram.Socket;
      },
      createTcpServer: () => makeFakeTcpServer(),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      onStop,
    });

    const start = service.start('job-1');
    await flush();
    await service.stop('job-1');
    await expect(start).resolves.toBeUndefined();

    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it('awaits an async onStop so the Redis client closes before shutdown proceeds', async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    const onStop = vi.fn(async () => {
      await Promise.resolve();
      order.push('onStop-resolved');
    });
    const sockets: FakeSocket[] = [];
    const service = new DnsServerService({
      config: makeConfig(),
      listInterfaces: () => INTERFACES,
      createSocket: () => {
        const s = makeFakeSocket();
        sockets.push(s);
        return s as unknown as dgram.Socket;
      },
      createTcpServer: () => makeFakeTcpServer(),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      onStop,
    });

    const start = service.start('job-1');
    await flush();
    await service.stop('job-1');
    order.push('stop-returned');
    await expect(start).resolves.toBeUndefined();

    expect(order).toEqual(['onStop-resolved', 'stop-returned']);
  });

  it('does not arm a reconcile timer when stop() races start()s initial bind (none survives shutdown)', async () => {
    vi.useFakeTimers();
    const { service, sockets } = buildService();

    const start = service.start('job-1');
    service.stop('job-1');
    await flush();
    await expect(start).resolves.toBeUndefined();

    expect(vi.getTimerCount()).toBe(0);

    const socketsBefore = sockets.length;
    await vi.advanceTimersByTimeAsync(POLL_MS * 2);
    expect(sockets.length).toBe(socketsBefore);
  });

  it('warns when a bound interface IP is outside the RFC1918 provisioning range', async () => {
    vi.useFakeTimers();
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const interfaces = [
      { interface: 'eth0', ip: '10.0.0.1' },
      { interface: 'eth1', ip: '203.0.113.5' },
    ];
    const service = new DnsServerService({
      config: makeConfig(),
      listInterfaces: () => interfaces,
      createSocket: () => makeFakeSocket() as unknown as dgram.Socket,
      createTcpServer: () => makeFakeTcpServer(),
      logger,
    });

    const start = service.start('job-1');
    await flush();

    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('DNS bound to non-private IP eth1 203.0.113.5'), {
      jobId: 'job-1',
    });
    expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining('10.0.0.1'), expect.anything());

    service.stop('job-1');
    await expect(start).resolves.toBeUndefined();
  });

  it('answers brokkr.lan A with the per-ingress listenIp of the receiving interface', async () => {
    vi.useFakeTimers();
    const { service, sockets } = buildService();

    const start = service.start('job-1');
    await flush();
    expect(sockets).toHaveLength(2);

    const rinfo: dgram.RemoteInfo = { address: '172.16.0.50', port: 5353, family: 'IPv4', size: 0 };
    sockets[1].emitMessage(aQueryWire('brokkr.lan'), rinfo);
    await flush();

    expect(sockets[1].send).toHaveBeenCalledTimes(1);
    const [response] = sockets[1].send.mock.calls[0];
    const buf: Buffer = response;
    expect([...buf.subarray(buf.length - 4)]).toEqual([172, 16, 0, 1]);

    service.stop('job-1');
    await expect(start).resolves.toBeUndefined();
  });

  it('answers brokkr.lan A with the sole interface IP on a single-NIC bridge', async () => {
    vi.useFakeTimers();
    const { service, sockets } = buildService({ interfaces: [{ interface: 'eth0', ip: '10.0.0.1' }] });

    const start = service.start('job-1');
    await flush();
    expect(sockets).toHaveLength(1);

    const rinfo: dgram.RemoteInfo = { address: '10.0.0.50', port: 5353, family: 'IPv4', size: 0 };
    sockets[0].emitMessage(aQueryWire('brokkr.lan'), rinfo);
    await flush();

    const [response] = sockets[0].send.mock.calls[0];
    const buf: Buffer = response;
    expect([...buf.subarray(buf.length - 4)]).toEqual([10, 0, 0, 1]);

    service.stop('job-1');
    await expect(start).resolves.toBeUndefined();
  });

  it('answers brokkr.lan A with each interface own IP (per-ingress, not a global primary)', async () => {
    vi.useFakeTimers();
    const { service, sockets } = buildService();

    const start = service.start('job-1');
    await flush();
    expect(sockets).toHaveLength(2);

    const rinfo0: dgram.RemoteInfo = { address: '10.0.0.50', port: 5353, family: 'IPv4', size: 0 };
    sockets[0].emitMessage(aQueryWire('brokkr.lan'), rinfo0);
    await flush();
    expect([...(sockets[0].send.mock.calls[0][0] as Buffer).subarray(-4)]).toEqual([10, 0, 0, 1]);

    const rinfo1: dgram.RemoteInfo = { address: '172.16.0.50', port: 5353, family: 'IPv4', size: 0 };
    sockets[1].emitMessage(aQueryWire('brokkr.lan'), rinfo1);
    await flush();
    expect([...(sockets[1].send.mock.calls[0][0] as Buffer).subarray(-4)]).toEqual([172, 16, 0, 1]);

    service.stop('job-1');
    await expect(start).resolves.toBeUndefined();
  });

  it('is idempotent: a reconcile tick while already bound does not rebind', async () => {
    vi.useFakeTimers();
    const { service, sockets } = buildService();

    const start = service.start('job-1');
    await flush();
    expect(sockets).toHaveLength(2);

    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(POLL_MS);
      await flush();
    }
    expect(sockets).toHaveLength(2);

    service.stop('job-1');
    await expect(start).resolves.toBeUndefined();
  });

  it('binds an interface that first appears on a later reconcile tick', async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const interfaces = [{ interface: 'eth0', ip: '10.0.0.1' }];
    const service = new DnsServerService({
      config: makeConfig(),
      listInterfaces: () => interfaces,
      createSocket: () => {
        const s = makeFakeSocket();
        sockets.push(s);
        return s as unknown as dgram.Socket;
      },
      createTcpServer: () => makeFakeTcpServer(),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    const start = service.start('job-1');
    await flush();
    expect(sockets).toHaveLength(1);

    interfaces.push({ interface: 'br-brokkr', ip: '192.168.200.1' });
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await flush();
    expect(sockets).toHaveLength(2);

    const rinfo: dgram.RemoteInfo = { address: '192.168.200.50', port: 5353, family: 'IPv4', size: 0 };
    sockets[1].emitMessage(aQueryWire('brokkr.lan'), rinfo);
    await flush();
    expect(sockets[1].send).toHaveBeenCalled();

    service.stop('job-1');
    await expect(start).resolves.toBeUndefined();
  });

  it('bounds fast-retry: a permanently-failing served IP backs off to the slow poll', async () => {
    vi.useFakeTimers();
    const interfaces = [
      { interface: 'eth0', ip: '10.0.0.1' },
      { interface: 'eth1', ip: '172.16.0.1' },
    ];
    let eth1Attempts = 0;
    const service = new DnsServerService({
      config: makeConfig(),
      listInterfaces: () => interfaces,
      createSocket: () => {
        let onErr: ((e: Error) => void) | null = null;
        const s = {
          on: vi.fn(),
          once: vi.fn((ev: string, h: (...a: unknown[]) => void) => {
            if (ev === 'error') onErr = h as (e: Error) => void;
          }),
          removeListener: vi.fn(),
          bind: vi.fn((_port: number, ip: string, cb: () => void) => {
            if (ip === '172.16.0.1') {
              eth1Attempts += 1;
              onErr?.(new Error('EADDRINUSE'));
            } else {
              cb();
            }
          }),
          send: vi.fn(),
          close: vi.fn(),
        };
        return s as unknown as dgram.Socket;
      },
      createTcpServer: () => makeFakeTcpServer(),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    const start = service.start('job-1');
    await flush();

    await vi.advanceTimersByTimeAsync(100 * 50 + POLL_MS * 3);
    await flush();
    const settled = eth1Attempts;
    expect(settled).toBeGreaterThan(10);

    await vi.advanceTimersByTimeAsync(POLL_MS / 2);
    await flush();
    expect(eth1Attempts - settled).toBeLessThanOrEqual(1);

    service.stop('job-1');
    await expect(start).resolves.toBeUndefined();
  });

  it('re-arms fast-retry when a new served IP appears after the budget is spent', async () => {
    vi.useFakeTimers();
    const interfaces = [
      { interface: 'eth0', ip: '10.0.0.1' },
      { interface: 'eth1', ip: '172.16.0.1' },
    ];
    let failAttempts = 0;
    const service = new DnsServerService({
      config: makeConfig(),
      listInterfaces: () => interfaces,
      createSocket: () => {
        let onErr: ((e: Error) => void) | null = null;
        const s = {
          on: vi.fn(),
          once: vi.fn((ev: string, h: (...a: unknown[]) => void) => {
            if (ev === 'error') onErr = h as (e: Error) => void;
          }),
          removeListener: vi.fn(),
          bind: vi.fn((_port: number, ip: string, cb: () => void) => {
            if (ip.startsWith('172.16.')) {
              failAttempts += 1;
              onErr?.(new Error('EADDRINUSE'));
            } else {
              cb();
            }
          }),
          send: vi.fn(),
          close: vi.fn(),
        };
        return s as unknown as dgram.Socket;
      },
      createTcpServer: () => makeFakeTcpServer(),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    const start = service.start('job-1');
    await flush();
    await vi.advanceTimersByTimeAsync(100 * 50 + POLL_MS * 3);
    await flush();

    interfaces.push({ interface: 'eth2', ip: '172.16.0.2' });
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await flush();
    const afterAppear = failAttempts;

    await vi.advanceTimersByTimeAsync(POLL_MS / 2);
    await flush();
    expect(failAttempts - afterAppear).toBeGreaterThan(1);

    service.stop('job-1');
    await expect(start).resolves.toBeUndefined();
  });

  it('answers brokkr.lan with the new interface IP when an interface appears mid-run', async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const interfaces = [{ interface: 'eth0', ip: '10.0.0.1' }];
    const service = new DnsServerService({
      config: makeConfig(),
      listInterfaces: () => interfaces,
      createSocket: () => {
        const s = makeFakeSocket();
        sockets.push(s);
        return s as unknown as dgram.Socket;
      },
      createTcpServer: () => makeFakeTcpServer(),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    const start = service.start('job-1');
    await flush();
    expect(sockets).toHaveLength(1);

    interfaces.push({ interface: 'eth1', ip: '172.16.0.1' });
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await flush();
    expect(sockets).toHaveLength(2);

    const rinfo: dgram.RemoteInfo = { address: '172.16.0.50', port: 5353, family: 'IPv4', size: 0 };
    sockets[1].emitMessage(aQueryWire('brokkr.lan'), rinfo);
    await flush();
    expect([...(sockets[1].send.mock.calls[0][0] as Buffer).subarray(-4)]).toEqual([172, 16, 0, 1]);

    service.stop('job-1');
    await expect(start).resolves.toBeUndefined();
  });

  it('returns one coherent listenIp per socket after a mid-run reconcile (synchronous-read invariant)', async () => {
    vi.useFakeTimers();
    const { service, sockets } = buildService();

    const start = service.start('job-1');
    await flush();
    expect(sockets).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(POLL_MS);
    await flush();

    const rinfo: dgram.RemoteInfo = { address: '10.0.0.50', port: 5353, family: 'IPv4', size: 0 };
    sockets[0].emitMessage(aQueryWire('brokkr.lan'), rinfo);
    await flush();
    expect([...(sockets[0].send.mock.calls[0][0] as Buffer).subarray(-4)]).toEqual([10, 0, 0, 1]);

    service.stop('job-1');
    await expect(start).resolves.toBeUndefined();
  });

  it('closes the in-flight socket when stop() races a mid-bind', async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    let captured: (() => void) | null = null;
    let stopped = false;
    const service = new DnsServerService({
      config: makeConfig(),
      listInterfaces: () => INTERFACES,
      createSocket: () => {
        const s = makeFakeSocket();
        s.bind = vi.fn((_port: number, ip: string, cb: () => void) => {
          if (ip === '10.0.0.1' && !stopped) {
            captured = cb;
            return;
          }
          cb();
        });
        sockets.push(s);
        return s as unknown as dgram.Socket;
      },
      createTcpServer: () => makeFakeTcpServer(),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    const start = service.start('job-1');
    await flush();

    expect(sockets).toHaveLength(1);
    stopped = true;
    service.stop('job-1');
    captured?.();
    await flush();
    expect(sockets[0].close).toHaveBeenCalledTimes(1);

    await expect(start).resolves.toBeUndefined();
  });

  it('parks: start() stays pending until stop()', async () => {
    vi.useFakeTimers();
    const { service } = buildService();

    const start = service.start('job-1');
    let settled = false;
    void start.then(() => {
      settled = true;
    });
    await flush();
    expect(settled).toBe(false);

    service.stop('job-1');
    await expect(start).resolves.toBeUndefined();
    expect(settled).toBe(true);
  });

  it('stays unbound when there are no client-facing interfaces, then binds when one appears', async () => {
    vi.useFakeTimers();
    let interfaces: { interface: string; ip: string }[] = [];
    const sockets: FakeSocket[] = [];
    const service = new DnsServerService({
      config: makeConfig(),
      listInterfaces: () => interfaces,
      createSocket: () => {
        const s = makeFakeSocket();
        sockets.push(s);
        return s as unknown as dgram.Socket;
      },
      createTcpServer: () => makeFakeTcpServer(),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    const start = service.start('job-1');
    await flush();

    expect(sockets).toHaveLength(0);

    interfaces = [{ interface: 'eth0', ip: '10.0.0.1' }];
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await flush();

    expect(boundIps(sockets)).toEqual(['10.0.0.1']);

    service.stop('job-1');
    await expect(start).resolves.toBeUndefined();
  });

  it('closes and drops a listener whose IP leaves the interface set', async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    let interfaces = [
      { interface: 'eth0', ip: '10.0.0.1' },
      { interface: 'br-brokkr', ip: '192.168.200.1' },
    ];
    const service = new DnsServerService({
      config: makeConfig(),
      listInterfaces: () => interfaces,
      createSocket: () => {
        const s = makeFakeSocket();
        sockets.push(s);
        return s as unknown as dgram.Socket;
      },
      createTcpServer: () => makeFakeTcpServer(),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    const start = service.start('job-1');
    await flush();
    expect(boundIps(sockets)).toEqual(['10.0.0.1', '192.168.200.1']);

    interfaces = [{ interface: 'eth0', ip: '10.0.0.1' }];
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await flush();

    expect(sockets[1].close).toHaveBeenCalledTimes(1);
    expect(sockets[0].close).not.toHaveBeenCalled();
    expect(sockets).toHaveLength(2);

    service.stop('job-1');
    await expect(start).resolves.toBeUndefined();
  });

  it('closes the old socket and binds the new one when an interface IP changes', async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    let interfaces = [{ interface: 'eth0', ip: '10.0.0.1' }];
    const service = new DnsServerService({
      config: makeConfig(),
      listInterfaces: () => interfaces,
      createSocket: () => {
        const s = makeFakeSocket();
        sockets.push(s);
        return s as unknown as dgram.Socket;
      },
      createTcpServer: () => makeFakeTcpServer(),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    const start = service.start('job-1');
    await flush();
    expect(boundIps(sockets)).toEqual(['10.0.0.1']);

    interfaces = [{ interface: 'eth0', ip: '10.0.0.2' }];
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await flush();

    expect(sockets[0].close).toHaveBeenCalledTimes(1);
    expect(boundIps(sockets)).toEqual(['10.0.0.1', '10.0.0.2']);
    expect(sockets[1].close).not.toHaveBeenCalled();

    service.stop('job-1');
    await expect(start).resolves.toBeUndefined();
  });

  it('does not share upstream affinity across two DnsServerService instances', async () => {
    vi.useFakeTimers();
    const seenAffinities: UpstreamAffinity[] = [];

    const build = (): { service: DnsServerService; sockets: FakeSocket[] } => {
      const sockets: FakeSocket[] = [];
      const service = new DnsServerService({
        config: makeConfig(),
        listInterfaces: () => [{ interface: 'eth0', ip: '10.0.0.1' }],
        createSocket: () => {
          const s = makeFakeSocket();
          sockets.push(s);
          return s as unknown as dgram.Socket;
        },
        forward: async (_q: Buffer, opts: ForwardOptions): Promise<Buffer> => {
          seenAffinities.push(opts.affinity);
          return aResponse('example.com', '1.2.3.4', 60);
        },
        createTcpServer: () => makeFakeTcpServer(),
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      });
      return { service, sockets };
    };

    const a = build();
    const b = build();
    const startA = a.service.start('job-a');
    const startB = b.service.start('job-b');
    await flush();

    const rinfo: dgram.RemoteInfo = { address: '10.0.0.50', port: 5353, family: 'IPv4', size: 0 };
    a.sockets[0].emitMessage(aQueryWire('example.com'), rinfo);
    b.sockets[0].emitMessage(aQueryWire('example.com'), rinfo);
    await flush();

    a.service.stop('job-a');
    b.service.stop('job-b');
    await expect(startA).resolves.toBeUndefined();
    await expect(startB).resolves.toBeUndefined();

    expect(seenAffinities).toHaveLength(2);
    expect(seenAffinities[0]).not.toBe(seenAffinities[1]);
  });
});

describe('DnsServerService hostname identity (C1)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('BRIDGE_HOSTNAME=foo → owned names include foo.lan (read through the baseline config)', async () => {
    vi.useFakeTimers();
    const config: DnsConfig = { ...defaultDnsConfig({ BRIDGE_HOSTNAME: 'foo' }), enabled: true };
    expect(config.hostname).toBe('foo');

    const info = vi.fn();
    const sockets: FakeSocket[] = [];
    const service = new DnsServerService({
      config,
      listInterfaces: () => INTERFACES,
      createSocket: () => {
        const s = makeFakeSocket();
        sockets.push(s);
        return s as unknown as dgram.Socket;
      },
      createTcpServer: () => makeFakeTcpServer(),
      logger: { info, warn: vi.fn(), error: vi.fn() },
    });

    const start = service.start('job-1');
    await flush();

    const ownedLog = info.mock.calls.find((c) => String(c[0]).startsWith('DNS owned names:'));
    expect(ownedLog).toBeDefined();
    expect(ownedLog![0]).toContain('foo.lan');
    expect(ownedLog![0]).toContain('brokkr.lan');

    service.stop('job-1');
    await expect(start).resolves.toBeUndefined();
    vi.useRealTimers();
  });

  it('BRIDGE_HOSTNAME unset → identity falls back to os.hostname()', () => {
    const config = defaultDnsConfig({});
    expect(config.hostname).toBe(osHostname());
  });

  it('BRIDGE_HOSTNAME=foo answers an A query for foo.lan with the bound IP', async () => {
    vi.useFakeTimers();
    const config: DnsConfig = { ...defaultDnsConfig({ BRIDGE_HOSTNAME: 'foo' }), enabled: true };
    const { service, sockets } = buildService({ config });

    const start = service.start('job-1');
    await flush();
    expect(sockets).toHaveLength(2);

    const rinfo: dgram.RemoteInfo = { address: '10.0.0.99', port: 5353, family: 'IPv4', size: 0 };
    sockets[0].emitMessage(aQueryWire('foo.lan'), rinfo);
    await flush();

    expect(sockets[0].send).toHaveBeenCalledTimes(1);
    const [response, port, address] = sockets[0].send.mock.calls[0];
    expect(port).toBe(5353);
    expect(address).toBe('10.0.0.99');
    const buf: Buffer = response;
    expect([...buf.subarray(buf.length - 4)]).toEqual([10, 0, 0, 1]);

    service.stop('job-1');
    await expect(start).resolves.toBeUndefined();
  });
});

const QTYPE_A = 1;
const QCLASS_IN = 1;
const FLAG_QR_RESPONSE = 0x8000;
const FLAG_TC = 0x0200;

function encodeName(name: string): Buffer {
  const labels: Buffer[] = [];
  for (const part of name.split('.')) {
    labels.push(Buffer.from([part.length]), Buffer.from(part, 'ascii'));
  }
  labels.push(Buffer.from([0]));
  return Buffer.concat(labels);
}

function questionSection(qname: string): Buffer {
  const tail = Buffer.alloc(4);
  tail.writeUInt16BE(QTYPE_A, 0);
  tail.writeUInt16BE(QCLASS_IN, 2);
  return Buffer.concat([encodeName(qname), tail]);
}

function aRecord(name: string, ip: string, ttl: number): Buffer {
  const rdata = Buffer.from(ip.split('.').map((o) => Number.parseInt(o, 10)));
  const head = Buffer.alloc(10);
  head.writeUInt16BE(QTYPE_A, 0);
  head.writeUInt16BE(QCLASS_IN, 2);
  head.writeUInt32BE(ttl, 4);
  head.writeUInt16BE(rdata.length, 8);
  return Buffer.concat([encodeName(name), head, rdata]);
}

function aResponse(qname: string, ip: string, ttl: number, txnId = 0x1234, extraFlags = 0): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(txnId, 0);
  header.writeUInt16BE(FLAG_QR_RESPONSE | extraFlags, 2);
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(1, 6);
  return Buffer.concat([header, questionSection(qname), aRecord(qname, ip, ttl)]);
}

function firstAnswerTtl(packet: Buffer): number {
  const skip = (offset: number): number => {
    let cursor = offset;
    for (;;) {
      const len = packet[cursor];
      if ((len & 0xc0) === 0xc0) return cursor + 2;
      if (len === 0) return cursor + 1;
      cursor += 1 + len;
    }
  };
  const afterQuestion = skip(12) + 4;
  const afterAnswerName = skip(afterQuestion);
  return packet.readUInt32BE(afterAnswerName + 4);
}

function makeResolveDeps(overrides: Partial<ResolveDeps> = {}): ResolveDeps {
  return {
    owned: new Set(['brokkr.lan']),
    authoritativeSuffix: '.lan',
    ttlSeconds: 60,
    upstreams: ['1.1.1.1'],
    timeoutMs: 1000,
    forward: async () => aResponse('example.com', '93.184.216.34', 1000),
    affinity: { udp: -1, tcp: -1 },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    jobId: 'job-1',
    recordsLookup: null,
    ...overrides,
  };
}

describe('resolveQuery forward cache + clamp', () => {
  it('serves a forwarded answer from cache within TTL, forwarding exactly once', async () => {
    const cache = new DnsCache({ capacity: 10 });
    const forward = vi.fn(async () => aResponse('example.com', '93.184.216.34', 300));
    const deps = makeResolveDeps({ cache, forward });

    const q1 = aQueryWire('example.com');
    const first = await resolveQuery(q1, '10.0.0.1', deps);
    expect(first).not.toBeNull();
    const q2 = aQueryWire('example.com');
    q2.writeUInt16BE(0x5678, 0);
    const second = await resolveQuery(q2, '10.0.0.1', deps);
    expect(forward).toHaveBeenCalledTimes(1);
    expect(second!.readUInt16BE(0)).toBe(0x5678);
    expect(second!.subarray(2).equals(first!.subarray(2))).toBe(true);
  });

  it('clamps a forwarded RR TTL to DNS_MAX_TTL before returning and caching', async () => {
    const cache = new DnsCache({ capacity: 10 });
    const forward = vi.fn(async () => aResponse('example.com', '1.2.3.4', 9999));
    const deps = makeResolveDeps({ cache, forward, maxTtlSeconds: 120 });

    const out = await resolveQuery(aQueryWire('example.com'), '10.0.0.1', deps);
    expect(out).not.toBeNull();
    expect(firstAnswerTtl(out!)).toBe(120);
  });

  it('never caches an owned-name answer (depends on listenIp, not forwarded)', async () => {
    const cache = new DnsCache({ capacity: 10 });
    const forward = vi.fn(async () => aResponse('example.com', '1.2.3.4', 300));
    const deps = makeResolveDeps({ cache, forward, owned: new Set(['brokkr.lan']) });

    await resolveQuery(aQueryWire('brokkr.lan'), '10.0.0.1', deps);
    expect(cache.size).toBe(0);
    expect(forward).not.toHaveBeenCalled();
  });

  it('cache holds ONLY validated forwarded replies — a query that never forwards stores nothing', async () => {
    const cache = new DnsCache({ capacity: 10 });
    const forward = vi.fn(async () => aResponse('x', '1.2.3.4', 300));
    const deps = makeResolveDeps({ cache, forward, owned: new Set(['brokkr.lan']) });

    await resolveQuery(aQueryWire('unknown.lan'), '10.0.0.1', deps);
    expect(forward).not.toHaveBeenCalled();
    expect(cache.size).toBe(0);
  });
});

describe('resolveQuery TC→TCP retry', () => {
  it('refetches over TCP when the UDP reply is truncated, returns the full TCP answer', async () => {
    const truncated = aResponse('example.com', '0.0.0.0', 0, 0x1234, FLAG_TC);
    const full = aResponse('example.com', '93.184.216.34', 300);
    const forward = vi.fn(async () => truncated);
    const forwardTcp = vi.fn(async () => full);
    const cache = new DnsCache({ capacity: 10 });
    const deps = makeResolveDeps({ forward, forwardTcp, cache });

    const out = await resolveQuery(aQueryWire('example.com'), '10.0.0.1', deps);
    expect(forwardTcp).toHaveBeenCalledTimes(1);
    expect(out!.equals(full)).toBe(true);
    expect(cache.get('example.com', QTYPE_A, 0x1234)).not.toBeNull();
  });

  it('returns the truncated reply as-is when no TCP forwarder is wired (TCP disabled)', async () => {
    const truncated = aResponse('example.com', '0.0.0.0', 0, 0x1234, FLAG_TC);
    const forward = vi.fn(async () => truncated);
    const deps = makeResolveDeps({ forward, forwardTcp: undefined });

    const out = await resolveQuery(aQueryWire('example.com'), '10.0.0.1', deps);
    expect(out!.equals(truncated)).toBe(true);
  });

  it('falls through to the truncated reply when the TCP retry throws ForwardError', async () => {
    const truncated = aResponse('example.com', '0.0.0.0', 0, 0x1234, FLAG_TC);
    const forward = vi.fn(async () => truncated);
    const forwardTcp = vi.fn(async () => {
      throw new ForwardError('tcp upstream failed');
    });
    const cache = new DnsCache({ capacity: 10 });
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const deps = makeResolveDeps({ forward, forwardTcp, cache, logger });

    const out = await resolveQuery(aQueryWire('example.com'), '10.0.0.1', deps);
    expect(out!.equals(truncated)).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('DNS TCP retry failed'), { jobId: 'job-1' });
    expect(cache.get('example.com', QTYPE_A, 0x1234)).toBeNull();
  });
});

interface FakeTcpServer extends TcpServer {
  emitConnection(conn: TcpConn): void;
  listenCalls: Array<[number, string]>;
  closed: boolean;
}

function makeFakeTcpServer(failListen = false): FakeTcpServer {
  let connHandler: ((conn: TcpConn) => void) | null = null;
  let errorHandler: ((err: Error) => void) | null = null;
  const server: FakeTcpServer = {
    listenCalls: [],
    closed: false,
    on(event: string, handler: (...args: never[]) => void): unknown {
      if (event === 'connection') connHandler = handler as unknown as (conn: TcpConn) => void;
      else if (event === 'error') errorHandler = handler as unknown as (err: Error) => void;
      return server;
    },
    listen(port: number, host: string, _backlog: number, cb: () => void): unknown {
      server.listenCalls.push([port, host]);
      if (failListen) errorHandler?.(new Error('EADDRINUSE'));
      else cb();
      return server;
    },
    close(): unknown {
      server.closed = true;
      return server;
    },
    emitConnection(conn: TcpConn): void {
      connHandler?.(conn);
    },
  };
  return server;
}

describe('DnsServerService TCP binding', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function buildTcpService(): {
    service: DnsServerService;
    udpSockets: FakeSocket[];
    tcpServers: FakeTcpServer[];
  } {
    const udpSockets: FakeSocket[] = [];
    const tcpServers: FakeTcpServer[] = [];
    const service = new DnsServerService({
      config: makeConfig(),
      listInterfaces: () => INTERFACES,
      createSocket: () => {
        const s = makeFakeSocket();
        udpSockets.push(s);
        return s as unknown as dgram.Socket;
      },
      createTcpServer: () => {
        const s = makeFakeTcpServer();
        tcpServers.push(s);
        return s;
      },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    return { service, udpSockets, tcpServers };
  }

  it('binds both a UDP socket and a TCP listener per interface on :53', async () => {
    vi.useFakeTimers();
    const { service, udpSockets, tcpServers } = buildTcpService();

    const start = service.start('job-1');
    await flush();

    expect(udpSockets).toHaveLength(2);
    expect(tcpServers).toHaveLength(2);
    expect(tcpServers[0].listenCalls[0]).toEqual([53, '10.0.0.1']);
    expect(tcpServers[1].listenCalls[0]).toEqual([53, '172.16.0.1']);

    service.stop('job-1');
    await expect(start).resolves.toBeUndefined();
    expect(tcpServers.every((s) => s.closed)).toBe(true);
  });

  it('tears down every TCP listener (and destroys live conns) on stop()', async () => {
    vi.useFakeTimers();
    const { service, tcpServers } = buildTcpService();

    const start = service.start('job-1');
    await flush();
    expect(tcpServers).toHaveLength(2);

    const conn: TcpConn = { destroy: vi.fn(), on: vi.fn(), write: vi.fn(), setTimeout: vi.fn() };
    tcpServers[0].emitConnection(conn);

    service.stop('job-1');
    await expect(start).resolves.toBeUndefined();
    expect(tcpServers.every((s) => s.closed)).toBe(true);
    expect(conn.destroy).toHaveBeenCalledWith();
  });

  it('destroys a connection accepted after stop() without tracking it', async () => {
    vi.useFakeTimers();
    const { service, tcpServers } = buildTcpService();

    const start = service.start('job-1');
    await flush();

    service.stop('job-1');
    const conn: TcpConn = { destroy: vi.fn(), on: vi.fn(), write: vi.fn(), setTimeout: vi.fn() };
    tcpServers[0].emitConnection(conn);

    expect(conn.destroy).toHaveBeenCalledWith();
    expect(conn.on).not.toHaveBeenCalled();

    await expect(start).resolves.toBeUndefined();
  });

  it('logs and continues when one interface TCP socket fails to bind', async () => {
    vi.useFakeTimers();
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    let created = 0;
    const service = new DnsServerService({
      config: makeConfig(),
      listInterfaces: () => INTERFACES,
      createSocket: () => makeFakeSocket() as unknown as dgram.Socket,
      createTcpServer: () => makeFakeTcpServer(created++ === 0),
      logger,
    });

    const start = service.start('job-1');
    await flush();

    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('DNS TCP bind failed on eth0 10.0.0.1:53'), {
      jobId: 'job-1',
    });

    service.stop('job-1');
    await expect(start).resolves.toBeUndefined();
  });

  it('drops a connection over tcpMaxConnections without destroying the tracked one', async () => {
    vi.useFakeTimers();
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const tcpServers: FakeTcpServer[] = [];
    const service = new DnsServerService({
      config: makeConfig({ tcpMaxConnections: 1 }),
      listInterfaces: () => INTERFACES,
      createSocket: () => makeFakeSocket() as unknown as dgram.Socket,
      createTcpServer: () => {
        const s = makeFakeTcpServer();
        tcpServers.push(s);
        return s;
      },
      logger,
    });

    const start = service.start('job-1');
    await flush();

    const conn1: TcpConn = { destroy: vi.fn(), on: vi.fn(), write: vi.fn(), setTimeout: vi.fn() };
    const conn2: TcpConn = { destroy: vi.fn(), on: vi.fn(), write: vi.fn(), setTimeout: vi.fn() };
    tcpServers[0].emitConnection(conn1);
    tcpServers[0].emitConnection(conn2);

    expect(conn1.destroy).not.toHaveBeenCalled();
    expect(conn2.destroy).toHaveBeenCalledWith();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('connection limit'), { jobId: 'job-1' });

    service.stop('job-1');
    await expect(start).resolves.toBeUndefined();
  });

  it('can rebind on a second start() after stop()', async () => {
    vi.useFakeTimers();
    const { service, tcpServers } = buildTcpService();

    const start1 = service.start('job-1');
    await flush();
    expect(tcpServers).toHaveLength(2);

    service.stop('job-1');
    await expect(start1).resolves.toBeUndefined();

    const start2 = service.start('job-2');
    await flush();
    expect(tcpServers).toHaveLength(4);

    service.stop('job-2');
    await expect(start2).resolves.toBeUndefined();
  });
});

describe('toDnsLabel', () => {
  it.each([
    ['BRIDGE-001', 'bridge-001'],
    ['bridge_a.example.com', 'bridge-a'],
    ['BROKKR', 'brokkr'],
    ['', ''],
    ['host.with.many.dots', 'host'],
  ])('sanitizes %s -> %s', (input, expected) => {
    expect(toDnsLabel(input)).toBe(expected);
  });
});

describe('buildOwnedNames', () => {
  it('always includes brokkr.lan', () => {
    expect(buildOwnedNames('any-host').has('brokkr.lan')).toBe(true);
  });

  it('includes the sanitized hostname label', () => {
    expect(buildOwnedNames('bridge-zone-9-57-16').has('bridge-zone-9-57-16.lan')).toBe(true);
  });

  it('skips the hostname when it would collide with brokkr', () => {
    expect(buildOwnedNames('brokkr')).toEqual(new Set(['brokkr.lan']));
  });

  it('handles an empty hostname (brokkr.lan only)', () => {
    expect(buildOwnedNames('')).toEqual(new Set(['brokkr.lan']));
  });

  it('uses a custom ownedDomain', () => {
    expect(buildOwnedNames('bridge-1', 'internal')).toEqual(new Set(['brokkr.internal', 'bridge-1.internal']));
  });

  it('falls back to lan when ownedDomain is empty', () => {
    expect(buildOwnedNames('bridge-1', '')).toEqual(new Set(['brokkr.lan', 'bridge-1.lan']));
  });

  it('adds extra hostnames to the owned set', () => {
    expect(buildOwnedNames('bridge-1', 'lan', ['alias-a', 'alias-b'])).toEqual(
      new Set(['brokkr.lan', 'bridge-1.lan', 'alias-a.lan', 'alias-b.lan']),
    );
  });

  it('deduplicates when a hostname matches the host label', () => {
    expect(buildOwnedNames('bridge-1', 'lan', ['bridge-1', 'other'])).toEqual(
      new Set(['brokkr.lan', 'bridge-1.lan', 'other.lan']),
    );
  });

  it('deduplicates when a hostname matches brokkr', () => {
    expect(buildOwnedNames('host-1', 'lan', ['brokkr'])).toEqual(new Set(['brokkr.lan', 'host-1.lan']));
  });

  it('skips empty strings in hostnames', () => {
    expect(buildOwnedNames('bridge-1', 'lan', ['', 'valid'])).toEqual(
      new Set(['brokkr.lan', 'bridge-1.lan', 'valid.lan']),
    );
  });
});

describe('resolveQuery per-ingress owned-name answers', () => {
  it('returns a single A record with the listenIp for an owned name', async () => {
    const deps = resolveDeps();
    const response = await resolveQuery(aQueryWire('brokkr.lan'), '10.0.0.1', deps);
    expect(response).not.toBeNull();
    const buf = response!;
    expect(buf.readUInt16BE(6)).toBe(1);
    expect([...buf.subarray(buf.length - 4)]).toEqual([10, 0, 0, 1]);
  });

  it('returns the listenIp of the receiving interface, not a canonical primary', async () => {
    const deps = resolveDeps();
    const response = await resolveQuery(aQueryWire('brokkr.lan'), '172.16.0.1', deps);
    expect(response).not.toBeNull();
    const buf = response!;
    expect(buf.readUInt16BE(6)).toBe(1);
    expect([...buf.subarray(buf.length - 4)]).toEqual([172, 16, 0, 1]);
  });

  it('qtype!=A still returns empty-noerror for an owned name', async () => {
    const deps = resolveDeps();
    const aaaaQuery = aQueryWire('brokkr.lan');
    aaaaQuery.writeUInt16BE(28, aaaaQuery.length - 4);
    const response = await resolveQuery(aaaaQuery, '10.0.0.1', deps);
    expect(response).not.toBeNull();
    expect(response!.readUInt16BE(6)).toBe(0);
    expect(rcode(response!)).toBe(0);
  });
});

function rcode(response: Buffer): number {
  return response.readUInt16BE(2) & 0x0f;
}

function resolveDeps(overrides: Partial<ResolveDeps> = {}): ResolveDeps {
  return {
    owned: new Set(['brokkr.lan']),
    authoritativeSuffix: '.lan',
    ttlSeconds: 60,
    upstreams: ['1.1.1.1'],
    timeoutMs: 100,
    forward: async () => Buffer.from('upstream'),
    affinity: { udp: -1, tcp: -1 },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    jobId: 'job-1',
    recordsLookup: null,
    ...overrides,
  };
}

describe('resolveQuery rcode dispatch', () => {
  it('returns NXDOMAIN for an unknown *.lan name without forwarding', async () => {
    const forward = vi.fn(async () => Buffer.from('upstream'));
    const response = await resolveQuery(aQueryWire('unknown.lan'), '10.0.0.1', resolveDeps({ forward }));
    expect(response).not.toBeNull();
    expect(rcode(response!)).toBe(3);
    expect(forward).not.toHaveBeenCalled();
  });

  it('returns SERVFAIL when the forwarder throws ForwardError', async () => {
    const forward = vi.fn(async () => {
      throw new ForwardError('all upstreams failed');
    });
    const response = await resolveQuery(aQueryWire('example.com'), '10.0.0.1', resolveDeps({ forward }));
    expect(rcode(response!)).toBe(2);
  });

  it('drops a malformed query (returns null, no response)', async () => {
    const response = await resolveQuery(Buffer.from([0x12, 0x34]), '10.0.0.1', resolveDeps());
    expect(response).toBeNull();
  });

  it('returns NOTIMP for an IQUERY (opcode=1) on an owned name, without forwarding', async () => {
    const forward = vi.fn(async () => Buffer.from('upstream'));
    const iquery = aQueryWire('brokkr.lan');
    iquery.writeUInt16BE(0x0900, 2);
    const response = await resolveQuery(iquery, '10.9.9.9', resolveDeps({ forward }));
    expect(response).not.toBeNull();
    expect(rcode(response!)).toBe(4);
    expect(forward).not.toHaveBeenCalled();
  });

  it('leaves a standard A query (opcode=0) unaffected', async () => {
    const response = await resolveQuery(aQueryWire('brokkr.lan'), '10.9.9.9', resolveDeps());
    expect(rcode(response!)).toBe(0);
    expect([...response!.subarray(response!.length - 4)]).toEqual([10, 9, 9, 9]);
  });

  it('answers an owned-name A query with listenIp, never forwarding', async () => {
    const forward = vi.fn(async () => Buffer.from('upstream'));
    const response = await resolveQuery(aQueryWire('brokkr.lan'), '10.9.9.9', resolveDeps({ forward }));
    expect(response).not.toBeNull();
    const buf = response!;
    expect([...buf.subarray(buf.length - 4)]).toEqual([10, 9, 9, 9]);
    expect(forward).not.toHaveBeenCalled();
  });

  it('self-answers an owned-name A query only when QCLASS=IN', async () => {
    const forward = vi.fn(async () => Buffer.from('upstream'));
    const response = await resolveQuery(aQueryWireClass('brokkr.lan', 1), '10.9.9.9', resolveDeps({ forward }));
    expect(response).not.toBeNull();
    expect([...response!.subarray(response!.length - 4)]).toEqual([10, 9, 9, 9]);
    expect(forward).not.toHaveBeenCalled();
  });

  it('forwards (does not self-answer) an owned-name query with QCLASS=CH', async () => {
    const upstream = Buffer.from('upstream-reply');
    const forward = vi.fn(async () => upstream);
    const response = await resolveQuery(aQueryWireClass('brokkr.lan', 3), '10.9.9.9', resolveDeps({ forward }));
    expect(forward).toHaveBeenCalledTimes(1);
    expect(response!.equals(upstream)).toBe(true);
  });

  it('forwards (does not synthesize NXDOMAIN) a *.lan query with QCLASS=CH', async () => {
    const upstream = Buffer.from('upstream-reply');
    const forward = vi.fn(async () => upstream);
    const response = await resolveQuery(aQueryWireClass('unknown.lan', 3), '10.0.0.1', resolveDeps({ forward }));
    expect(forward).toHaveBeenCalledTimes(1);
    expect(response!.equals(upstream)).toBe(true);
  });

  it('returns a question-less NOTIMP for a QDCOUNT=0 IQUERY (empty question section)', async () => {
    const forward = vi.fn(async () => Buffer.from('upstream'));
    const iquery = Buffer.alloc(12);
    iquery.writeUInt16BE(0x1234, 0);
    iquery.writeUInt16BE(0x0800, 2);
    const response = await resolveQuery(iquery, '10.9.9.9', resolveDeps({ forward }));
    expect(response).not.toBeNull();
    expect(rcode(response!)).toBe(4);
    expect(response!.readUInt16BE(0)).toBe(0x1234);
    expect((response!.readUInt16BE(2) >> 11) & 0x0f).toBe(1);
    expect(response!.readUInt16BE(2) & 0x8000).toBe(0x8000);
    expect(response!.length).toBe(12);
    expect(response!.readUInt16BE(4)).toBe(0);
    expect(forward).not.toHaveBeenCalled();
  });

  it('still drops a QDCOUNT=0 *standard* query (opcode 0, genuinely malformed)', async () => {
    const forward = vi.fn(async () => Buffer.from('upstream'));
    const malformed = Buffer.alloc(12);
    malformed.writeUInt16BE(0x1234, 0);
    malformed.writeUInt16BE(0x0000, 2);
    const response = await resolveQuery(malformed, '10.9.9.9', resolveDeps({ forward }));
    expect(response).toBeNull();
    expect(forward).not.toHaveBeenCalled();
  });

  it('drops an inbound DNS response (QR=1, opcode=1) without emitting NOTIMP', async () => {
    const forward = vi.fn(async () => Buffer.from('upstream'));
    const responsePkt = Buffer.alloc(12);
    responsePkt.writeUInt16BE(0x1234, 0);
    responsePkt.writeUInt16BE(0x8800, 2);
    const response = await resolveQuery(responsePkt, '10.9.9.9', resolveDeps({ forward }));
    expect(response).toBeNull();
    expect(forward).not.toHaveBeenCalled();
  });

  it('drops a QR=1 response carrying a question section without emitting NOTIMP', async () => {
    const forward = vi.fn(async () => Buffer.from('upstream'));
    const responsePkt = aQueryWire('brokkr.lan');
    responsePkt.writeUInt16BE(0x8800, 2);
    const response = await resolveQuery(responsePkt, '10.9.9.9', resolveDeps({ forward }));
    expect(response).toBeNull();
    expect(forward).not.toHaveBeenCalled();
  });
});

describe('resolveQuery recursion source gating', () => {
  it('drops an out-of-zone query from a non-private source (no forward, no response)', async () => {
    const forward = vi.fn(async () => Buffer.from('upstream'));
    const response = await resolveQuery(aQueryWire('example.com'), '10.0.0.1', resolveDeps({ forward }), '8.8.8.8');
    expect(response).toBeNull();
    expect(forward).not.toHaveBeenCalled();
  });

  it('forwards an out-of-zone query from a private (RFC1918) source', async () => {
    const upstream = Buffer.from('upstream-bytes');
    const forward = vi.fn(async () => upstream);
    const response = await resolveQuery(aQueryWire('example.com'), '10.0.0.1', resolveDeps({ forward }), '10.0.0.9');
    expect(forward).toHaveBeenCalledTimes(1);
    expect(response!.equals(upstream)).toBe(true);
  });

  it('answers an owned name even to a non-private source (owned is resolved before the gate)', async () => {
    const forward = vi.fn(async () => Buffer.from('upstream'));
    const response = await resolveQuery(aQueryWire('brokkr.lan'), '10.0.0.1', resolveDeps({ forward }), '203.0.113.7');
    expect(response).not.toBeNull();
    expect(forward).not.toHaveBeenCalled();
  });

  it('forwards an out-of-zone query from a non-private source inside a served subnet', async () => {
    const upstream = Buffer.from('upstream-bytes');
    const forward = vi.fn(async () => upstream);
    const response = await resolveQuery(
      aQueryWire('example.com'),
      '203.0.113.1',
      resolveDeps({ forward, servedCidrs: () => ['203.0.113.0/26'] }),
      '203.0.113.7',
    );
    expect(forward).toHaveBeenCalledTimes(1);
    expect(response!.equals(upstream)).toBe(true);
  });

  it('drops an out-of-zone query from a non-private source outside every served subnet', async () => {
    const forward = vi.fn(async () => Buffer.from('upstream'));
    const response = await resolveQuery(
      aQueryWire('example.com'),
      '203.0.113.1',
      resolveDeps({ forward, servedCidrs: () => ['203.0.113.0/26'] }),
      '198.51.100.9',
    );
    expect(response).toBeNull();
    expect(forward).not.toHaveBeenCalled();
  });

  it('does not gate when no source is supplied (trusted/internal caller)', async () => {
    const upstream = Buffer.from('upstream-bytes');
    const forward = vi.fn(async () => upstream);
    const response = await resolveQuery(aQueryWire('example.com'), '10.0.0.1', resolveDeps({ forward }));
    expect(forward).toHaveBeenCalledTimes(1);
    expect(response!.equals(upstream)).toBe(true);
  });
});

describe('DnsServerService served-cidr recursion wiring', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('forwards recursion for a public source inside a served cidr and follows live cidr updates', async () => {
    vi.useFakeTimers();
    let cidrs: string[] = ['203.0.113.0/26'];
    const forward = vi.fn(async () => oversizeResponse('example.com', 1));
    const sockets: FakeSocket[] = [];
    const service = new DnsServerService({
      config: makeConfig(),
      listInterfaces: () => [{ interface: 'eth0', ip: '203.0.113.1' }],
      listServedCidrs: () => cidrs,
      createSocket: () => {
        const s = makeFakeSocket();
        sockets.push(s);
        return s as unknown as dgram.Socket;
      },
      forward,
      createTcpServer: () => makeFakeTcpServer(),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    const start = service.start('job-1');
    await flush();

    const rinfo: dgram.RemoteInfo = { address: '203.0.113.7', port: 5353, family: 'IPv4', size: 0 };
    sockets[0].emitMessage(aQueryWire('example.com'), rinfo);
    await flush();
    expect(forward).toHaveBeenCalledTimes(1);
    expect(sockets[0].send).toHaveBeenCalledTimes(1);

    cidrs = [];
    sockets[0].emitMessage(aQueryWire('example.org'), rinfo);
    await flush();
    expect(forward).toHaveBeenCalledTimes(1);
    expect(sockets[0].send).toHaveBeenCalledTimes(1);

    service.stop('job-1');
    await expect(start).resolves.toBeUndefined();
  });
});

describe('resolveQuery forward-cache class gating', () => {
  it('does not cache a CH-class forwarded reply (re-forwards on repeat)', async () => {
    const cache = new DnsCache({ capacity: 16 });
    const upstream = aResponse('example.com', '5.6.7.8', 300);
    const forward = vi.fn(async () => upstream);
    const deps = resolveDeps({ forward, cache });

    await resolveQuery(aQueryWireClass('example.com', 3), '10.0.0.1', deps);
    await resolveQuery(aQueryWireClass('example.com', 3), '10.0.0.1', deps);

    expect(forward).toHaveBeenCalledTimes(2);
    expect(cache.size).toBe(0);
  });

  it('caches an IN-class forwarded reply (serves the 2nd from cache)', async () => {
    const cache = new DnsCache({ capacity: 16 });
    const upstream = aResponse('example.com', '5.6.7.8', 300);
    const forward = vi.fn(async () => upstream);
    const deps = resolveDeps({ forward, cache });

    await resolveQuery(aQueryWire('example.com'), '10.0.0.1', deps);
    const second = await resolveQuery(aQueryWire('example.com'), '10.0.0.1', deps);

    expect(forward).toHaveBeenCalledTimes(1);
    expect(cache.size).toBe(1);
    expect(rcode(second!)).toBe(0);
  });

  it('never serves a CH reply to a later IN query (no cross-class collision)', async () => {
    const cache = new DnsCache({ capacity: 16 });
    const chReply = aResponse('example.com', '9.9.9.9', 300);
    const inReply = aResponse('example.com', '5.6.7.8', 300);
    const forward = vi.fn(async (q: Buffer) => {
      const qclass = q.readUInt16BE(q.length - 2);
      return qclass === 1 ? inReply : chReply;
    });
    const deps = resolveDeps({ forward, cache });

    await resolveQuery(aQueryWireClass('example.com', 3), '10.0.0.1', deps);
    const inResponse = await resolveQuery(aQueryWire('example.com'), '10.0.0.1', deps);

    expect(forward).toHaveBeenCalledTimes(2);
    expect([...inResponse!.subarray(inResponse!.length - 4)]).toEqual([5, 6, 7, 8]);
  });
});

const FLAG_TC_BIT = 0x0200;

function oversizeResponse(qname: string, nAnswers: number): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0x1234, 0);
  header.writeUInt16BE(FLAG_QR_RESPONSE, 2);
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(nAnswers, 6);
  const answers: Buffer[] = [];
  for (let i = 0; i < nAnswers; i++) answers.push(aRecord(qname, `10.0.0.${i % 256}`, 60));
  return Buffer.concat([header, questionSection(qname), ...answers]);
}

describe('handleMessage UDP truncation (RFC 1035 §4.2.1)', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('truncates a >512-byte forwarded answer on UDP egress: <=512, TC=1, question preserved', async () => {
    vi.useFakeTimers();
    const big = oversizeResponse('example.com', 40);
    expect(big.length).toBeGreaterThan(512);
    const sockets: FakeSocket[] = [];
    const service = new DnsServerService({
      config: makeConfig(),
      listInterfaces: () => [{ interface: 'eth0', ip: '10.0.0.1' }],
      createSocket: () => {
        const s = makeFakeSocket();
        sockets.push(s);
        return s as unknown as dgram.Socket;
      },
      forward: async () => big,
      createTcpServer: () => makeFakeTcpServer(),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    const start = service.start('job-1');
    await flush();

    const rinfo: dgram.RemoteInfo = { address: '10.0.0.50', port: 5353, family: 'IPv4', size: 0 };
    sockets[0].emitMessage(aQueryWire('example.com'), rinfo);
    await flush();

    expect(sockets[0].send).toHaveBeenCalledTimes(1);
    const sent: Buffer = sockets[0].send.mock.calls[0][0];
    expect(sent.length).toBeLessThanOrEqual(512);
    expect(sent.readUInt16BE(2) & FLAG_TC_BIT).toBeTruthy();
    expect(sent.readUInt16BE(6)).toBe(0);
    expect(sent.readUInt16BE(4)).toBe(1);
    expect(sent.subarray(12).equals(questionSection('example.com'))).toBe(true);

    service.stop('job-1');
    await expect(start).resolves.toBeUndefined();
  });

  it('sends a <=512 forwarded answer verbatim (no TC, full answer)', async () => {
    vi.useFakeTimers();
    const small = oversizeResponse('example.com', 1);
    expect(small.length).toBeLessThanOrEqual(512);
    const sockets: FakeSocket[] = [];
    const service = new DnsServerService({
      config: makeConfig(),
      listInterfaces: () => [{ interface: 'eth0', ip: '10.0.0.1' }],
      createSocket: () => {
        const s = makeFakeSocket();
        sockets.push(s);
        return s as unknown as dgram.Socket;
      },
      forward: async () => small,
      createTcpServer: () => makeFakeTcpServer(),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    const start = service.start('job-1');
    await flush();
    sockets[0].emitMessage(aQueryWire('example.com'), {
      address: '10.0.0.50',
      port: 5353,
      family: 'IPv4',
      size: 0,
    });
    await flush();

    const sent: Buffer = sockets[0].send.mock.calls[0][0];
    expect(sent.equals(small)).toBe(true);
    expect(sent.readUInt16BE(2) & FLAG_TC_BIT).toBeFalsy();

    service.stop('job-1');
    await expect(start).resolves.toBeUndefined();
  });

  it('resolveQuery returns the full >512 answer untruncated (TCP path, TC=0)', async () => {
    const big = oversizeResponse('example.com', 40);
    const deps = makeResolveDeps({ forward: async () => big });
    const out = await resolveQuery(aQueryWire('example.com'), '10.0.0.1', deps);
    expect(out!.length).toBe(big.length);
    expect(out!.readUInt16BE(2) & FLAG_TC_BIT).toBeFalsy();
    expect(out!.readUInt16BE(6)).toBe(40);
  });
});

interface ErrorAwareSocket {
  on: ReturnType<typeof vi.fn>;
  once: ReturnType<typeof vi.fn>;
  removeListener: ReturnType<typeof vi.fn>;
  bind: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  emitMessage(msg: Buffer, rinfo: dgram.RemoteInfo): void;
  emitRuntimeError(err: Error): void;
}

function makeErrorAwareSocket(failBind = false): ErrorAwareSocket {
  let messageHandler: ((msg: Buffer, rinfo: dgram.RemoteInfo) => void) | null = null;
  let runtimeErrorHandler: ((err: Error) => void) | null = null;
  const socket: ErrorAwareSocket = {
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (event === 'message') messageHandler = handler as (msg: Buffer, rinfo: dgram.RemoteInfo) => void;
      else if (event === 'error') runtimeErrorHandler = handler as (err: Error) => void;
    }),
    once: vi.fn((event: string, handler: (err: Error) => void) => {
      if (event === 'error' && failBind) queueMicrotask(() => handler(new Error('EADDRINUSE')));
    }),
    removeListener: vi.fn(),
    bind: vi.fn((_port: number, _ip: string, cb: () => void) => {
      if (!failBind) cb();
    }),
    send: vi.fn(),
    close: vi.fn(),
    emitMessage: (msg, rinfo) => messageHandler?.(msg, rinfo),
    emitRuntimeError: (err) => runtimeErrorHandler?.(err),
  };
  return socket;
}

function responseWire(name: string): Buffer {
  const packet = aQueryWire(name);
  packet.writeUInt16BE(packet.readUInt16BE(2) | 0x8000, 2);
  return packet;
}

describe('DnsServerService per-socket error paths', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function buildWith(
    createSocket: () => ErrorAwareSocket,
    logger: ResolveDeps['logger'],
  ): { service: DnsServerService } {
    const service = new DnsServerService({
      config: makeConfig(),
      listInterfaces: () => INTERFACES,
      createSocket: () => createSocket() as unknown as dgram.Socket,
      createTcpServer: () => makeFakeTcpServer(),
      logger,
    });
    return { service };
  }

  it('logs and continues when one interface socket fails to bind', async () => {
    vi.useFakeTimers();
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    let created = 0;
    const { service } = buildWith(() => makeErrorAwareSocket(created++ === 0), logger);

    const start = service.start('job-1');
    await flush();

    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('DNS bind failed on eth0 10.0.0.1:53'), {
      jobId: 'job-1',
    });
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('DNS listening on eth1 172.16.0.1:53'), {
      jobId: 'job-1',
    });

    service.stop('job-1');
    await expect(start).resolves.toBeUndefined();
  });

  it('logs (does not throw) a runtime socket error after a successful bind', async () => {
    vi.useFakeTimers();
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const sockets: ErrorAwareSocket[] = [];
    const { service } = buildWith(() => {
      const s = makeErrorAwareSocket();
      sockets.push(s);
      return s;
    }, logger);

    const start = service.start('job-1');
    await flush();

    expect(() => sockets[0].emitRuntimeError(new Error('ECONNREFUSED'))).not.toThrow();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('DNS socket error on 10.0.0.1'), {
      jobId: 'job-1',
    });

    service.stop('job-1');
    await expect(start).resolves.toBeUndefined();
  });

  it('does not send a response for a malformed packet', async () => {
    vi.useFakeTimers();
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const sockets: ErrorAwareSocket[] = [];
    const { service } = buildWith(() => {
      const s = makeErrorAwareSocket();
      sockets.push(s);
      return s;
    }, logger);

    const start = service.start('job-1');
    await flush();

    const rinfo: dgram.RemoteInfo = { address: '10.0.0.9', port: 5353, family: 'IPv4', size: 0 };
    sockets[0].emitMessage(Buffer.from([0x12, 0x34]), rinfo);
    await flush();

    expect(sockets[0].send).not.toHaveBeenCalled();
    service.stop('job-1');
    await expect(start).resolves.toBeUndefined();
  });

  it('does not send a response for a QR=1 (response) packet', async () => {
    vi.useFakeTimers();
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const sockets: ErrorAwareSocket[] = [];
    const { service } = buildWith(() => {
      const s = makeErrorAwareSocket();
      sockets.push(s);
      return s;
    }, logger);

    const start = service.start('job-1');
    await flush();

    const rinfo: dgram.RemoteInfo = { address: '10.0.0.9', port: 5353, family: 'IPv4', size: 0 };
    sockets[0].emitMessage(responseWire('brokkr.lan'), rinfo);
    await flush();

    expect(sockets[0].send).not.toHaveBeenCalled();
    service.stop('job-1');
    await expect(start).resolves.toBeUndefined();
  });

  it('logs (does not throw) when socket.send invokes its callback with an error', async () => {
    vi.useFakeTimers();
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const sockets: ErrorAwareSocket[] = [];
    const { service } = buildWith(() => {
      const s = makeErrorAwareSocket();
      s.send.mockImplementation((_m: Buffer, _p: number, _a: string, cb: (e: Error | null) => void) =>
        cb(new Error('send failed')),
      );
      sockets.push(s);
      return s;
    }, logger);

    const start = service.start('job-1');
    await flush();

    const rinfo: dgram.RemoteInfo = { address: '10.0.0.9', port: 5353, family: 'IPv4', size: 0 };
    sockets[0].emitMessage(aQueryWire('brokkr.lan'), rinfo);
    await flush();

    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('DNS send to 10.0.0.9:5353 failed'), {
      jobId: 'job-1',
    });
    service.stop('job-1');
    await expect(start).resolves.toBeUndefined();
  });
});

const QTYPE_AAAA = 28;
const QTYPE_PTR = 12;

function aaaaQueryWire(name: string): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0x1234, 0);
  header.writeUInt16BE(0x0100, 2);
  header.writeUInt16BE(1, 4);
  const labels: Buffer[] = [];
  for (const part of name.split('.')) {
    labels.push(Buffer.from([part.length]), Buffer.from(part, 'ascii'));
  }
  labels.push(Buffer.from([0]));
  const qtail = Buffer.alloc(4);
  qtail.writeUInt16BE(QTYPE_AAAA, 0);
  qtail.writeUInt16BE(QCLASS_IN, 2);
  return Buffer.concat([header, ...labels, qtail]);
}

function ptrQueryWire(name: string): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0x1234, 0);
  header.writeUInt16BE(0x0100, 2);
  header.writeUInt16BE(1, 4);
  const labels: Buffer[] = [];
  for (const part of name.split('.')) {
    labels.push(Buffer.from([part.length]), Buffer.from(part, 'ascii'));
  }
  labels.push(Buffer.from([0]));
  const qtail = Buffer.alloc(4);
  qtail.writeUInt16BE(QTYPE_PTR, 0);
  qtail.writeUInt16BE(QCLASS_IN, 2);
  return Buffer.concat([header, ...labels, qtail]);
}

function makeTestAtom(overrides: Partial<DnsRecordsAtomValue> = {}): DnsRecordsAtomValue {
  return {
    domains: [],
    ...overrides,
  };
}

function resolveDepsWithRecords(atom: DnsRecordsAtomValue, overrides: Partial<ResolveDeps> = {}): ResolveDeps {
  return {
    owned: new Set(['brokkr.lan']),
    authoritativeSuffix: '.lan',
    ttlSeconds: 60,
    upstreams: ['1.1.1.1'],
    timeoutMs: 100,
    forward: async () => Buffer.from('upstream'),
    affinity: { udp: -1, tcp: -1 },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    jobId: 'job-1',
    recordsLookup: new DnsRecordsLookup(atom),
    ...overrides,
  };
}

describe('resolveQuery records-atom integration', () => {
  it('returns A response from records lookup when available', async () => {
    const atom = makeTestAtom({
      domains: [
        {
          name: 'example.lan',
          type: 'FORWARD',
          records: [{ name: 'web', type: 'A', value: '10.0.1.50', ttl: null }],
        },
      ],
    });
    const forward = vi.fn(async () => Buffer.from('upstream'));
    const deps = resolveDepsWithRecords(atom, { forward });

    const response = await resolveQuery(aQueryWire('web.example.lan'), '10.0.0.1', deps);

    expect(response).not.toBeNull();
    expect(response!.readUInt16BE(6)).toBe(1);
    expect([...response!.subarray(response!.length - 4)]).toEqual([10, 0, 1, 50]);
    expect(forward).not.toHaveBeenCalled();
  });

  it('returns AAAA response from records lookup', async () => {
    const atom = makeTestAtom({
      domains: [
        {
          name: 'example.lan',
          type: 'FORWARD',
          records: [{ name: 'v6host', type: 'AAAA', value: '2001:db8::1', ttl: null }],
        },
      ],
    });
    const forward = vi.fn(async () => Buffer.from('upstream'));
    const deps = resolveDepsWithRecords(atom, { forward });

    const query = aaaaQueryWire('v6host.example.lan');
    const response = await resolveQuery(query, '10.0.0.1', deps);

    expect(response).not.toBeNull();
    expect(response!.readUInt16BE(6)).toBe(1);
    const questionLen = query.length - 12;
    const answerStart = 12 + questionLen;
    expect(response!.readUInt16BE(answerStart + 2)).toBe(QTYPE_AAAA);
    expect(response!.readUInt16BE(answerStart + 10)).toBe(16);
    expect(forward).not.toHaveBeenCalled();
  });

  it('returns PTR response from records lookup', async () => {
    const atom = makeTestAtom({
      domains: [
        {
          name: '1.0.10.in-addr.arpa',
          type: 'REVERSE',
          records: [{ name: '50', type: 'PTR', value: 'web.example.lan', ttl: null }],
        },
      ],
    });
    const forward = vi.fn(async () => Buffer.from('upstream'));
    const deps = resolveDepsWithRecords(atom, { forward });

    const response = await resolveQuery(ptrQueryWire('50.1.0.10.in-addr.arpa'), '10.0.0.1', deps);

    expect(response).not.toBeNull();
    expect(response!.readUInt16BE(6)).toBe(1);
    expect(forward).not.toHaveBeenCalled();
  });

  it('returns empty-noerror when name exists in records with a different type', async () => {
    const atom = makeTestAtom({
      domains: [
        {
          name: 'example.lan',
          type: 'FORWARD',
          records: [{ name: 'dual', type: 'A', value: '10.0.1.50', ttl: null }],
        },
      ],
    });
    const forward = vi.fn(async () => Buffer.from('upstream'));
    const deps = resolveDepsWithRecords(atom, { forward });

    const response = await resolveQuery(aaaaQueryWire('dual.example.lan'), '10.0.0.1', deps);

    expect(response).not.toBeNull();
    expect(response!.readUInt16BE(6)).toBe(0);
    expect(rcode(response!)).toBe(0);
    expect(forward).not.toHaveBeenCalled();
  });

  it('falls through to forwarding when recordsLookup is null', async () => {
    const upstream = aResponse('example.com', '93.184.216.34', 300);
    const forward = vi.fn(async () => upstream);
    const deps = resolveDepsWithRecords(makeTestAtom(), { forward, recordsLookup: null });

    const response = await resolveQuery(aQueryWire('example.com'), '10.0.0.1', deps);

    expect(forward).toHaveBeenCalledTimes(1);
    expect(response!.equals(upstream)).toBe(true);
  });

  it('prefers records lookup over hardcoded .lan owned names', async () => {
    const atom = makeTestAtom({
      domains: [
        {
          name: 'lan',
          type: 'FORWARD',
          records: [{ name: 'brokkr', type: 'A', value: '10.99.99.99', ttl: null }],
        },
      ],
    });
    const forward = vi.fn(async () => Buffer.from('upstream'));
    const deps = resolveDepsWithRecords(atom, { forward });

    const response = await resolveQuery(aQueryWire('brokkr.lan'), '10.0.0.1', deps);

    expect(response).not.toBeNull();
    expect([...response!.subarray(response!.length - 4)]).toEqual([10, 99, 99, 99]);
    expect(forward).not.toHaveBeenCalled();
  });

  it('still answers owned .lan names when recordsLookup is null', async () => {
    const forward = vi.fn(async () => Buffer.from('upstream'));
    const deps = resolveDepsWithRecords(makeTestAtom(), { forward, recordsLookup: null });

    const response = await resolveQuery(aQueryWire('brokkr.lan'), '10.0.0.1', deps);

    expect(response).not.toBeNull();
    expect([...response!.subarray(response!.length - 4)]).toEqual([10, 0, 0, 1]);
    expect(forward).not.toHaveBeenCalled();
  });

  it('returns NXDOMAIN for nonexistent name under an atom-managed domain', async () => {
    const atom = makeTestAtom({
      domains: [
        {
          name: 'example.lan',
          type: 'FORWARD',
          records: [{ name: 'web', type: 'A', value: '10.0.1.50', ttl: null }],
        },
      ],
    });
    const forward = vi.fn(async () => Buffer.from('upstream'));
    const deps = resolveDepsWithRecords(atom, {
      forward,
      recordsDomains: new Set(['example.lan']),
    });

    const response = await resolveQuery(aQueryWire('nonexistent.example.lan'), '10.0.0.1', deps);

    expect(response).not.toBeNull();
    expect(rcode(response!)).toBe(3);
    expect(response!.readUInt16BE(6)).toBe(0);
    expect(forward).not.toHaveBeenCalled();
  });

  it('answers owned brokkr.lan with listenIp even when recordsDomains includes lan', async () => {
    const atom = makeTestAtom({
      domains: [
        {
          name: 'lan',
          type: 'FORWARD',
          records: [{ name: 'server-1', type: 'A', value: '10.0.1.10', ttl: null }],
        },
      ],
    });
    const forward = vi.fn(async () => Buffer.from('upstream'));
    const deps = resolveDepsWithRecords(atom, {
      forward,
      recordsDomains: new Set(['lan']),
    });

    const response = await resolveQuery(aQueryWire('brokkr.lan'), '10.0.0.1', deps);

    expect(response).not.toBeNull();
    expect(rcode(response!)).toBe(0);
    expect([...response!.subarray(response!.length - 4)]).toEqual([10, 0, 0, 1]);
    expect(forward).not.toHaveBeenCalled();
  });

  it('returns NXDOMAIN for non-owned unknown.lan when recordsDomains includes lan', async () => {
    const atom = makeTestAtom({
      domains: [
        {
          name: 'lan',
          type: 'FORWARD',
          records: [{ name: 'server-1', type: 'A', value: '10.0.1.10', ttl: null }],
        },
      ],
    });
    const forward = vi.fn(async () => Buffer.from('upstream'));
    const deps = resolveDepsWithRecords(atom, {
      forward,
      recordsDomains: new Set(['lan']),
    });

    const response = await resolveQuery(aQueryWire('unknown.lan'), '10.0.0.1', deps);

    expect(response).not.toBeNull();
    expect(rcode(response!)).toBe(3);
    expect(forward).not.toHaveBeenCalled();
  });
});

describe('DnsServerService records refresh on reconcile', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('serves updated records after a reconcile tick without requiring interface changes', async () => {
    vi.useFakeTimers();
    let readCount = 0;
    const atomV1 = makeTestAtom({
      domains: [
        {
          name: 'example.lan',
          type: 'FORWARD',
          records: [{ name: 'web', type: 'A', value: '10.0.1.50', ttl: null }],
        },
      ],
    });
    const atomV2 = makeTestAtom({
      domains: [
        {
          name: 'example.lan',
          type: 'FORWARD',
          records: [{ name: 'web', type: 'A', value: '10.0.1.99', ttl: null }],
        },
      ],
    });

    const sockets: FakeSocket[] = [];
    const service = new DnsServerService({
      config: makeConfig(),
      listInterfaces: () => [{ interface: 'eth0', ip: '10.0.0.1' }],
      createSocket: () => {
        const s = makeFakeSocket();
        sockets.push(s);
        return s as unknown as dgram.Socket;
      },
      readRecords: async () => {
        readCount += 1;
        const atom = readCount <= 1 ? atomV1 : atomV2;
        return {
          lookup: new DnsRecordsLookup(atom),
          domains: new Set(atom.domains.map((d) => d.name)),
        };
      },
      createTcpServer: () => makeFakeTcpServer(),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    const start = service.start('job-1');
    await flush();
    expect(sockets).toHaveLength(1);

    const rinfo: dgram.RemoteInfo = { address: '10.0.0.50', port: 5353, family: 'IPv4', size: 0 };
    sockets[0].emitMessage(aQueryWire('web.example.lan'), rinfo);
    await flush();
    expect(sockets[0].send).toHaveBeenCalledTimes(1);
    expect([...(sockets[0].send.mock.calls[0][0] as Buffer).subarray(-4)]).toEqual([10, 0, 1, 50]);

    await vi.advanceTimersByTimeAsync(POLL_MS);
    await flush();

    sockets[0].send.mockClear();
    sockets[0].emitMessage(aQueryWire('web.example.lan'), rinfo);
    await flush();
    expect(sockets[0].send).toHaveBeenCalledTimes(1);
    expect([...(sockets[0].send.mock.calls[0][0] as Buffer).subarray(-4)]).toEqual([10, 0, 1, 99]);

    service.stop('job-1');
    await expect(start).resolves.toBeUndefined();
  });
});

describe('DnsServerService hub-config enabled toggle', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function makeAtom(overrides: Partial<DnsConfigAtomValue> = {}): DnsConfigAtomValue {
    return {
      enabled: true,
      upstreamResolvers: ['1.1.1.1'],
      ttlSeconds: 60,
      cacheSize: 0,
      ownedDomain: 'lan',
      hostnames: [],
      pollMs: POLL_MS,
      ...overrides,
    };
  }

  it('does not re-open sockets after maybeRefreshConfig disables DNS', async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    let readCount = 0;
    const configReader: Pick<DnsConfigReaderService, 'readZoneConfig' | 'readPrefixOverrides'> = {
      readZoneConfig: async (): Promise<DnsZoneConfigReadResult> => {
        readCount++;
        if (readCount === 1) return { ok: false, reason: 'missing' };
        return { ok: true, config: makeAtom({ enabled: false }) };
      },
      readPrefixOverrides: async (): Promise<DnsPrefixOverrideReadResult> => ({ ok: true, overrides: new Map() }),
    };

    const service = new DnsServerService({
      config: makeConfig(),
      listInterfaces: () => INTERFACES,
      createSocket: () => {
        const s = makeFakeSocket();
        sockets.push(s);
        return s as unknown as dgram.Socket;
      },
      createTcpServer: () => makeFakeTcpServer(),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      configReader: configReader as DnsConfigReaderService,
    });

    const start = service.start('job-1');
    await flush();
    expect(sockets).toHaveLength(2);
    expect(sockets[0].close).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(POLL_MS);
    await flush();

    expect(sockets[0].close).toHaveBeenCalledTimes(1);
    expect(sockets[1].close).toHaveBeenCalledTimes(1);

    const socketsAfterDisable = sockets.length;
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await flush();
    expect(sockets.length).toBe(socketsAfterDisable);

    service.stop('job-1');
    await expect(start).resolves.toBeUndefined();
  });

  it('re-opens sockets when DNS is re-enabled via atom after being disabled', async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    let readCount = 0;
    const configReader: Pick<DnsConfigReaderService, 'readZoneConfig' | 'readPrefixOverrides'> = {
      readZoneConfig: async (): Promise<DnsZoneConfigReadResult> => {
        readCount++;
        if (readCount <= 1) return { ok: false, reason: 'missing' };
        if (readCount === 2) return { ok: true, config: makeAtom({ enabled: false }) };
        return { ok: true, config: makeAtom({ enabled: true }) };
      },
      readPrefixOverrides: async (): Promise<DnsPrefixOverrideReadResult> => ({ ok: true, overrides: new Map() }),
    };

    const service = new DnsServerService({
      config: makeConfig(),
      listInterfaces: () => INTERFACES,
      createSocket: () => {
        const s = makeFakeSocket();
        sockets.push(s);
        return s as unknown as dgram.Socket;
      },
      createTcpServer: () => makeFakeTcpServer(),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      configReader: configReader as DnsConfigReaderService,
    });

    const start = service.start('job-1');
    await flush();
    expect(sockets).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(POLL_MS);
    await flush();
    expect(sockets[0].close).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(POLL_MS);
    await flush();
    expect(sockets.length).toBe(4);

    service.stop('job-1');
    await expect(start).resolves.toBeUndefined();
  });

  it('closes every UDP and TCP socket when the zone atom is withdrawn (falls back to the disabled baseline)', async () => {
    vi.useFakeTimers();
    const udpSockets: FakeSocket[] = [];
    const tcpServers: FakeTcpServer[] = [];
    let readCount = 0;
    const configReader: Pick<DnsConfigReaderService, 'readZoneConfig' | 'readPrefixOverrides'> = {
      readZoneConfig: async (): Promise<DnsZoneConfigReadResult> => {
        readCount++;
        if (readCount === 1) return { ok: true, config: makeAtom({ enabled: true }) };
        return { ok: false, reason: 'missing' };
      },
      readPrefixOverrides: async (): Promise<DnsPrefixOverrideReadResult> => ({ ok: true, overrides: new Map() }),
    };

    const service = new DnsServerService({
      config: makeConfig({ enabled: false }),
      listInterfaces: () => INTERFACES,
      createSocket: () => {
        const s = makeFakeSocket();
        udpSockets.push(s);
        return s as unknown as dgram.Socket;
      },
      createTcpServer: () => {
        const s = makeFakeTcpServer();
        tcpServers.push(s);
        return s;
      },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      configReader: configReader as DnsConfigReaderService,
    });

    const start = service.start('job-1');
    await flush();
    expect(udpSockets).toHaveLength(2);
    expect(tcpServers).toHaveLength(2);
    expect(tcpServers.every((s) => s.closed)).toBe(false);

    await vi.advanceTimersByTimeAsync(POLL_MS);
    await flush();

    expect(udpSockets.every((s) => s.close.mock.calls.length > 0)).toBe(true);
    expect(tcpServers.every((s) => s.closed)).toBe(true);

    const udpCountAfterWithdrawal = udpSockets.length;
    const tcpCountAfterWithdrawal = tcpServers.length;
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await flush();
    expect(udpSockets.length).toBe(udpCountAfterWithdrawal);
    expect(tcpServers.length).toBe(tcpCountAfterWithdrawal);

    service.stop('job-1');
    await expect(start).resolves.toBeUndefined();
  });

  it('re-arms the reconcile timer at the new cadence when pollMs changes via atom', async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    let readCount = 0;
    const readZoneConfig = vi.fn(async (): Promise<DnsZoneConfigReadResult> => {
      readCount++;
      if (readCount === 1) return { ok: false, reason: 'missing' };
      return { ok: true, config: makeAtom({ pollMs: 250 }) };
    });
    const configReader: Pick<DnsConfigReaderService, 'readZoneConfig' | 'readPrefixOverrides'> = {
      readZoneConfig,
      readPrefixOverrides: async (): Promise<DnsPrefixOverrideReadResult> => ({ ok: true, overrides: new Map() }),
    };

    const service = new DnsServerService({
      config: makeConfig(),
      listInterfaces: () => INTERFACES,
      createSocket: () => {
        const s = makeFakeSocket();
        sockets.push(s);
        return s as unknown as dgram.Socket;
      },
      createTcpServer: () => makeFakeTcpServer(),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      configReader: configReader as DnsConfigReaderService,
    });

    const start = service.start('job-1');
    await flush();
    expect(sockets).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(POLL_MS);
    await flush();

    const before = readZoneConfig.mock.calls.length;
    await vi.advanceTimersByTimeAsync(250);
    await flush();
    expect(readZoneConfig.mock.calls.length).toBe(before + 1);

    await vi.advanceTimersByTimeAsync(750);
    await flush();
    expect(readZoneConfig.mock.calls.length).toBe(before + 4);

    service.stop('job-1');
    await expect(start).resolves.toBeUndefined();
  });

  it('applies per-prefix DNS override upstreamResolvers to the effective config', async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    let readCount = 0;
    const prefixOverrides = new Map<string, DnsPrefixOverrideAtomValue>([
      ['prefix-zzz', { serveDns: true, upstreamOverride: ['9.9.9.9'] }],
      ['prefix-aaa', { serveDns: true, upstreamOverride: ['10.0.99.1'] }],
    ]);
    const configReader: Pick<DnsConfigReaderService, 'readZoneConfig' | 'readPrefixOverrides'> = {
      readZoneConfig: async (): Promise<DnsZoneConfigReadResult> => {
        readCount++;
        if (readCount === 1) return { ok: false, reason: 'missing' };
        return { ok: true, config: makeAtom({ enabled: true, upstreamResolvers: ['1.1.1.1'] }) };
      },
      readPrefixOverrides: async (): Promise<DnsPrefixOverrideReadResult> => {
        if (readCount <= 1) return { ok: true, overrides: new Map() };
        return { ok: true, overrides: prefixOverrides };
      },
    };

    const captured: string[][] = [];
    const service = new DnsServerService({
      config: makeConfig({ upstreamResolvers: ['1.1.1.1'] }),
      listInterfaces: () => [{ interface: 'eth0', ip: '10.0.0.1' }],
      createSocket: () => {
        const s = makeFakeSocket();
        sockets.push(s);
        return s as unknown as dgram.Socket;
      },
      forward: async (_q: Buffer, opts: ForwardOptions): Promise<Buffer> => {
        captured.push([...opts.upstreams]);
        return aResponse('example.com', '93.184.216.34', 60);
      },
      createTcpServer: () => makeFakeTcpServer(),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      configReader: configReader as DnsConfigReaderService,
    });

    const start = service.start('job-1');
    await flush();

    await vi.advanceTimersByTimeAsync(POLL_MS);
    await flush();

    const rinfo: dgram.RemoteInfo = { address: '10.0.0.50', port: 5353, family: 'IPv4', size: 0 };
    sockets[0].emitMessage(aQueryWire('example.com'), rinfo);
    await flush();

    expect(captured.length).toBeGreaterThanOrEqual(1);
    expect(captured[captured.length - 1]).toEqual(['10.0.99.1']);

    service.stop('job-1');
    await expect(start).resolves.toBeUndefined();
  });

  it('ignores surviving prefix overrides when the zone atom is withdrawn', async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const prefixOverrides = new Map<string, DnsPrefixOverrideAtomValue>([
      ['prefix-aaa', { serveDns: true, upstreamOverride: ['10.0.99.1'] }],
    ]);
    const configReader: Pick<DnsConfigReaderService, 'readZoneConfig' | 'readPrefixOverrides'> = {
      readZoneConfig: async (): Promise<DnsZoneConfigReadResult> => ({ ok: false, reason: 'missing' }),
      readPrefixOverrides: async (): Promise<DnsPrefixOverrideReadResult> => ({ ok: true, overrides: prefixOverrides }),
    };

    const captured: string[][] = [];
    const service = new DnsServerService({
      config: makeConfig({ enabled: true, upstreamResolvers: ['1.1.1.1'] }),
      listInterfaces: () => [{ interface: 'eth0', ip: '10.0.0.1' }],
      createSocket: () => {
        const s = makeFakeSocket();
        sockets.push(s);
        return s as unknown as dgram.Socket;
      },
      forward: async (_q: Buffer, opts: ForwardOptions): Promise<Buffer> => {
        captured.push([...opts.upstreams]);
        return aResponse('example.com', '93.184.216.34', 60);
      },
      createTcpServer: () => makeFakeTcpServer(),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      configReader: configReader as DnsConfigReaderService,
    });

    const start = service.start('job-1');
    await flush();
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await flush();

    const rinfo: dgram.RemoteInfo = { address: '10.0.0.50', port: 5353, family: 'IPv4', size: 0 };
    sockets[0].emitMessage(aQueryWire('example.com'), rinfo);
    await flush();

    expect(captured.length).toBeGreaterThanOrEqual(1);
    expect(captured[captured.length - 1]).toEqual(['1.1.1.1']);

    service.stop('job-1');
    await expect(start).resolves.toBeUndefined();
  });

  it('preserves applied prefix overrides when the override read fails transiently', async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    let readCount = 0;
    const prefixOverrides = new Map<string, DnsPrefixOverrideAtomValue>([
      ['prefix-aaa', { serveDns: true, upstreamOverride: ['10.0.99.1'] }],
    ]);
    const configReader: Pick<DnsConfigReaderService, 'readZoneConfig' | 'readPrefixOverrides'> = {
      readZoneConfig: async (): Promise<DnsZoneConfigReadResult> => {
        readCount++;
        return { ok: true, config: makeAtom({ enabled: true, upstreamResolvers: ['1.1.1.1'] }) };
      },
      readPrefixOverrides: async (): Promise<DnsPrefixOverrideReadResult> => {
        if (readCount <= 1) return { ok: true, overrides: prefixOverrides };
        return { ok: false };
      },
    };

    const captured: string[][] = [];
    const service = new DnsServerService({
      config: makeConfig({ upstreamResolvers: ['1.1.1.1'] }),
      listInterfaces: () => [{ interface: 'eth0', ip: '10.0.0.1' }],
      createSocket: () => {
        const s = makeFakeSocket();
        sockets.push(s);
        return s as unknown as dgram.Socket;
      },
      forward: async (_q: Buffer, opts: ForwardOptions): Promise<Buffer> => {
        captured.push([...opts.upstreams]);
        return aResponse('example.com', '93.184.216.34', 60);
      },
      createTcpServer: () => makeFakeTcpServer(),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      configReader: configReader as DnsConfigReaderService,
    });

    const start = service.start('job-1');
    await flush();

    await vi.advanceTimersByTimeAsync(POLL_MS);
    await flush();
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await flush();

    const rinfo: dgram.RemoteInfo = { address: '10.0.0.50', port: 5353, family: 'IPv4', size: 0 };
    sockets[0].emitMessage(aQueryWire('example.com'), rinfo);
    await flush();

    expect(captured.length).toBeGreaterThanOrEqual(1);
    expect(captured[captured.length - 1]).toEqual(['10.0.99.1']);

    service.stop('job-1');
    await expect(start).resolves.toBeUndefined();
  });
});
