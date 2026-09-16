import * as dgram from 'node:dgram';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  selfInterfaces,
  selfPrimary,
  type NetworkInterface,
  type SelfPrimaryInterface,
} from '../../bridge-network/self-network.js';
import { logDebug } from '../../logger/logger.service.js';
import { LIMITED_BROADCAST } from '../broadcast-socket.js';
import type { DhcpZoneOpsAtomValue } from '../dhcp-atom-value.schema.js';
import { DhcpServerService } from '../dhcp-manager.service.js';
import {
  DHCPDISCOVER,
  DHCPREQUEST,
  OPT_END,
  OPT_MESSAGE_TYPE,
  OPT_SERVER_ID,
  OPT_VENDOR_CLASS,
} from '../dhcp-options.js';
import { DhcpEngine } from '../dhcp-server.js';
import type { DhcpRuntimeConfig } from '../dhcp.config.js';
import { bufferToIp, buildFrame, ipToBuffer, parseFrame } from '../l2/frame.js';
import { InMemoryPacketSocket } from '../l2/packet-socket.js';
import type { LeaseStore } from '../lease-store/lease-store.js';
import { macToBytes, MAGIC_COOKIE, OPTIONS_OFFSET } from '../protocol.js';
import { makeAtom as baseAtom, type DhcpAtomValue } from './test-factories.js';

vi.mock('../../logger/logger.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../logger/logger.service.js')>();
  return { ...actual, logDebug: vi.fn(async () => {}) };
});

const POLL_MS = 1000;

function makeRuntimeConfig(overrides: Partial<DhcpRuntimeConfig> = {}): DhcpRuntimeConfig {
  return {
    leaderPollMs: POLL_MS,
    pruneIntervalMs: 60000,
    declineBackoffSeconds: 600,
    ...overrides,
  };
}

const MANAGER_ATOM_DEFAULTS: Partial<DhcpAtomValue> = {
  subnet: '10.0.0.0/24',
  pools: [{ start: '10.0.0.10', end: '10.0.0.20' }],
  routers: ['10.0.0.1'],
  dnsServers: ['10.0.0.1'],
};

function makeAtom(overrides: Partial<DhcpAtomValue> = {}): DhcpAtomValue {
  return baseAtom({ ...MANAGER_ATOM_DEFAULTS, ...overrides });
}

function proxyAtom(overrides: Partial<DhcpAtomValue> = {}): DhcpAtomValue {
  return makeAtom({
    mode: 'PROXY',
    nextServer: '10.0.0.7',
    ipxeBuildTarget: 'SNPONLY',
    ...overrides,
  });
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
    setBroadcast: vi.fn(),
    close: vi.fn(),
    emitMessage: (msg, rinfo) => messageHandler?.(msg, rinfo),
  };
  return fake;
}

function discoverWire(mac: string, opts: { giaddr?: string } = {}): Buffer {
  const head = Buffer.alloc(OPTIONS_OFFSET);
  head[0] = 1;
  head[1] = 1;
  head[2] = 6;
  head.writeUInt32BE(0x3903f326, 4);
  if (opts.giaddr) {
    const [a, b, c, d] = opts.giaddr.split('.').map((octet) => Number.parseInt(octet, 10));
    Buffer.from([a, b, c, d]).copy(head, 24);
  }
  macToBytes(mac).copy(head, 28);
  head.writeUInt32BE(MAGIC_COOKIE, 236);
  return Buffer.concat([head, Buffer.from([OPT_MESSAGE_TYPE, 1, DHCPDISCOVER, OPT_END])]);
}

const PXE_VENDOR_VALUE = Buffer.from('PXEClient:Arch:00000', 'ascii');

function pxeWire(messageType: number, opts: { ciaddr?: string } = {}): Buffer {
  const head = Buffer.alloc(OPTIONS_OFFSET);
  head[0] = 1;
  head[1] = 1;
  head[2] = 6;
  head.writeUInt32BE(0x3903f326, 4);
  if (opts.ciaddr) {
    const [a, b, c, d] = opts.ciaddr.split('.').map((o) => Number.parseInt(o, 10));
    Buffer.from([a, b, c, d]).copy(head, 12);
  }
  macToBytes('00:0b:82:01:fc:42').copy(head, 28);
  head.writeUInt32BE(MAGIC_COOKIE, 236);
  const vendor = Buffer.concat([Buffer.from([OPT_VENDOR_CLASS, PXE_VENDOR_VALUE.length]), PXE_VENDOR_VALUE]);
  return Buffer.concat([head, Buffer.from([OPT_MESSAGE_TYPE, 1, messageType]), vendor, Buffer.from([OPT_END])]);
}

function renewalWire(mac: string, ciaddr: string): Buffer {
  const head = Buffer.alloc(OPTIONS_OFFSET);
  head[0] = 1;
  head[1] = 1;
  head[2] = 6;
  head.writeUInt32BE(0x3903f326, 4);
  const [a, b, c, d] = ciaddr.split('.').map((o) => Number.parseInt(o, 10));
  Buffer.from([a, b, c, d]).copy(head, 12);
  macToBytes(mac).copy(head, 28);
  head.writeUInt32BE(MAGIC_COOKIE, 236);
  return Buffer.concat([head, Buffer.from([OPT_MESSAGE_TYPE, 1, DHCPREQUEST, OPT_END])]);
}

function serverIdFromOffer(packet: Buffer): string {
  let offset = OPTIONS_OFFSET;
  while (offset < packet.length) {
    const code = packet[offset];
    if (code === OPT_END) return '';
    const len = packet[offset + 1];
    if (code === OPT_SERVER_ID && len === 4) {
      return `${packet[offset + 2]}.${packet[offset + 3]}.${packet[offset + 4]}.${packet[offset + 5]}`;
    }
    offset += 2 + len;
  }
  return '';
}

function yiaddrOf(packet: Buffer): string {
  return `${packet[16]}.${packet[17]}.${packet[18]}.${packet[19]}`;
}

function sentReply(sockets: FakeSocket[], replySockets: FakeSocket[]): FakeSocket {
  const sender = [...replySockets, ...sockets].find((s) => s.send.mock.calls.length > 0);
  if (sender === undefined) throw new Error('no reply was sent on any socket');
  return sender;
}

function totalSends(sockets: FakeSocket[], replySockets: FakeSocket[]): number {
  return [...sockets, ...replySockets].reduce((n, s) => n + s.send.mock.calls.length, 0);
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

function iface(name: string, ip: string): NetworkInterface {
  return {
    name,
    ip,
    netmask: '255.255.255.0',
    prefix: 24,
    network: `${ip}/24`,
    isPrimary: false,
    interfaceType: 'other',
  };
}

const INTERFACES: NetworkInterface[] = [iface('eth0', '10.0.0.1'), iface('eth1', '172.16.0.1')];

function bothSubnetsAtoms(): ReadonlyMap<string, DhcpAtomValue> {
  return new Map([
    ['prefix-1', makeAtom()],
    [
      'prefix-2',
      makeAtom({
        subnet: '172.16.0.0/24',
        pools: [{ start: '172.16.0.10', end: '172.16.0.20' }],
        routers: ['172.16.0.1'],
        dnsServers: ['172.16.0.1'],
      }),
    ],
  ]);
}

function resolverFrom(interfaces: NetworkInterface[]): typeof selfPrimary {
  return (opts, discover): SelfPrimaryInterface | null => selfPrimary(opts, discover ?? (() => interfaces));
}

function buildService(
  isLeader: () => boolean,
  config: DhcpRuntimeConfig = makeRuntimeConfig(),
  interfaces: NetworkInterface[] = INTERFACES,
  resolvePeerDnsIp?: (jobId: string) => Promise<string | null>,
  atoms?: ReadonlyMap<string, DhcpAtomValue>,
): { service: DhcpServerService; sockets: FakeSocket[]; replySockets: FakeSocket[] } {
  const sockets: FakeSocket[] = [];
  const replySockets: FakeSocket[] = [];
  const defaultAtoms = atoms ?? new Map([['prefix-1', makeAtom()]]);
  const service = new DhcpServerService({
    config,
    resolvePrimary: resolverFrom(interfaces),
    resolveInterfaces: () => selfInterfaces({ clientFacingOnly: true }, () => interfaces),
    isLeader,
    resolvePeerDnsIp,
    readAtoms: async () => defaultAtoms,
    createSocket: () => {
      const s = makeFakeSocket();
      sockets.push(s);
      return s as unknown as dgram.Socket;
    },
    createReplySocket: () => {
      const s = makeFakeSocket();
      replySockets.push(s);
      return s as unknown as dgram.Socket;
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  });
  return { service, sockets, replySockets };
}

describe('DhcpServerService hot-standby answer-gating', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('binds :67 when already leader and atoms provide an engine, and answers a DISCOVER by broadcast', async () => {
    vi.useFakeTimers();
    const { service, sockets, replySockets } = buildService(() => true);

    const start = service.start('job-1');
    await flush();

    expect(sockets.length).toBeGreaterThanOrEqual(1);
    expect(sockets[0].bind).toHaveBeenCalledWith(67, '0.0.0.0', expect.any(Function));
    expect(sockets[0].setBroadcast).toHaveBeenCalledWith(true);

    const rinfo = { address: '0.0.0.0', port: 68, family: 'IPv4', size: 0 } as dgram.RemoteInfo;
    sockets[0].emitMessage(discoverWire('00:0b:82:01:fc:42'), rinfo);

    const sent = sentReply(sockets, replySockets);
    expect(totalSends(sockets, replySockets)).toBe(1);
    expect(sent.send.mock.calls[0][1]).toBe(68);
    expect(sent.send.mock.calls[0][2]).toBe(LIMITED_BROADCAST);

    service.stop('job-1');
    await expect(start).resolves.toBeUndefined();
  });

  it('a non-leader BINDS :67 but drops a DISCOVER (no reply, no lease)', async () => {
    vi.useFakeTimers();
    const { service, sockets } = buildService(() => false);

    const start = service.start('job-1');
    await flush();
    expect(sockets.length).toBeGreaterThanOrEqual(1);
    expect(sockets[0].bind).toHaveBeenCalledWith(67, '0.0.0.0', expect.any(Function));

    const rinfo = { address: '0.0.0.0', port: 68, family: 'IPv4', size: 0 } as dgram.RemoteInfo;
    sockets[0].emitMessage(discoverWire('00:0b:82:01:fc:42'), rinfo);
    expect(sockets[0].send).not.toHaveBeenCalled();

    service.stop('job-1');
    await expect(start).resolves.toBeUndefined();
  });

  it('leadership flip false->true: the new leader answers on the already-bound socket without rebind', async () => {
    vi.useFakeTimers();
    let leader = false;
    const { service, sockets, replySockets } = buildService(() => leader);

    const start = service.start('job-1');
    await flush();
    const socket = sockets[0];

    const rinfo = { address: '0.0.0.0', port: 68, family: 'IPv4', size: 0 } as dgram.RemoteInfo;
    socket.emitMessage(discoverWire('00:0b:82:01:fc:42'), rinfo);
    expect(totalSends(sockets, replySockets)).toBe(0);

    leader = true;
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await flush();
    expect(socket.bind).toHaveBeenCalledTimes(1);

    socket.emitMessage(discoverWire('00:0b:82:01:fc:42'), rinfo);
    expect(totalSends(sockets, replySockets)).toBe(1);

    service.stop('job-1');
    await expect(start).resolves.toBeUndefined();
  });

  it('hydrate runs on acquire before answering; a non-leader never hydrates', async () => {
    vi.useFakeTimers();
    let leader = false;
    const loadAll = vi.fn(() => Promise.resolve([]));
    const leaseStore: LeaseStore = {
      loadAll,
      put: vi.fn(() => Promise.resolve()),
      delete: vi.fn(() => Promise.resolve()),
      pruneExpired: vi.fn(() => Promise.resolve(0)),
      takeRevocations: vi.fn(async () => []),
    };
    const sockets: FakeSocket[] = [];
    const replySockets: FakeSocket[] = [];
    const service = new DhcpServerService({
      config: makeRuntimeConfig(),
      resolvePrimary: resolverFrom(INTERFACES),
      resolveInterfaces: () => selfInterfaces({ clientFacingOnly: true }, () => INTERFACES),
      isLeader: () => leader,
      readAtoms: async () => new Map([['prefix-1', makeAtom()]]),
      createSocket: () => {
        const s = makeFakeSocket();
        sockets.push(s);
        return s as unknown as dgram.Socket;
      },
      createReplySocket: () => {
        const s = makeFakeSocket();
        replySockets.push(s);
        return s as unknown as dgram.Socket;
      },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      leaseStore,
    });

    const start = service.start('job-1');
    await flush();
    expect(sockets.length).toBeGreaterThanOrEqual(1);
    expect(loadAll).not.toHaveBeenCalled();

    leader = true;
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await flush();
    expect(loadAll).toHaveBeenCalledTimes(1);

    const rinfo = { address: '0.0.0.0', port: 68, family: 'IPv4', size: 0 } as dgram.RemoteInfo;
    sockets[0].emitMessage(discoverWire('00:0b:82:01:fc:42'), rinfo);
    expect(totalSends(sockets, replySockets)).toBe(1);

    service.stop('job-1');
    await expect(start).resolves.toBeUndefined();
  });

  it('clears in-RAM lease state on leadership loss (engine reset)', async () => {
    vi.useFakeTimers();
    let leader = true;
    const { service, sockets } = buildService(() => leader);

    const start = service.start('job-1');
    await flush();

    const rinfo = { address: '0.0.0.0', port: 68, family: 'IPv4', size: 0 } as dgram.RemoteInfo;
    sockets[0].emitMessage(discoverWire('00:0b:82:01:fc:42'), rinfo);
    const resetSpy = vi.spyOn(DhcpEngine.prototype, 'resetLeaseState');

    leader = false;
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await flush();
    expect(resetSpy).toHaveBeenCalledTimes(1);
    expect(sockets[0].close).not.toHaveBeenCalled();

    service.stop('job-1');
    await expect(start).resolves.toBeUndefined();
  });

  it('stays dormant (no bind) when no client-facing interface is available', async () => {
    vi.useFakeTimers();
    const { service, sockets } = buildService(() => true, makeRuntimeConfig(), []);

    const start = service.start('job-1');
    await flush();
    expect(sockets).toHaveLength(0);

    service.stop('job-1');
    await expect(start).resolves.toBeUndefined();
  });

  it('resolves the server-id from the first client-facing interface IPv4', async () => {
    vi.useFakeTimers();
    const { service, sockets, replySockets } = buildService(() => true);

    const start = service.start('job-1');
    await flush();
    expect(sockets.length).toBeGreaterThanOrEqual(1);

    const rinfo = { address: '0.0.0.0', port: 68, family: 'IPv4', size: 0 } as dgram.RemoteInfo;
    sockets[0].emitMessage(discoverWire('00:0b:82:01:fc:42'), rinfo);
    expect(serverIdFromOffer(sentReply(sockets, replySockets).send.mock.calls[0][0])).toBe('10.0.0.1');

    service.stop('job-1');
    await expect(start).resolves.toBeUndefined();
  });

  it('parks: start() stays pending until stop()', async () => {
    vi.useFakeTimers();
    const { service } = buildService(() => false);

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

  it('drops a malformed packet without sending', async () => {
    vi.useFakeTimers();
    const { service, sockets } = buildService(() => true);
    const start = service.start('job-1');
    await flush();

    const rinfo = { address: '0.0.0.0', port: 68, family: 'IPv4', size: 0 } as dgram.RemoteInfo;
    sockets[0].emitMessage(Buffer.from([1, 2, 3]), rinfo);
    expect(sockets[0].send).not.toHaveBeenCalled();

    service.stop('job-1');
    await expect(start).resolves.toBeUndefined();
  });
});

describe('DhcpServerService atoms-only engine lifecycle', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('does not build the engine in the constructor', () => {
    const hydrateSpy = vi.spyOn(DhcpEngine.prototype, 'hydrate');
    const { service } = buildService(() => true);
    expect(hydrateSpy).not.toHaveBeenCalled();
    expect(() => service.stop('job-1')).not.toThrow();
  });

  it('stop() before start() is a safe no-op', () => {
    const { service, sockets } = buildService(() => true);
    expect(() => service.stop('job-1')).not.toThrow();
    expect(sockets).toHaveLength(0);
  });

  it('engine stays null when no atoms reader is injected', async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const service = new DhcpServerService({
      config: makeRuntimeConfig(),
      resolvePrimary: resolverFrom(INTERFACES),
      resolveInterfaces: () => [],
      isLeader: () => true,
      createSocket: () => {
        const s = makeFakeSocket();
        sockets.push(s);
        return s as unknown as dgram.Socket;
      },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    const start = service.start('job-1');
    await flush();
    expect(sockets).toHaveLength(0);

    service.stop('job-1');
    await expect(start).resolves.toBeUndefined();
  });

  it('tears down the engine when atoms become empty (live OFF transition)', async () => {
    vi.useFakeTimers();
    const atoms = new Map([['prefix-1', makeAtom()]]);
    const readAtomsFn = vi.fn().mockResolvedValue(atoms);
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const sockets: FakeSocket[] = [];
    const service = new DhcpServerService({
      config: makeRuntimeConfig(),
      resolvePrimary: resolverFrom(INTERFACES),
      resolveInterfaces: () => selfInterfaces({ clientFacingOnly: true }, () => INTERFACES),
      isLeader: () => true,
      readAtoms: readAtomsFn,
      createSocket: () => {
        const s = makeFakeSocket();
        sockets.push(s);
        return s as unknown as dgram.Socket;
      },
      createReplySocket: () => makeFakeSocket() as unknown as dgram.Socket,
      logger,
    });

    const start = service.start('job-1');
    await flush();

    expect(sockets.length).toBeGreaterThanOrEqual(1);

    readAtomsFn.mockResolvedValue(new Map());
    await vi.advanceTimersByTimeAsync(POLL_MS + 10);
    await flush();

    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('engine torn down'), expect.anything());

    service.stop('job-1');
    await expect(start).resolves.toBeUndefined();
  });

  it('keeps the current engine when a hot-swap has duplicate relay agent IPs', async () => {
    vi.useFakeTimers();
    const relayAgentIp = '192.0.2.1';
    const atoms = new Map([['prefix-1', makeAtom({ relay: { relayAgentIp } })]]);
    const fromSubnets = vi.spyOn(DhcpEngine, 'fromSubnets');
    const { service } = buildService(() => true, makeRuntimeConfig(), INTERFACES, undefined, atoms);
    const start = service.start('job-1');
    await flush();
    const initialBuildCount = fromSubnets.mock.calls.length;

    atoms.set(
      'prefix-2',
      makeAtom({
        subnet: '10.20.0.0/24',
        pools: [{ start: '10.20.0.10', end: '10.20.0.20' }],
        routers: ['10.20.0.1'],
        dnsServers: ['10.20.0.1'],
        relay: { relayAgentIp },
      }),
    );
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await flush();

    expect(fromSubnets).toHaveBeenCalledTimes(initialBuildCount);

    service.stop('job-1');
    await expect(start).resolves.toBeUndefined();
  });

  it('warns about a stable duplicate relay agent IP config once, not on every poll tick', async () => {
    vi.useFakeTimers();
    const relayAgentIp = '192.0.2.1';
    const atoms = new Map([['prefix-1', makeAtom({ relay: { relayAgentIp } })]]);
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const service = new DhcpServerService({
      config: makeRuntimeConfig(),
      resolvePrimary: resolverFrom(INTERFACES),
      resolveInterfaces: () => selfInterfaces({ clientFacingOnly: true }, () => INTERFACES),
      isLeader: () => true,
      readAtoms: async () => atoms,
      createSocket: () => makeFakeSocket() as unknown as dgram.Socket,
      createReplySocket: () => makeFakeSocket() as unknown as dgram.Socket,
      logger,
    });
    const start = service.start('job-1');
    await flush();

    atoms.set(
      'prefix-2',
      makeAtom({
        subnet: '10.20.0.0/24',
        pools: [{ start: '10.20.0.10', end: '10.20.0.20' }],
        routers: ['10.20.0.1'],
        dnsServers: ['10.20.0.1'],
        relay: { relayAgentIp },
      }),
    );
    for (let tick = 0; tick < 3; tick += 1) {
      await vi.advanceTimersByTimeAsync(POLL_MS);
      await flush();
    }

    const dupWarnings = logger.warn.mock.calls.filter(([message]) =>
      String(message).includes('duplicate relay agent IP'),
    );
    expect(dupWarnings).toHaveLength(1);

    service.stop('job-1');
    await expect(start).resolves.toBeUndefined();
  });
});

describe('DhcpServerService PXE-03 silent-leader-death failover', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function silentDeadLeaderRedis(leaderTtlMs: number, clockMs: () => number) {
    let keyExpiresAt = leaderTtlMs;
    let weOwn = false;
    return {
      claimLeadershipIfVacant: async (): Promise<boolean> => {
        if (weOwn) return false;
        if (clockMs() < keyExpiresAt) return false;
        weOwn = true;
        keyExpiresAt = clockMs() + leaderTtlMs;
        return true;
      },
      isLeader: (): boolean => weOwn,
    };
  }

  it('survivor claims + answers within one reconcile poll of TTL expiry', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const LEADER_TTL_MS = 30_000;
    const redis = silentDeadLeaderRedis(LEADER_TTL_MS, () => Date.now());

    const sockets: FakeSocket[] = [];
    const replySockets: FakeSocket[] = [];
    const service = new DhcpServerService({
      config: makeRuntimeConfig(),
      resolvePrimary: resolverFrom(INTERFACES),
      resolveInterfaces: () => selfInterfaces({ clientFacingOnly: true }, () => INTERFACES),
      isLeader: redis.isLeader,
      claimLeadershipIfVacant: redis.claimLeadershipIfVacant,
      readAtoms: async () => new Map([['prefix-1', makeAtom()]]),
      createSocket: () => {
        const s = makeFakeSocket();
        sockets.push(s);
        return s as unknown as dgram.Socket;
      },
      createReplySocket: () => {
        const s = makeFakeSocket();
        replySockets.push(s);
        return s as unknown as dgram.Socket;
      },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    const start = service.start('job-1');
    await flush();
    expect(sockets.length).toBeGreaterThanOrEqual(1);
    const rinfo = { address: '0.0.0.0', port: 68, family: 'IPv4', size: 0 } as dgram.RemoteInfo;

    await vi.advanceTimersByTimeAsync(LEADER_TTL_MS - POLL_MS);
    await flush();
    expect(redis.isLeader()).toBe(false);
    sockets[0].emitMessage(discoverWire('00:0b:82:01:fc:42'), rinfo);
    expect(totalSends(sockets, replySockets)).toBe(0);

    await vi.advanceTimersByTimeAsync(POLL_MS);
    await flush();
    expect(redis.isLeader()).toBe(true);
    const elapsedMs = Date.now();
    expect(elapsedMs).toBeLessThanOrEqual(LEADER_TTL_MS + POLL_MS);

    sockets[0].emitMessage(discoverWire('00:0b:82:01:fc:42'), rinfo);
    expect(totalSends(sockets, replySockets)).toBe(1);

    service.stop('job-1');
    await expect(start).resolves.toBeUndefined();
  });

  it('a claim-attempt error is swallowed and tracked in standby health', async () => {
    vi.useFakeTimers();
    const warn = vi.fn();
    const sockets: FakeSocket[] = [];
    let claimed = false;
    const service = new DhcpServerService({
      config: makeRuntimeConfig(),
      resolvePrimary: resolverFrom(INTERFACES),
      resolveInterfaces: () => selfInterfaces({ clientFacingOnly: true }, () => INTERFACES),
      isLeader: () => claimed,
      claimLeadershipIfVacant: async (): Promise<boolean> => {
        if (!claimed) throw new Error('redis down at some-host:6379');
        return false;
      },
      readAtoms: async () => new Map([['prefix-1', makeAtom()]]),
      createSocket: () => {
        const s = makeFakeSocket();
        sockets.push(s);
        return s as unknown as dgram.Socket;
      },
      logger: { info: vi.fn(), warn, error: vi.fn() },
    });

    const start = service.start('job-1');
    await flush();
    expect(sockets.length).toBeGreaterThanOrEqual(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('opportunistic leadership claim failed'),
      expect.anything(),
    );
    const failed = service.getStandbyHealth();
    expect(failed.claimFailureCount).toBe(1);
    expect(failed.lastClaimError).toContain('redis down');

    claimed = true;
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await flush();
    const recovered = service.getStandbyHealth();
    expect(recovered.lastClaimError).toBeNull();
    expect(recovered.claimFailureCount).toBe(1);

    service.stop('job-1');
    await expect(start).resolves.toBeUndefined();
  });

  it('GAP3: a leader that holds the lock but cannot hydrate marks the stall and latches one failover-blocked WARN', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const warn = vi.fn();
    const sockets: FakeSocket[] = [];
    let hydrateOk = false;
    const leaseStore: LeaseStore = {
      loadAll: vi.fn(() => (hydrateOk ? Promise.resolve([]) : Promise.reject(new Error('lease cache unreachable')))),
      put: vi.fn(() => Promise.resolve()),
      delete: vi.fn(() => Promise.resolve()),
      pruneExpired: vi.fn(() => Promise.resolve(0)),
      takeRevocations: vi.fn(async () => []),
    };
    const clockMs = (): number => Date.now();
    const service = new DhcpServerService({
      config: makeRuntimeConfig(),
      resolvePrimary: resolverFrom(INTERFACES),
      resolveInterfaces: () => selfInterfaces({ clientFacingOnly: true }, () => INTERFACES),
      isLeader: () => true,
      now: clockMs,
      leaderTtlSeconds: 30,
      readAtoms: async () => new Map([['prefix-1', makeAtom()]]),
      createSocket: () => {
        const s = makeFakeSocket();
        sockets.push(s);
        return s as unknown as dgram.Socket;
      },
      createReplySocket: () => makeFakeSocket() as unknown as dgram.Socket,
      logger: { info: vi.fn(), warn, error: vi.fn() },
      leaseStore,
    });

    const start = service.start('job-1');
    await flush();
    let health = service.getStandbyHealth();
    expect(health.isLeader).toBe(true);
    expect(health.answering).toBe(false);
    expect(health.hydrateStalledSince).toBe(0);
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('failover is blocked'), expect.anything());

    await vi.advanceTimersByTimeAsync(31_000);
    await flush();
    const blockedWarns = warn.mock.calls.filter((c) => String(c[0]).includes('failover is blocked'));
    expect(blockedWarns).toHaveLength(1);
    health = service.getStandbyHealth();
    expect(health.answering).toBe(false);

    hydrateOk = true;
    await vi.advanceTimersByTimeAsync(250);
    await flush();
    health = service.getStandbyHealth();
    expect(health.answering).toBe(true);
    expect(health.hydrateStalledSince).toBeNull();

    service.stop('job-1');
    await expect(start).resolves.toBeUndefined();
  });
});

describe('DhcpServerService PXE/proxyDHCP socket lifecycle (atoms-based)', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function buildProxyService(
    isLeader: () => boolean,
    readAtomsFn?: (jobId: string) => Promise<ReadonlyMap<string, DhcpAtomValue>>,
  ): {
    service: DhcpServerService;
    sockets: FakeSocket[];
    replySockets: FakeSocket[];
    logger: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
  } {
    const sockets: FakeSocket[] = [];
    const replySockets: FakeSocket[] = [];
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const defaultAtoms = new Map([['prefix-1', proxyAtom()]]);
    const service = new DhcpServerService({
      config: makeRuntimeConfig(),
      resolvePrimary: resolverFrom(INTERFACES),
      resolveInterfaces: () => selfInterfaces({ clientFacingOnly: true }, () => INTERFACES),
      isLeader,
      readAtoms: readAtomsFn ?? (async () => defaultAtoms),
      createSocket: () => {
        const s = makeFakeSocket();
        sockets.push(s);
        return s as unknown as dgram.Socket;
      },
      createReplySocket: () => {
        const s = makeFakeSocket();
        replySockets.push(s);
        return s as unknown as dgram.Socket;
      },
      logger,
    });
    return { service, sockets, replySockets, logger };
  }

  it('PROXY atoms bind :4011 alongside :67', async () => {
    vi.useFakeTimers();
    const { service, sockets } = buildProxyService(() => true);

    const start = service.start('job-1');
    await flush();

    expect(sockets.length).toBeGreaterThanOrEqual(2);
    const boundPorts = sockets.map((s) => s.bind.mock.calls[0]?.[0]).filter(Boolean);
    expect(boundPorts).toContain(4011);
    expect(boundPorts).toContain(67);
    expect(service.getStandbyHealth().pxePortBound).toBe(true);

    service.stop('job-1');
    await expect(start).resolves.toBeUndefined();
  });

  it('stop() closes both :67 and :4011 sockets', async () => {
    vi.useFakeTimers();
    const { service, sockets } = buildProxyService(() => true);

    const start = service.start('job-1');
    await flush();

    expect(sockets.length).toBeGreaterThanOrEqual(2);
    service.stop('job-1');
    for (const s of sockets) {
      expect(s.close).toHaveBeenCalled();
    }

    await expect(start).resolves.toBeUndefined();
  });

  it('non-leader binds :4011 in hot-standby but drops packets', async () => {
    vi.useFakeTimers();
    const { service, sockets } = buildProxyService(() => false);

    const start = service.start('job-1');
    await flush();

    const boundPorts = sockets.map((s) => s.bind.mock.calls[0]?.[0]).filter(Boolean);
    expect(boundPorts).toContain(4011);

    const pxeSocket = sockets.find((s) => s.bind.mock.calls[0]?.[0] === 4011);
    expect(pxeSocket).toBeDefined();
    const rinfo = { address: '10.0.0.100', port: 68, family: 'IPv4', size: 0 } as dgram.RemoteInfo;
    pxeSocket!.emitMessage(pxeWire(DHCPDISCOVER), rinfo);
    expect(pxeSocket!.send).not.toHaveBeenCalled();

    service.stop('job-1');
    await expect(start).resolves.toBeUndefined();
  });

  it('tears down :4011 when atoms switch from PROXY to empty (live OFF)', async () => {
    vi.useFakeTimers();
    const proxyAtoms: ReadonlyMap<string, DhcpAtomValue> = new Map([['prefix-1', proxyAtom()]]);
    let currentAtoms: ReadonlyMap<string, DhcpAtomValue> = proxyAtoms;
    const sockets: FakeSocket[] = [];
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const service = new DhcpServerService({
      config: makeRuntimeConfig(),
      resolvePrimary: resolverFrom(INTERFACES),
      resolveInterfaces: () => selfInterfaces({ clientFacingOnly: true }, () => INTERFACES),
      isLeader: () => true,
      readAtoms: async () => currentAtoms,
      createSocket: () => {
        const s = makeFakeSocket();
        sockets.push(s);
        return s as unknown as dgram.Socket;
      },
      createReplySocket: () => makeFakeSocket() as unknown as dgram.Socket,
      logger,
    });

    const start = service.start('job-1');
    await flush();

    const boundPorts = sockets.map((s) => s.bind.mock.calls[0]?.[0]).filter(Boolean);
    expect(boundPorts).toContain(4011);

    currentAtoms = new Map();
    await vi.advanceTimersByTimeAsync(POLL_MS + 10);
    await flush();

    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('engine torn down'), expect.anything());
    expect(service.getStandbyHealth().pxePortBound).toBe(false);

    service.stop('job-1');
    await expect(start).resolves.toBeUndefined();
  });

  it('AUTHORITATIVE atoms with PXE boot bind :4011 alongside :67', async () => {
    vi.useFakeTimers();
    const authAtomWithPxe = makeAtom({ nextServer: '10.0.0.7', ipxeBuildTarget: 'SNPONLY' });
    const { service, sockets } = buildService(
      () => true,
      makeRuntimeConfig(),
      INTERFACES,
      undefined,
      new Map([['prefix-1', authAtomWithPxe]]),
    );

    const start = service.start('job-1');
    await flush();

    const boundPorts = sockets.map((s) => s.bind.mock.calls[0]?.[0]).filter(Boolean);
    expect(boundPorts).toContain(67);
    expect(boundPorts).toContain(4011);

    service.stop('job-1');
    await expect(start).resolves.toBeUndefined();
  });

  it('tearDownEngine resets hydrated so getStandbyHealth().answering reports false', async () => {
    vi.useFakeTimers();
    const atoms = new Map([['prefix-1', makeAtom()]]);
    const readAtomsFn = vi.fn().mockResolvedValue(atoms);
    const sockets: FakeSocket[] = [];
    const service = new DhcpServerService({
      config: makeRuntimeConfig(),
      resolvePrimary: resolverFrom(INTERFACES),
      resolveInterfaces: () => selfInterfaces({ clientFacingOnly: true }, () => INTERFACES),
      isLeader: () => true,
      readAtoms: readAtomsFn,
      createSocket: () => {
        const s = makeFakeSocket();
        sockets.push(s);
        return s as unknown as dgram.Socket;
      },
      createReplySocket: () => makeFakeSocket() as unknown as dgram.Socket,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    const start = service.start('job-1');
    await flush();

    const healthBefore = service.getStandbyHealth();
    expect(healthBefore.answering).toBe(true);
    expect(healthBefore.hydrated).toBe(true);

    readAtomsFn.mockResolvedValue(new Map());
    await vi.advanceTimersByTimeAsync(POLL_MS + 10);
    await flush();

    const healthAfter = service.getStandbyHealth();
    expect(healthAfter.answering).toBe(false);
    expect(healthAfter.hydrated).toBe(false);

    service.stop('job-1');
    await expect(start).resolves.toBeUndefined();
  });

  it(':4011 bind failure does not prevent :67 from binding (AUTHORITATIVE with PXE)', async () => {
    vi.useFakeTimers();
    const authAtomWithPxe = makeAtom({ nextServer: '10.0.0.7', ipxeBuildTarget: 'SNPONLY' });
    let socketCount = 0;
    const sockets: FakeSocket[] = [];
    const service = new DhcpServerService({
      config: makeRuntimeConfig(),
      resolvePrimary: resolverFrom(INTERFACES),
      resolveInterfaces: () => selfInterfaces({ clientFacingOnly: true }, () => INTERFACES),
      isLeader: () => true,
      readAtoms: async () => new Map([['prefix-1', authAtomWithPxe]]),
      createSocket: () => {
        const s = makeFakeSocket();
        socketCount++;
        if (socketCount >= 2) {
          s.bind = vi.fn((_port: number, _ip: string, cb: () => void) => {
            const onceCall = s.once.mock.calls.find((c) => c[0] === 'error');
            if (onceCall) {
              (onceCall[1] as (err: Error) => void)(new Error('EADDRINUSE'));
              return;
            }
            cb();
          });
        }
        sockets.push(s);
        return s as unknown as dgram.Socket;
      },
      createReplySocket: () => makeFakeSocket() as unknown as dgram.Socket,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    const start = service.start('job-1');
    await flush();

    const boundPorts = sockets.filter((s) => s.bind.mock.calls.length > 0).map((s) => s.bind.mock.calls[0]?.[0]);
    expect(boundPorts).toContain(67);

    service.stop('job-1');
    await expect(start).resolves.toBeUndefined();
  });
});

describe('DhcpServerService broadcast reply egress (multihomed)', () => {
  const rinfo: dgram.RemoteInfo = { address: '0.0.0.0', port: 68, family: 'IPv4', size: 0 };

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('sends a broadcast OFFER via the send socket of the interface owning the offered subnet', async () => {
    vi.useFakeTimers();
    const { service, sockets, replySockets } = buildService(
      () => true,
      makeRuntimeConfig(),
      INTERFACES,
      undefined,
      bothSubnetsAtoms(),
    );

    const start = service.start('job-1');
    await flush();

    expect(replySockets).toHaveLength(2);
    expect(replySockets[0].bind).toHaveBeenCalledWith(67, '10.0.0.1', expect.any(Function));
    expect(replySockets[1].bind).toHaveBeenCalledWith(67, '172.16.0.1', expect.any(Function));
    expect(replySockets[0].setBroadcast).toHaveBeenCalledWith(true);

    sockets[0].emitMessage(discoverWire('00:0b:82:01:fc:42'), rinfo);

    expect(yiaddrOf(replySockets[0].send.mock.calls[0][0])).toBe('10.0.0.10');
    expect(replySockets[0].send).toHaveBeenCalledTimes(1);
    expect(replySockets[0].send.mock.calls[0][1]).toBe(68);
    expect(replySockets[0].send.mock.calls[0][2]).toBe(LIMITED_BROADCAST);
    expect(sockets[0].send).not.toHaveBeenCalled();
    expect(replySockets[1].send).not.toHaveBeenCalled();

    service.stop('job-1');
    await expect(start).resolves.toBeUndefined();
  });

  it('never sends out a bound reply socket whose CIDR does not hold the offered IP', async () => {
    vi.useFakeTimers();
    const multiIp = [iface('eth0', '10.0.0.1'), iface('eth0', '203.0.113.1')];
    const replySockets: FakeSocket[] = [];
    const sockets: FakeSocket[] = [];
    const service = new DhcpServerService({
      config: makeRuntimeConfig(),
      resolvePrimary: resolverFrom(multiIp),
      resolveInterfaces: () => multiIp,
      isLeader: () => true,
      readAtoms: async () => new Map([['prefix-1', makeAtom()]]),
      createSocket: () => {
        const s = makeFakeSocket();
        sockets.push(s);
        return s as unknown as dgram.Socket;
      },
      createReplySocket: () => {
        const s = makeFakeSocket();
        replySockets.push(s);
        return s as unknown as dgram.Socket;
      },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    const start = service.start('job-1');
    await flush();
    expect(replySockets).toHaveLength(2);
    expect(replySockets[1].bind).toHaveBeenCalledWith(67, '203.0.113.1', expect.any(Function));

    sockets[0].emitMessage(discoverWire('00:0b:82:01:fc:42'), rinfo);
    expect(yiaddrOf(replySockets[0].send.mock.calls[0][0])).toBe('10.0.0.10');
    expect(replySockets[1].send).not.toHaveBeenCalled();
    expect(sockets[0].send).not.toHaveBeenCalled();

    service.stop('job-1');
    await expect(start).resolves.toBeUndefined();
  });

  it('leaves unicast replies (a renewal) on the wildcard socket, untouched by send sockets', async () => {
    vi.useFakeTimers();
    const { service, sockets, replySockets } = buildService(
      () => true,
      makeRuntimeConfig(),
      INTERFACES,
      undefined,
      bothSubnetsAtoms(),
    );

    const start = service.start('job-1');
    await flush();
    expect(replySockets).toHaveLength(2);

    const unicast: dgram.RemoteInfo = { address: '10.0.0.10', port: 68, family: 'IPv4', size: 0 };
    sockets[0].emitMessage(renewalWire('00:0b:82:01:fc:42', '10.0.0.10'), unicast);

    expect(sockets[0].send).toHaveBeenCalledTimes(1);
    expect(sockets[0].send.mock.calls[0][1]).toBe(68);
    expect(sockets[0].send.mock.calls[0][2]).toBe('10.0.0.10');
    expect(replySockets[0].send).not.toHaveBeenCalled();
    expect(replySockets[1].send).not.toHaveBeenCalled();

    service.stop('job-1');
    await expect(start).resolves.toBeUndefined();
  });

  it('creates send sockets on bind and closes them all on stop', async () => {
    vi.useFakeTimers();
    const { service, sockets, replySockets } = buildService(
      () => true,
      makeRuntimeConfig(),
      INTERFACES,
      undefined,
      bothSubnetsAtoms(),
    );

    const start = service.start('job-1');
    await flush();
    expect(sockets.length).toBeGreaterThanOrEqual(1);
    expect(replySockets).toHaveLength(2);

    service.stop('job-1');
    await expect(start).resolves.toBeUndefined();
    expect(replySockets[0].close).toHaveBeenCalledTimes(1);
    expect(replySockets[1].close).toHaveBeenCalledTimes(1);
  });

  it('refreshes send sockets on reconcile: binds an appeared interface, closes a vanished one', async () => {
    vi.useFakeTimers();
    let ifaces: NetworkInterface[] = [iface('eth0', '10.0.0.1')];
    const sockets: FakeSocket[] = [];
    const replySockets: FakeSocket[] = [];
    const service = new DhcpServerService({
      config: makeRuntimeConfig(),
      resolvePrimary: resolverFrom([iface('eth0', '10.0.0.1')]),
      resolveInterfaces: () => selfInterfaces({ clientFacingOnly: true }, () => ifaces),
      isLeader: () => true,
      readAtoms: async () => bothSubnetsAtoms(),
      createSocket: () => {
        const s = makeFakeSocket();
        sockets.push(s);
        return s as unknown as dgram.Socket;
      },
      createReplySocket: () => {
        const s = makeFakeSocket();
        replySockets.push(s);
        return s as unknown as dgram.Socket;
      },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    const start = service.start('job-1');
    await flush();
    expect(replySockets).toHaveLength(1);

    ifaces = [iface('eth0', '10.0.0.1'), iface('eth1', '172.16.0.1')];
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await flush();
    expect(replySockets).toHaveLength(2);
    expect(replySockets[1].bind).toHaveBeenCalledWith(67, '172.16.0.1', expect.any(Function));

    ifaces = [iface('eth0', '10.0.0.1')];
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await flush();
    expect(replySockets[1].close).toHaveBeenCalledTimes(1);
    expect(replySockets[0].close).not.toHaveBeenCalled();

    service.stop('job-1');
    await expect(start).resolves.toBeUndefined();
  });

  it('never binds :67 on an interface outside every atom subnet (uplink LAN)', async () => {
    vi.useFakeTimers();
    const uplink = iface('eth9', '198.51.100.31');
    const { service, replySockets } = buildService(() => true, makeRuntimeConfig(), [
      uplink,
      iface('eth0', '10.0.0.1'),
    ]);

    const start = service.start('job-1');
    await flush();
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await flush();

    const boundIps = replySockets.flatMap((s) => s.bind.mock.calls.map((c) => c[1]));
    expect(boundIps).toEqual(['10.0.0.1']);

    service.stop('job-1');
    await expect(start).resolves.toBeUndefined();
  });

  it('derives the fallback server-id from a served NIC, not the enumeration-primary uplink', async () => {
    vi.useFakeTimers();
    const { service } = buildService(() => true, makeRuntimeConfig(), [
      iface('eth9', '198.51.100.31'),
      iface('eth0', '10.0.0.1'),
    ]);

    const start = service.start('job-1');
    await flush();

    expect(service.getServerId()).toBe('10.0.0.1');

    service.stop('job-1');
    await expect(start).resolves.toBeUndefined();
  });

  it('no atoms served means no reply sockets at all', async () => {
    vi.useFakeTimers();
    const { service, replySockets } = buildService(
      () => true,
      makeRuntimeConfig(),
      [iface('eth9', '198.51.100.31')],
      undefined,
      new Map(),
    );

    const start = service.start('job-1');
    await flush();
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await flush();

    expect(replySockets).toHaveLength(0);

    service.stop('job-1');
    await expect(start).resolves.toBeUndefined();
  });
});

describe('DhcpServerService PROXY socket ordering edge-cases (atoms-based)', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('a persistent :4011 bind failure never brings :67 up (no flap), and the pair binds together once :4011 recovers', async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    let failPxeBind = true;
    const hydrateSpy = vi.spyOn(DhcpEngine.prototype, 'hydrate');
    const service = new DhcpServerService({
      config: makeRuntimeConfig(),
      resolvePrimary: resolverFrom(INTERFACES),
      resolveInterfaces: () => selfInterfaces({ clientFacingOnly: true }, () => INTERFACES),
      isLeader: () => true,
      readAtoms: async () => new Map([['prefix-1', proxyAtom()]]),
      createSocket: () => {
        const s = makeFakeSocket();
        let errorHandler: ((e: Error) => void) | null = null;
        s.once = vi.fn((event: string, h: (...args: unknown[]) => void) => {
          if (event === 'error') errorHandler = h as (e: Error) => void;
        });
        s.bind = vi.fn((port: number, _ip: string, cb: () => void) => {
          if (port === 4011 && failPxeBind) {
            errorHandler?.(new Error('EADDRINUSE'));
            return;
          }
          cb();
        });
        sockets.push(s);
        return s as unknown as dgram.Socket;
      },
      createReplySocket: () => makeFakeSocket() as unknown as dgram.Socket,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    const start = service.start('job-1');
    await flush();

    expect(sockets.some((s) => s.bind.mock.calls.some((c) => c[0] === 4011))).toBe(true);
    expect(sockets.some((s) => s.bind.mock.calls.some((c) => c[0] === 67))).toBe(false);
    expect(hydrateSpy).toHaveBeenCalledTimes(1);

    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(POLL_MS);
      await flush();
    }
    expect(sockets.some((s) => s.bind.mock.calls.some((c) => c[0] === 67))).toBe(false);
    expect(hydrateSpy).toHaveBeenCalledTimes(1);

    failPxeBind = false;
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await flush();
    const bound4011 = sockets.filter(
      (s) => s.bind.mock.calls.some((c) => c[0] === 4011) && s.close.mock.calls.length === 0,
    );
    const bound67 = sockets.filter((s) => s.bind.mock.calls.some((c) => c[0] === 67));
    expect(bound67.length).toBe(1);
    expect(bound67[0].close).not.toHaveBeenCalled();
    expect(hydrateSpy).toHaveBeenCalledTimes(1);
    expect(bound4011.at(-1)!.close).not.toHaveBeenCalled();

    service.stop('job-1');
    await expect(start).resolves.toBeUndefined();
  });

  it('tears :4011 back down when the paired :67 bind fails', async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    let failDhcpBind = true;
    const service = new DhcpServerService({
      config: makeRuntimeConfig(),
      resolvePrimary: resolverFrom(INTERFACES),
      resolveInterfaces: () => selfInterfaces({ clientFacingOnly: true }, () => INTERFACES),
      isLeader: () => true,
      readAtoms: async () => new Map([['prefix-1', proxyAtom()]]),
      createSocket: () => {
        const s = makeFakeSocket();
        let errorHandler: ((e: Error) => void) | null = null;
        s.once = vi.fn((event: string, h: (...args: unknown[]) => void) => {
          if (event === 'error') errorHandler = h as (e: Error) => void;
        });
        s.bind = vi.fn((port: number, _ip: string, cb: () => void) => {
          if (port === 67 && failDhcpBind) {
            errorHandler?.(new Error('EADDRINUSE'));
            return;
          }
          cb();
        });
        sockets.push(s);
        return s as unknown as dgram.Socket;
      },
      createReplySocket: () => makeFakeSocket() as unknown as dgram.Socket,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    const start = service.start('job-1');
    await flush();

    const pxe = sockets.find((s) => s.bind.mock.calls.some((c) => c[0] === 4011));
    expect(pxe).toBeDefined();
    expect(pxe!.close).toHaveBeenCalledTimes(1);

    failDhcpBind = false;
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await flush();
    const upPxe = sockets.filter(
      (s) => s.bind.mock.calls.some((c) => c[0] === 4011) && s.close.mock.calls.length === 0,
    );
    const upDhcp = sockets.filter((s) => s.bind.mock.calls.some((c) => c[0] === 67) && s.close.mock.calls.length === 0);
    expect(upPxe.length).toBe(1);
    expect(upDhcp.length).toBe(1);

    service.stop('job-1');
    await expect(start).resolves.toBeUndefined();
  });

  it('tears down an orphaned :4011 even when hydrate fails (BB-10)', async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const failDhcpBind = true;
    const hydrateSpy = vi.spyOn(DhcpEngine.prototype, 'hydrate').mockResolvedValue(false);
    const service = new DhcpServerService({
      config: makeRuntimeConfig(),
      resolvePrimary: resolverFrom(INTERFACES),
      resolveInterfaces: () => selfInterfaces({ clientFacingOnly: true }, () => INTERFACES),
      isLeader: () => true,
      readAtoms: async () => new Map([['prefix-1', proxyAtom()]]),
      createSocket: () => {
        const s = makeFakeSocket();
        let errorHandler: ((e: Error) => void) | null = null;
        s.once = vi.fn((event: string, h: (...args: unknown[]) => void) => {
          if (event === 'error') errorHandler = h as (e: Error) => void;
        });
        s.bind = vi.fn((port: number, _ip: string, cb: () => void) => {
          if (port === 67 && failDhcpBind) {
            errorHandler?.(new Error('EADDRINUSE'));
            return;
          }
          cb();
        });
        sockets.push(s);
        return s as unknown as dgram.Socket;
      },
      createReplySocket: () => makeFakeSocket() as unknown as dgram.Socket,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    const start = service.start('job-1');
    await flush();

    const pxe = sockets.find((s) => s.bind.mock.calls.some((c) => c[0] === 4011));
    expect(pxe).toBeDefined();
    expect(pxe!.close).toHaveBeenCalledTimes(1);
    expect(hydrateSpy).toHaveBeenCalled();

    service.stop('job-1');
    await expect(start).resolves.toBeUndefined();
  });
});

describe('DhcpServerService AF_PACKET (L2) transport', () => {
  const CLIENT_MAC = '00:0b:82:01:fc:42';
  const ETH0_MAC = Buffer.from([0x02, 0x00, 0x00, 0x00, 0x00, 0x01]);
  const ETH0_IFINDEX = 1;

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function buildAfpacketService(readAtomsOverride?: () => Promise<ReadonlyMap<string, DhcpAtomValue>>): {
    service: DhcpServerService;
    packetSockets: Map<string, InMemoryPacketSocket>;
    sockets: FakeSocket[];
    replySockets: FakeSocket[];
  } {
    const packetSockets = new Map<string, InMemoryPacketSocket>();
    const sockets: FakeSocket[] = [];
    const replySockets: FakeSocket[] = [];
    const ifindexByName: Record<string, number> = { eth0: ETH0_IFINDEX, eth1: 2 };
    const macByName: Record<string, Buffer> = { eth0: ETH0_MAC, eth1: Buffer.from([0x02, 0, 0, 0, 0, 0x02]) };
    const service = new DhcpServerService({
      config: makeRuntimeConfig(),
      resolvePrimary: resolverFrom(INTERFACES),
      resolveInterfaces: () => selfInterfaces({ clientFacingOnly: true }, () => INTERFACES),
      isLeader: () => true,
      readAtoms: readAtomsOverride ?? (async () => new Map([['prefix-1', makeAtom()]])),
      createSocket: () => {
        const s = makeFakeSocket();
        sockets.push(s);
        return s as unknown as dgram.Socket;
      },
      createReplySocket: () => {
        const s = makeFakeSocket();
        replySockets.push(s);
        return s as unknown as dgram.Socket;
      },
      createPacketSocket: (ifname: string) => {
        const ps = new InMemoryPacketSocket(ifindexByName[ifname] ?? 0, macByName[ifname]);
        packetSockets.set(ifname, ps);
        return { kind: 'ok' as const, socket: ps };
      },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    return { service, packetSockets, sockets, replySockets };
  }

  function clientFrame(payload: Buffer): Buffer {
    return buildFrame({
      srcMac: macToBytes(CLIENT_MAC),
      dstMac: Buffer.alloc(6, 0xff),
      srcIp: ipToBuffer('0.0.0.0'),
      dstIp: ipToBuffer('255.255.255.255'),
      srcPort: 68,
      dstPort: 67,
      payload,
    });
  }

  it('probes createPacketSocket per interface and answers a DISCOVER via afpacket-unicast', async () => {
    vi.useFakeTimers();
    const { service, packetSockets } = buildAfpacketService();
    const start = service.start('job-1');
    await flush();
    vi.advanceTimersByTime(POLL_MS);
    await flush();

    expect([...packetSockets.keys()].sort()).toEqual(['eth0']);

    const eth0 = packetSockets.get('eth0')!;
    eth0.inject({
      ifindex: ETH0_IFINDEX,
      srcMac: macToBytes(CLIENT_MAC),
      frame: clientFrame(discoverWire(CLIENT_MAC)),
    });

    expect(eth0.sent).toHaveLength(1);
    const sent = eth0.sent[0]!;
    expect(sent.dstMac.equals(macToBytes(CLIENT_MAC))).toBe(true);
    const parsed = parseFrame(sent.frame);
    expect(parsed.srcMac.equals(ETH0_MAC)).toBe(true);
    expect(bufferToIp(parsed.srcIp)).toBe('10.0.0.1');
    expect(bufferToIp(parsed.dstIp)).toBe('10.0.0.10');
    expect(parsed.srcPort).toBe(67);
    expect(parsed.dstPort).toBe(68);

    service.stop('job-1');
    await expect(start).resolves.toBeUndefined();
  });

  it('answers a relayed dgram DISCOVER when AF_PACKET has full local coverage', async () => {
    vi.useFakeTimers();
    const relayAgentIp = '192.0.2.1';
    const atoms = new Map([
      ['prefix-local', makeAtom()],
      [
        'prefix-relayed',
        makeAtom({
          subnet: '10.20.0.0/24',
          pools: [{ start: '10.20.0.10', end: '10.20.0.20' }],
          routers: ['10.20.0.1'],
          dnsServers: ['10.20.0.1'],
          relay: { relayAgentIp },
        }),
      ],
    ]);
    const { service, packetSockets, sockets, replySockets } = buildAfpacketService(async () => atoms);
    const start = service.start('job-1');
    await flush();
    vi.advanceTimersByTime(POLL_MS);
    await flush();

    expect([...packetSockets.keys()]).toEqual(['eth0']);
    const rinfo = { address: relayAgentIp, port: 67, family: 'IPv4', size: 0 } as dgram.RemoteInfo;
    sockets[0].emitMessage(discoverWire(CLIENT_MAC, { giaddr: relayAgentIp }), rinfo);

    const sent = sentReply(sockets, replySockets);
    expect(yiaddrOf(sent.send.mock.calls[0][0] as Buffer)).toBe('10.20.0.10');
    expect(sent.send.mock.calls[0][1]).toBe(67);
    expect(sent.send.mock.calls[0][2]).toBe(relayAgentIp);

    service.stop('job-1');
    await expect(start).resolves.toBeUndefined();
  });

  it('reconciles AF_PACKET sockets when a hot-swap adds a newly-served interface', async () => {
    vi.useFakeTimers();
    const atoms = new Map([['prefix-1', makeAtom()]]);
    const { service, packetSockets } = buildAfpacketService(async () => new Map(atoms));
    const start = service.start('job-1');
    await flush();
    vi.advanceTimersByTime(POLL_MS);
    await flush();
    expect([...packetSockets.keys()].sort()).toEqual(['eth0']);

    atoms.set(
      'prefix-2',
      makeAtom({
        subnet: '172.16.0.0/24',
        pools: [{ start: '172.16.0.10', end: '172.16.0.20' }],
        routers: ['172.16.0.1'],
        dnsServers: ['172.16.0.1'],
      }),
    );
    vi.advanceTimersByTime(POLL_MS);
    await flush();
    vi.advanceTimersByTime(POLL_MS);
    await flush();

    expect([...packetSockets.keys()].sort()).toEqual(['eth0', 'eth1']);

    service.stop('job-1');
    await expect(start).resolves.toBeUndefined();
  });

  it('answers a broadcast-flag DISCOVER via afpacket-broadcast (dst MAC ff:ff:ff:ff:ff:ff)', async () => {
    vi.useFakeTimers();
    const { service, packetSockets } = buildAfpacketService();
    const start = service.start('job-1');
    await flush();
    vi.advanceTimersByTime(POLL_MS);
    await flush();

    const wire = discoverWire(CLIENT_MAC);
    wire.writeUInt16BE(0x8000, 10);
    const eth0 = packetSockets.get('eth0')!;
    eth0.inject({ ifindex: ETH0_IFINDEX, srcMac: macToBytes(CLIENT_MAC), frame: clientFrame(wire) });

    expect(eth0.sent).toHaveLength(1);
    expect(eth0.sent[0]!.dstMac.equals(Buffer.alloc(6, 0xff))).toBe(true);

    service.stop('job-1');
    await expect(start).resolves.toBeUndefined();
  });

  it('drops a malformed afpacket frame without throwing or replying', async () => {
    vi.useFakeTimers();
    const { service, packetSockets } = buildAfpacketService();
    const start = service.start('job-1');
    await flush();
    vi.advanceTimersByTime(POLL_MS);
    await flush();

    const eth0 = packetSockets.get('eth0')!;
    eth0.inject({
      ifindex: ETH0_IFINDEX,
      srcMac: macToBytes(CLIENT_MAC),
      frame: clientFrame(Buffer.from([0x01, 0x02])),
    });
    expect(eth0.sent).toHaveLength(0);

    service.stop('job-1');
    await expect(start).resolves.toBeUndefined();
  });

  it('processes a broadcast REQUEST once when delivered on BOTH the AF_PACKET and dgram paths', async () => {
    vi.useFakeTimers();
    const { service, packetSockets, sockets, replySockets } = buildAfpacketService();
    const start = service.start('job-1');
    await flush();
    vi.advanceTimersByTime(POLL_MS);
    await flush();

    const wire = renewalWire(CLIENT_MAC, '10.9.9.9');
    const eth0 = packetSockets.get('eth0')!;
    eth0.inject({ ifindex: ETH0_IFINDEX, srcMac: macToBytes(CLIENT_MAC), frame: clientFrame(wire) });
    const rinfo = { address: '10.9.9.9', port: 68, family: 'IPv4', size: 0 } as dgram.RemoteInfo;
    sockets[0].emitMessage(wire, rinfo);
    await flush();

    expect(eth0.sent.length + totalSends(sockets, replySockets)).toBe(1);

    service.stop('job-1');
    await expect(start).resolves.toBeUndefined();
  });

  it('NIC-A has AF_PACKET, NIC-B nic-error: a broadcast DISCOVER on NIC-B uses dgram (not dropped)', async () => {
    vi.useFakeTimers();
    const twoSubnetInterfaces = [iface('eth0', '10.0.0.1'), iface('eth1', '172.16.0.1')];
    const twoSubnetAtoms = new Map([
      ['prefix-1', makeAtom()],
      [
        'prefix-2',
        makeAtom({
          subnet: '172.16.0.0/24',
          pools: [{ start: '172.16.0.10', end: '172.16.0.20' }],
          routers: ['172.16.0.1'],
          dnsServers: ['172.16.0.1'],
        }),
      ],
    ]);

    const packetSockets = new Map<string, InMemoryPacketSocket>();
    const sockets: FakeSocket[] = [];
    const replySockets: FakeSocket[] = [];
    const service = new DhcpServerService({
      config: makeRuntimeConfig(),
      resolvePrimary: resolverFrom(twoSubnetInterfaces),
      resolveInterfaces: () => selfInterfaces({ clientFacingOnly: true }, () => twoSubnetInterfaces),
      isLeader: () => true,
      readAtoms: async () => twoSubnetAtoms,
      createSocket: () => {
        const s = makeFakeSocket();
        sockets.push(s);
        return s as unknown as dgram.Socket;
      },
      createReplySocket: () => {
        const s = makeFakeSocket();
        replySockets.push(s);
        return s as unknown as dgram.Socket;
      },
      createPacketSocket: (ifname: string) => {
        if (ifname === 'eth1') {
          return { kind: 'nic-error' as const, nicError: 'ENETDOWN' };
        }
        const ps = new InMemoryPacketSocket(ETH0_IFINDEX, ETH0_MAC);
        packetSockets.set(ifname, ps);
        return { kind: 'ok' as const, socket: ps };
      },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    const start = service.start('job-1');
    await flush();
    vi.advanceTimersByTime(POLL_MS);
    await flush();

    expect(packetSockets.has('eth0')).toBe(true);
    expect(packetSockets.has('eth1')).toBe(false);

    const rinfo = { address: '0.0.0.0', port: 68, family: 'IPv4', size: 0 } as dgram.RemoteInfo;
    sockets[0].emitMessage(discoverWire('00:aa:bb:cc:dd:01'), rinfo);

    expect(totalSends(sockets, replySockets)).toBe(1);

    service.stop('job-1');
    await expect(start).resolves.toBeUndefined();
  });
});

describe('DhcpServerService bridge-only + renumber + per-subnet source IP', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('(a) a br-brokkr-only host derives a serverId and applies atoms', async () => {
    vi.useFakeTimers();
    const brBrokkr = {
      ...iface('br-brokkr', '10.0.0.5'),
      interfaceType: 'container' as const,
    };
    const bridgeOnlyIfaces = [brBrokkr];
    const sockets: FakeSocket[] = [];
    const replySockets: FakeSocket[] = [];
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const service = new DhcpServerService({
      config: makeRuntimeConfig(),
      resolvePrimary: resolverFrom(bridgeOnlyIfaces),
      resolveInterfaces: () => bridgeOnlyIfaces,
      isLeader: () => true,
      readAtoms: async () =>
        new Map([
          [
            'prefix-1',
            makeAtom({
              subnet: '10.0.0.0/24',
              pools: [{ start: '10.0.0.10', end: '10.0.0.20' }],
              routers: ['10.0.0.1'],
              dnsServers: ['10.0.0.1'],
            }),
          ],
        ]),
      createSocket: () => {
        const s = makeFakeSocket();
        sockets.push(s);
        return s as unknown as dgram.Socket;
      },
      createReplySocket: () => {
        const s = makeFakeSocket();
        replySockets.push(s);
        return s as unknown as dgram.Socket;
      },
      logger,
    });

    const start = service.start('job-1');
    await flush();

    expect(service.getServerId()).toBe('10.0.0.5');
    expect(sockets.length).toBeGreaterThanOrEqual(1);
    expect(sockets[0].bind).toHaveBeenCalledWith(67, '0.0.0.0', expect.any(Function));

    const rinfo = { address: '0.0.0.0', port: 68, family: 'IPv4', size: 0 } as dgram.RemoteInfo;
    sockets[0].emitMessage(discoverWire('00:0b:82:01:fc:42'), rinfo);
    expect(totalSends(sockets, replySockets)).toBe(1);

    service.stop('job-1');
    await expect(start).resolves.toBeUndefined();
  });

  it('(b) a multi-subnet AF_PACKET reply uses the per-subnet source IP, not the global serverId', async () => {
    vi.useFakeTimers();
    const ETH0_MAC = Buffer.from([0x02, 0x00, 0x00, 0x00, 0x00, 0x01]);
    const ETH1_MAC = Buffer.from([0x02, 0x00, 0x00, 0x00, 0x00, 0x02]);
    const twoSubnetInterfaces = [iface('eth0', '10.0.0.1'), iface('eth1', '172.16.0.1')];
    const twoSubnetAtoms = new Map([
      ['prefix-1', makeAtom()],
      [
        'prefix-2',
        makeAtom({
          subnet: '172.16.0.0/24',
          pools: [{ start: '172.16.0.10', end: '172.16.0.20' }],
          routers: ['172.16.0.1'],
          dnsServers: ['172.16.0.1'],
        }),
      ],
    ]);

    const packetSockets = new Map<string, InMemoryPacketSocket>();
    const sockets: FakeSocket[] = [];
    const replySockets: FakeSocket[] = [];
    const ifindexByName: Record<string, number> = { eth0: 1, eth1: 2 };
    const macByName: Record<string, Buffer> = { eth0: ETH0_MAC, eth1: ETH1_MAC };
    const service = new DhcpServerService({
      config: makeRuntimeConfig(),
      resolvePrimary: resolverFrom(twoSubnetInterfaces),
      resolveInterfaces: () => twoSubnetInterfaces,
      isLeader: () => true,
      readAtoms: async () => twoSubnetAtoms,
      createSocket: () => {
        const s = makeFakeSocket();
        sockets.push(s);
        return s as unknown as dgram.Socket;
      },
      createReplySocket: () => {
        const s = makeFakeSocket();
        replySockets.push(s);
        return s as unknown as dgram.Socket;
      },
      createPacketSocket: (ifname: string) => {
        const ps = new InMemoryPacketSocket(ifindexByName[ifname] ?? 0, macByName[ifname]);
        packetSockets.set(ifname, ps);
        return { kind: 'ok' as const, socket: ps };
      },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    const start = service.start('job-1');
    await flush();
    vi.advanceTimersByTime(POLL_MS);
    await flush();

    expect(packetSockets.has('eth1')).toBe(true);

    const CLIENT_MAC = '00:aa:bb:cc:dd:01';
    const eth1 = packetSockets.get('eth1')!;
    eth1.inject({
      ifindex: 2,
      srcMac: macToBytes(CLIENT_MAC),
      frame: buildFrame({
        srcMac: macToBytes(CLIENT_MAC),
        dstMac: Buffer.alloc(6, 0xff),
        srcIp: ipToBuffer('0.0.0.0'),
        dstIp: ipToBuffer('255.255.255.255'),
        srcPort: 68,
        dstPort: 67,
        payload: discoverWire(CLIENT_MAC),
      }),
    });

    expect(eth1.sent).toHaveLength(1);
    const parsed = parseFrame(eth1.sent[0]!.frame);
    expect(bufferToIp(parsed.srcIp)).toBe('172.16.0.1');

    service.stop('job-1');
    await expect(start).resolves.toBeUndefined();
  });

  it('(d) rejects an AUTHORITATIVE atom with empty pool and no reservations', async () => {
    vi.useFakeTimers();
    const emptyPoolAuth = makeAtom({
      pools: [],
      routers: ['10.0.0.1'],
      dnsServers: ['10.0.0.1'],
      reservations: [],
    });
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const sockets: FakeSocket[] = [];
    const service = new DhcpServerService({
      config: makeRuntimeConfig(),
      resolvePrimary: resolverFrom(INTERFACES),
      resolveInterfaces: () => selfInterfaces({ clientFacingOnly: true }, () => INTERFACES),
      isLeader: () => true,
      readAtoms: async () => new Map([['prefix-1', emptyPoolAuth]]),
      createSocket: () => {
        const s = makeFakeSocket();
        sockets.push(s);
        return s as unknown as dgram.Socket;
      },
      createReplySocket: () => makeFakeSocket() as unknown as dgram.Socket,
      logger,
    });

    const start = service.start('job-1');
    await flush();

    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('nothing to serve'), expect.anything());

    service.stop('job-1');
    await expect(start).resolves.toBeUndefined();
  });

  it('(e) accepts a PROXY atom with empty pool (PROXY never serves addresses)', async () => {
    vi.useFakeTimers();
    const emptyPoolProxy = makeAtom({
      mode: 'PROXY',
      pools: [],
      routers: ['10.0.0.1'],
      dnsServers: ['10.0.0.1'],
      reservations: [],
      nextServer: '10.0.0.7',
      ipxeBuildTarget: 'SNPONLY',
    });
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const sockets: FakeSocket[] = [];
    const service = new DhcpServerService({
      config: makeRuntimeConfig(),
      resolvePrimary: resolverFrom(INTERFACES),
      resolveInterfaces: () => selfInterfaces({ clientFacingOnly: true }, () => INTERFACES),
      isLeader: () => true,
      readAtoms: async () => new Map([['prefix-1', emptyPoolProxy]]),
      createSocket: () => {
        const s = makeFakeSocket();
        sockets.push(s);
        return s as unknown as dgram.Socket;
      },
      createReplySocket: () => makeFakeSocket() as unknown as dgram.Socket,
      logger,
    });

    const start = service.start('job-1');
    await flush();

    const nothingToServe = logger.warn.mock.calls.filter((c) => String(c[0]).includes('nothing to serve'));
    expect(nothingToServe).toHaveLength(0);
    expect(sockets.length).toBeGreaterThanOrEqual(1);

    service.stop('job-1');
    await expect(start).resolves.toBeUndefined();
  });

  it('(f) accepts an AUTHORITATIVE atom with empty pool but valid reservations', async () => {
    vi.useFakeTimers();
    const reservationOnlyAuth = makeAtom({
      pools: [],
      routers: ['10.0.0.1'],
      dnsServers: ['10.0.0.1'],
      reservations: [{ mac: 'aa:bb:cc:dd:ee:ff', ip: '10.0.0.50' }],
    });
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const sockets: FakeSocket[] = [];
    const service = new DhcpServerService({
      config: makeRuntimeConfig(),
      resolvePrimary: resolverFrom(INTERFACES),
      resolveInterfaces: () => selfInterfaces({ clientFacingOnly: true }, () => INTERFACES),
      isLeader: () => true,
      readAtoms: async () => new Map([['prefix-1', reservationOnlyAuth]]),
      createSocket: () => {
        const s = makeFakeSocket();
        sockets.push(s);
        return s as unknown as dgram.Socket;
      },
      createReplySocket: () => makeFakeSocket() as unknown as dgram.Socket,
      logger,
    });

    const start = service.start('job-1');
    await flush();

    const nothingToServe = logger.warn.mock.calls.filter((c) => String(c[0]).includes('nothing to serve'));
    expect(nothingToServe).toHaveLength(0);
    expect(sockets.length).toBeGreaterThanOrEqual(1);

    service.stop('job-1');
    await expect(start).resolves.toBeUndefined();
  });

  it('(c) a NIC renumber refreshes the manager serverId on the next reconcile', async () => {
    vi.useFakeTimers();
    let currentIfaces = [iface('eth0', '10.0.0.1')];
    const sockets: FakeSocket[] = [];
    const replySockets: FakeSocket[] = [];
    const service = new DhcpServerService({
      config: makeRuntimeConfig(),
      resolvePrimary: (opts, discover) => selfPrimary(opts, discover ?? (() => currentIfaces)),
      resolveInterfaces: () => currentIfaces,
      isLeader: () => true,
      readAtoms: async () =>
        new Map([
          [
            'prefix-1',
            makeAtom({
              subnet: `${currentIfaces[0].ip.split('.').slice(0, 3).join('.')}.0/24`,
              pools: [
                {
                  start: `${currentIfaces[0].ip.split('.').slice(0, 3).join('.')}.10`,
                  end: `${currentIfaces[0].ip.split('.').slice(0, 3).join('.')}.20`,
                },
              ],
              routers: [currentIfaces[0].ip],
              dnsServers: [currentIfaces[0].ip],
            }),
          ],
        ]),
      createSocket: () => {
        const s = makeFakeSocket();
        sockets.push(s);
        return s as unknown as dgram.Socket;
      },
      createReplySocket: () => {
        const s = makeFakeSocket();
        replySockets.push(s);
        return s as unknown as dgram.Socket;
      },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    const start = service.start('job-1');
    await flush();
    expect(service.getServerId()).toBe('10.0.0.1');

    currentIfaces = [iface('eth0', '192.168.1.1')];
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await flush();

    expect(service.getServerId()).toBe('192.168.1.1');

    service.stop('job-1');
    await expect(start).resolves.toBeUndefined();
  });
});

describe('DhcpServerService zone-ops runtime tuning (refreshRuntimeConfig)', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const BASE_OPS: DhcpZoneOpsAtomValue = {
    leaderPollMs: POLL_MS,
    pruneIntervalMs: 60000,
    declineBackoffSeconds: 600,
  };

  function opsMock(initial: DhcpZoneOpsAtomValue | null) {
    return vi.fn<(jobId: string) => Promise<DhcpZoneOpsAtomValue | null>>().mockResolvedValue(initial);
  }

  function buildTuningService(readZoneOps: ReturnType<typeof opsMock>) {
    const readAtoms = vi.fn(async () => new Map([['prefix-1', makeAtom()]]));
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const service = new DhcpServerService({
      config: makeRuntimeConfig(),
      resolvePrimary: resolverFrom(INTERFACES),
      resolveInterfaces: () => selfInterfaces({ clientFacingOnly: true }, () => INTERFACES),
      isLeader: () => true,
      readAtoms,
      readZoneOps,
      createSocket: () => makeFakeSocket() as unknown as dgram.Socket,
      createReplySocket: () => makeFakeSocket() as unknown as dgram.Socket,
      logger,
    });
    return { service, readAtoms, logger };
  }

  function tuningChangedLogs(logger: { info: ReturnType<typeof vi.fn> }): number {
    return logger.info.mock.calls.filter(
      ([message]) => typeof message === 'string' && message.includes('DHCP runtime tuning changed'),
    ).length;
  }

  function hotSwapLogs(logger: { info: ReturnType<typeof vi.fn> }): number {
    return logger.info.mock.calls.filter(
      ([message]) => typeof message === 'string' && message.includes('DHCP atom hot-swap: rebuilt engine'),
    ).length;
  }

  it('keeps the current tuning and cadence when the zone ops atom is absent', async () => {
    vi.useFakeTimers();
    const readZoneOps = opsMock(null);
    const { service, readAtoms, logger } = buildTuningService(readZoneOps);

    const start = service.start('job-1');
    await flush();
    const baseline = readAtoms.mock.calls.length;

    await vi.advanceTimersByTimeAsync(POLL_MS);
    await flush();
    expect(readAtoms.mock.calls.length).toBe(baseline + 1);
    expect(tuningChangedLogs(logger)).toBe(0);

    service.stop('job-1');
    await expect(start).resolves.toBeUndefined();
  });

  it('does not re-arm timers when the ops atom matches the current config', async () => {
    vi.useFakeTimers();
    const readZoneOps = opsMock(BASE_OPS);
    const { service, readAtoms, logger } = buildTuningService(readZoneOps);

    const start = service.start('job-1');
    await flush();
    const baseline = readAtoms.mock.calls.length;

    await vi.advanceTimersByTimeAsync(POLL_MS * 2);
    await flush();
    expect(readAtoms.mock.calls.length).toBe(baseline + 2);
    expect(tuningChangedLogs(logger)).toBe(0);

    service.stop('job-1');
    await expect(start).resolves.toBeUndefined();
  });

  it('re-arms the poll timer at the new cadence when leaderPollMs changes', async () => {
    vi.useFakeTimers();
    const readZoneOps = opsMock(null);
    const { service, readAtoms, logger } = buildTuningService(readZoneOps);

    const start = service.start('job-1');
    await flush();

    readZoneOps.mockResolvedValue({ ...BASE_OPS, leaderPollMs: 200 });
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await flush();
    expect(tuningChangedLogs(logger)).toBe(1);

    const baseline = readAtoms.mock.calls.length;
    await vi.advanceTimersByTimeAsync(600);
    await flush();
    expect(readAtoms.mock.calls.length).toBe(baseline + 3);

    service.stop('job-1');
    await expect(start).resolves.toBeUndefined();
  });

  it('re-arms the prune timer at the new cadence when pruneIntervalMs changes', async () => {
    vi.useFakeTimers();
    const pruneSpy = vi.spyOn(DhcpEngine.prototype, 'pruneLeases');
    const readZoneOps = opsMock(null);
    const { service, readAtoms } = buildTuningService(readZoneOps);

    const start = service.start('job-1');
    await flush();

    readZoneOps.mockResolvedValue({ ...BASE_OPS, pruneIntervalMs: 500 });
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await flush();

    const pruneBaseline = pruneSpy.mock.calls.length;
    const pollBaseline = readAtoms.mock.calls.length;
    await vi.advanceTimersByTimeAsync(500);
    await flush();
    expect(pruneSpy.mock.calls.length).toBe(pruneBaseline + 1);
    expect(readAtoms.mock.calls.length).toBe(pollBaseline);

    service.stop('job-1');
    await expect(start).resolves.toBeUndefined();
  });

  it('a declineBackoffSeconds-only change rebuilds the engine on the same pass without re-arming timers', async () => {
    vi.useFakeTimers();
    const readZoneOps = opsMock(null);
    const { service, readAtoms, logger } = buildTuningService(readZoneOps);

    const start = service.start('job-1');
    await flush();
    expect(hotSwapLogs(logger)).toBe(1);

    readZoneOps.mockResolvedValue({ ...BASE_OPS, declineBackoffSeconds: 60 });
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await flush();
    expect(tuningChangedLogs(logger)).toBe(1);
    expect(hotSwapLogs(logger)).toBe(2);

    const baseline = readAtoms.mock.calls.length;
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await flush();
    expect(readAtoms.mock.calls.length).toBe(baseline + 1);
    expect(hotSwapLogs(logger)).toBe(2);

    service.stop('job-1');
    await expect(start).resolves.toBeUndefined();
  });
});

describe('DhcpServerService primary interface pick and reconcile skip reasons', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function buildUnfilteredService(
    ifaces: NetworkInterface[],
    readAtoms?: (jobId: string) => Promise<ReadonlyMap<string, DhcpAtomValue> | null>,
  ): DhcpServerService {
    return new DhcpServerService({
      config: makeRuntimeConfig(),
      resolvePrimary: resolverFrom(ifaces),
      resolveInterfaces: () => ifaces,
      isLeader: () => true,
      readAtoms,
      createSocket: () => makeFakeSocket() as unknown as dgram.Socket,
      createReplySocket: () => makeFakeSocket() as unknown as dgram.Socket,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
  }

  function debugMessages(): string[] {
    return vi.mocked(logDebug).mock.calls.map((call) => String(call[0]));
  }

  it('never picks a loopback alias as the primary interface', async () => {
    vi.useFakeTimers();
    const loFirst = [iface('lo', '10.0.0.9'), iface('eth0', '172.16.0.1')];
    const service = buildUnfilteredService(loFirst, async () => bothSubnetsAtoms());

    const start = service.start('job-1');
    await flush();

    expect(service.getServerId()).toBe('172.16.0.1');
    expect(service.getStandbyHealth().primaryInterface).toEqual({ name: 'eth0', ip: '172.16.0.1' });

    service.stop('job-1');
    await expect(start).resolves.toBeUndefined();
  });

  it('falls back to the only interface when nothing is client-facing', async () => {
    vi.useFakeTimers();
    const brOnly = [iface('br-brokkr', '10.0.0.5')];
    const service = buildUnfilteredService(brOnly, async () => new Map([['prefix-1', makeAtom()]]));

    const start = service.start('job-1');
    await flush();

    expect(service.getServerId()).toBe('10.0.0.5');
    expect(service.getStandbyHealth().primaryInterface).toEqual({ name: 'br-brokkr', ip: '10.0.0.5' });

    service.stop('job-1');
    await expect(start).resolves.toBeUndefined();
  });

  it('logs why a reconcile pass did nothing', async () => {
    vi.useFakeTimers();
    vi.mocked(logDebug).mockClear();

    const noReader = buildUnfilteredService(INTERFACES);
    const noReaderStart = noReader.start('job-no-reader');
    await flush();
    expect(debugMessages()).toContainEqual(expect.stringContaining('reconcile atom step skipped: no reader'));
    noReader.stop('job-no-reader');
    await expect(noReaderStart).resolves.toBeUndefined();

    const readerError = buildUnfilteredService(INTERFACES, async () => null);
    const readerErrorStart = readerError.start('job-reader-error');
    await flush();
    expect(debugMessages()).toContainEqual(expect.stringContaining('reconcile atom step skipped: reader error'));
    readerError.stop('job-reader-error');
    await expect(readerErrorStart).resolves.toBeUndefined();

    const unchanged = buildUnfilteredService(INTERFACES, async () => new Map([['prefix-1', makeAtom()]]));
    const unchangedStart = unchanged.start('job-unchanged');
    await flush();
    expect(debugMessages()).not.toContainEqual(
      expect.stringContaining('reconcile atom step skipped: unchanged fingerprint'),
    );
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await flush();
    expect(debugMessages()).toContainEqual(
      expect.stringContaining('reconcile atom step skipped: unchanged fingerprint'),
    );
    unchanged.stop('job-unchanged');
    await expect(unchangedStart).resolves.toBeUndefined();
  });
});
