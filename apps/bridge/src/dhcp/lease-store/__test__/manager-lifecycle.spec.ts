import * as dgram from 'node:dgram';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  selfInterfaces,
  selfPrimary,
  type NetworkInterface,
  type SelfPrimaryInterface,
} from '../../../bridge-network/self-network.js';
import type { DhcpAtomValue } from '../../dhcp-atom-value.schema.js';
import { DhcpServerService } from '../../dhcp-manager.service.js';
import { DHCPDISCOVER, OPT_END, OPT_MESSAGE_TYPE } from '../../dhcp-options.js';
import type { DhcpRuntimeConfig } from '../../dhcp.config.js';
import { MAGIC_COOKIE, OPTIONS_OFFSET, macToBytes } from '../../protocol.js';
import type { LeaseRecord } from '../lease-record.js';
import type { LeaseStore } from '../lease-store.js';

const SERVER_ID = '10.0.0.1';
const POLL_MS = 2000;
const CLIENT_MAC = '00:0b:82:01:fc:42';

function discoverWire(mac: string): Buffer {
  const head = Buffer.alloc(OPTIONS_OFFSET);
  head[0] = 1;
  head[1] = 1;
  head[2] = 6;
  head.writeUInt32BE(0x3903f326, 4);
  macToBytes(mac).copy(head, 28);
  head.writeUInt32BE(MAGIC_COOKIE, 236);
  return Buffer.concat([head, Buffer.from([OPT_MESSAGE_TYPE, 1, DHCPDISCOVER, OPT_END])]);
}

const RINFO: dgram.RemoteInfo = { address: '0.0.0.0', family: 'IPv4', port: 68, size: 0 };

const INTERFACES: NetworkInterface[] = [
  {
    name: 'eth0',
    ip: SERVER_ID,
    netmask: '255.255.255.0',
    prefix: 24,
    network: '10.0.0.0/24',
    isPrimary: true,
    interfaceType: 'physical',
  },
];

function makeRuntimeConfig(): DhcpRuntimeConfig {
  return {
    leaderPollMs: POLL_MS,
    pruneIntervalMs: 60000,
    declineBackoffSeconds: 600,
  };
}

function makeAtom(): DhcpAtomValue {
  return {
    mode: 'AUTHORITATIVE',
    subnet: '10.0.0.0/24',
    pools: [{ start: '10.0.0.10', end: '10.0.0.12' }],
    routers: ['10.0.0.1'],
    dnsServers: ['10.0.0.1'],
    leaseTtlSeconds: 3600,
    reservations: [],
    dhcpOptions: [],
    nextServer: null,
    ipxeBuildTarget: null,
    relay: null,
  };
}

function resolverFrom(interfaces: NetworkInterface[]): typeof selfPrimary {
  return (opts, discover): SelfPrimaryInterface | null => selfPrimary(opts, discover ?? (() => interfaces));
}

interface FakeSocket {
  on: ReturnType<typeof vi.fn>;
  once: ReturnType<typeof vi.fn>;
  removeListener: ReturnType<typeof vi.fn>;
  bind: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  setBroadcast: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  emitMessage(msg: Buffer, rinfo: dgram.RemoteInfo): void;
}

function makeFakeSocket(onBind: () => void): FakeSocket {
  let messageHandler: ((msg: Buffer, rinfo: dgram.RemoteInfo) => void) | null = null;
  return {
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (event === 'message') messageHandler = handler as (msg: Buffer, rinfo: dgram.RemoteInfo) => void;
    }),
    once: vi.fn(),
    removeListener: vi.fn(),
    bind: vi.fn((_port: number, _ip: string, cb: () => void) => {
      onBind();
      cb();
    }),
    send: vi.fn(),
    setBroadcast: vi.fn(),
    close: vi.fn(),
    emitMessage: (msg, rinfo) => messageHandler?.(msg, rinfo),
  };
}

function recordingStore(log: string[], records: LeaseRecord[] = []): LeaseStore {
  return {
    loadAll: vi.fn(async () => {
      log.push('loadAll');
      return records;
    }),
    put: vi.fn(async () => void log.push('put')),
    delete: vi.fn(async () => void log.push('delete')),
    pruneExpired: vi.fn(async () => 0),
  };
}

function buildService(
  isLeader: () => boolean,
  store: LeaseStore,
  log: string[],
): { service: DhcpServerService; sockets: FakeSocket[] } {
  const sockets: FakeSocket[] = [];
  const service = new DhcpServerService({
    config: makeRuntimeConfig(),
    resolvePrimary: resolverFrom(INTERFACES),
    resolveInterfaces: () => selfInterfaces({ clientFacingOnly: true }, () => INTERFACES),
    isLeader,
    readAtoms: async () => new Map([['prefix-1', makeAtom()]]),
    createSocket: () => {
      const s = makeFakeSocket(() => log.push('bind'));
      sockets.push(s);
      return s as unknown as dgram.Socket;
    },
    createReplySocket: () => {
      const s = makeFakeSocket(() => log.push('bind'));
      sockets.push(s);
      return s as unknown as dgram.Socket;
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    leaseStore: store,
  });
  return { service, sockets };
}

describe('DHCP manager lease-store lifecycle (group F)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('hydrates the store once on leader-acquire', async () => {
    vi.useFakeTimers();
    const log: string[] = [];
    const store = recordingStore(log, [{ ip: '10.0.0.10', mac: '00:0b:82:01:fc:42', hostname: null, expiresAt: 1e12 }]);
    const { service } = buildService(() => true, store, log);

    void service.start('job');
    await vi.advanceTimersByTimeAsync(0);
    service.stop('job');

    expect(store.loadAll).toHaveBeenCalledTimes(1);
    expect(log).toContain('bind');
  });

  it('re-hydrates on each leader re-acquire without rebinding', async () => {
    vi.useFakeTimers();
    const log: string[] = [];
    const store = recordingStore(log);
    let leader = true;
    const { sockets } = (() => {
      const built = buildService(() => leader, store, log);
      void built.service.start('job');
      return built;
    })();

    await vi.advanceTimersByTimeAsync(0);
    expect(store.loadAll).toHaveBeenCalledTimes(1);

    leader = false;
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(sockets[0]!.close).not.toHaveBeenCalled();

    leader = true;
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(store.loadAll).toHaveBeenCalledTimes(2);
    expect(sockets).toHaveLength(2);
  });

  it('does not write through on a commit after leader-loss', async () => {
    vi.useFakeTimers();
    const log: string[] = [];
    const store = recordingStore(log);
    let leader = true;
    const { sockets } = (() => {
      const built = buildService(() => leader, store, log);
      void built.service.start('job');
      return built;
    })();
    await vi.advanceTimersByTimeAsync(0);

    sockets[0]!.emitMessage(discoverWire(CLIENT_MAC), RINFO);
    await vi.advanceTimersByTimeAsync(0);
    const putsWhileLeader = vi.mocked(store.put).mock.calls.length;
    expect(putsWhileLeader).toBeGreaterThan(0);

    leader = false;
    await vi.advanceTimersByTimeAsync(POLL_MS);

    sockets[0]!.emitMessage(discoverWire('00:0b:82:01:fc:99'), RINFO);
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.mocked(store.put).mock.calls.length).toBe(putsWhileLeader);
  });

  it('binds :67 immediately but defers answering until hydrate succeeds', async () => {
    vi.useFakeTimers();
    const log: string[] = [];
    const lease: LeaseRecord = { ip: '10.0.0.10', mac: CLIENT_MAC, hostname: null, expiresAt: 1e12 };
    const loadAll = vi
      .fn<() => Promise<LeaseRecord[]>>()
      .mockImplementationOnce(async () => {
        log.push('loadAll');
        throw new Error('redis down');
      })
      .mockImplementation(async () => {
        log.push('loadAll');
        return [lease];
      });
    const store: LeaseStore = {
      loadAll,
      put: vi.fn(async () => void log.push('put')),
      delete: vi.fn(async () => void log.push('delete')),
      pruneExpired: vi.fn(async () => 0),
    };
    const { service, sockets } = buildService(() => true, store, log);
    void service.start('job');

    await vi.advanceTimersByTimeAsync(0);
    expect(loadAll).toHaveBeenCalledTimes(1);
    expect(log.filter((e) => e === 'bind')).toHaveLength(1);
    sockets[0]!.emitMessage(discoverWire(CLIENT_MAC), RINFO);
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.mocked(store.put)).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(250);
    expect(loadAll).toHaveBeenCalledTimes(2);
    expect(log.filter((e) => e === 'bind')).toHaveLength(2);

    sockets[0]!.emitMessage(discoverWire(CLIENT_MAC), RINFO);
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.mocked(store.put).mock.calls.length).toBeGreaterThan(0);
    expect(sockets[0]!.close).not.toHaveBeenCalled();
    service.stop('job');
  });

  it('never re-hydrates while serving (no clobber of active leases)', async () => {
    vi.useFakeTimers();
    const log: string[] = [];
    const store = recordingStore(log);
    const { service, sockets } = buildService(() => true, store, log);
    void service.start('job');

    await vi.advanceTimersByTimeAsync(0);
    expect(store.loadAll).toHaveBeenCalledTimes(1);

    sockets[0]!.emitMessage(discoverWire(CLIENT_MAC), RINFO);
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.mocked(store.put).mock.calls.length).toBeGreaterThan(0);

    await vi.advanceTimersByTimeAsync(POLL_MS);
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(store.loadAll).toHaveBeenCalledTimes(1);
    service.stop('job');
  });

  it('does not retry hydrate when the first load succeeds but is empty', async () => {
    vi.useFakeTimers();
    const log: string[] = [];
    const store = recordingStore(log);
    const { service, sockets } = buildService(() => true, store, log);
    void service.start('job');

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await vi.advanceTimersByTimeAsync(POLL_MS);

    expect(store.loadAll).toHaveBeenCalledTimes(1);
    expect(log.filter((e) => e === 'bind')).toHaveLength(2);
    expect(sockets[0]!.close).not.toHaveBeenCalled();
    service.stop('job');
  });

  it('does not write through on a commit after stop()', async () => {
    vi.useFakeTimers();
    const log: string[] = [];
    const store = recordingStore(log);
    const { service, sockets } = buildService(() => true, store, log);
    void service.start('job');
    await vi.advanceTimersByTimeAsync(0);

    sockets[0]!.emitMessage(discoverWire(CLIENT_MAC), RINFO);
    await vi.advanceTimersByTimeAsync(0);
    const putsWhileLeader = vi.mocked(store.put).mock.calls.length;
    expect(putsWhileLeader).toBeGreaterThan(0);

    service.stop('job');

    sockets[0]!.emitMessage(discoverWire('00:0b:82:01:fc:99'), RINFO);
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.mocked(store.put).mock.calls.length).toBe(putsWhileLeader);
  });

  it('prunes expired leases on the interval only when leader and hydrated', async () => {
    vi.useFakeTimers();
    const log: string[] = [];
    const store = recordingStore(log);
    let leader = true;
    const { service } = buildService(() => leader, store, log);
    void service.start('job');
    await vi.advanceTimersByTimeAsync(0);
    expect(store.loadAll).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60000);
    expect(store.pruneExpired).toHaveBeenCalledTimes(1);

    leader = false;
    await vi.advanceTimersByTimeAsync(POLL_MS);
    const prunesBeforeStandbyTick = vi.mocked(store.pruneExpired).mock.calls.length;
    await vi.advanceTimersByTimeAsync(60000);
    expect(vi.mocked(store.pruneExpired).mock.calls.length).toBe(prunesBeforeStandbyTick);

    service.stop('job');
  });

  it('does not install the poll interval when stop() races the initial reconcile', async () => {
    let releaseLoad: (() => void) | null = null;
    const log: string[] = [];
    const store: LeaseStore = {
      loadAll: vi.fn(
        () =>
          new Promise<LeaseRecord[]>((resolve) => {
            releaseLoad = () => resolve([]);
          }),
      ),
      put: vi.fn(async () => void log.push('put')),
      delete: vi.fn(async () => void log.push('delete')),
      pruneExpired: vi.fn(async () => 0),
    };
    const { service } = buildService(() => true, store, log);
    const setIntervalSpy = vi.spyOn(global, 'setInterval');

    const started = service.start('job');
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    service.stop('job');
    releaseLoad!();
    await started;

    expect(setIntervalSpy).not.toHaveBeenCalled();
    setIntervalSpy.mockRestore();
  });
});
