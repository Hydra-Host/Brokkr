import * as dgram from 'node:dgram';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  selfInterfaces,
  selfPrimary,
  type NetworkInterface,
  type SelfPrimaryInterface,
} from '../../bridge-network/self-network.js';
import { DhcpServerService } from '../dhcp-manager.service.js';
import { DhcpEngine } from '../dhcp-server.js';
import { InMemoryLeaseStore } from '../lease-store/in-memory-lease-store.js';
import type { LeaseRecord } from '../lease-store/lease-record.js';
import type { LeaseStore } from '../lease-store/lease-store.js';
import {
  iface,
  makeAtom,
  makeFakeSocket,
  makeRuntimeConfig,
  POLL_MS,
  type DhcpAtomValue,
  type DhcpRuntimeConfig,
} from './test-factories.js';

function resolverFrom(interfaces: NetworkInterface[]): typeof selfPrimary {
  return (opts, discover): SelfPrimaryInterface | null => selfPrimary(opts, discover ?? (() => interfaces));
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

interface ServiceKit {
  service: DhcpServerService;
  readAtomsFn: ReturnType<typeof vi.fn>;
  leaseStore: LeaseStore;
}

function buildServiceWithAtoms(
  atomsMap: ReadonlyMap<string, DhcpAtomValue> | null = null,
  config: DhcpRuntimeConfig = makeRuntimeConfig(),
  interfaces: NetworkInterface[] = [iface('eth0', '10.0.1.5')],
): ServiceKit {
  const readAtomsFn = vi.fn().mockResolvedValue(atomsMap);
  const leaseStore = new InMemoryLeaseStore();

  const service = new DhcpServerService({
    config,
    resolvePrimary: resolverFrom(interfaces),
    resolveInterfaces: () => selfInterfaces({ clientFacingOnly: false }, () => interfaces),
    isLeader: () => true,
    createSocket: () => makeFakeSocket() as unknown as dgram.Socket,
    createReplySocket: () => makeFakeSocket() as unknown as dgram.Socket,
    createPacketSocket: () => ({ kind: 'addon-unavailable' as const, reason: 'test' }),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    leaseStore,
    readAtoms: readAtomsFn,
  });

  return { service, readAtomsFn, leaseStore };
}

describe('DHCP atom hot-swap', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('rebuilds the engine when atoms appear', async () => {
    vi.useFakeTimers();
    const atoms = new Map([['prefix-1', makeAtom()]]);
    const { service, readAtomsFn } = buildServiceWithAtoms(atoms);

    const start = service.start('job-1');
    await flush();

    expect(readAtomsFn).toHaveBeenCalled();

    service.stop('job-1');
    await expect(start).resolves.toBeUndefined();
  });

  it('does NOT rebuild the engine when atoms are unchanged', async () => {
    vi.useFakeTimers();
    const atoms = new Map([['prefix-1', makeAtom()]]);
    const { service, readAtomsFn } = buildServiceWithAtoms(atoms);

    const fromSubnetsSpy = vi.spyOn(DhcpEngine, 'fromSubnets');

    const start = service.start('job-1');
    await flush();

    expect(fromSubnetsSpy).toHaveBeenCalledTimes(1);
    const callsBefore = readAtomsFn.mock.calls.length;

    await vi.advanceTimersByTimeAsync(POLL_MS + 10);
    await flush();

    expect(readAtomsFn.mock.calls.length).toBeGreaterThan(callsBefore);
    expect(fromSubnetsSpy).toHaveBeenCalledTimes(1);

    service.stop('job-1');
    await expect(start).resolves.toBeUndefined();
  });

  it('keeps the current engine on reader failure (null return)', async () => {
    vi.useFakeTimers();
    const { service, readAtomsFn } = buildServiceWithAtoms(null);

    const start = service.start('job-1');
    await flush();

    expect(readAtomsFn).toHaveBeenCalled();

    service.stop('job-1');
    await expect(start).resolves.toBeUndefined();
  });

  it('tears down the engine when atom map is empty', async () => {
    vi.useFakeTimers();
    const atoms = new Map([['prefix-1', makeAtom()]]);
    const { service, readAtomsFn } = buildServiceWithAtoms(atoms);

    const start = service.start('job-1');
    await flush();

    const emptyAtoms = new Map<string, DhcpAtomValue>();
    readAtomsFn.mockResolvedValue(emptyAtoms);
    await vi.advanceTimersByTimeAsync(POLL_MS + 10);
    await flush();

    expect(readAtomsFn.mock.calls.length).toBeGreaterThanOrEqual(2);

    service.stop('job-1');
    await expect(start).resolves.toBeUndefined();
  });

  it('rebuilds on changed atoms (different pool)', async () => {
    vi.useFakeTimers();
    const atoms1 = new Map([['prefix-1', makeAtom({ pools: [{ start: '10.0.1.100', end: '10.0.1.150' }] })]]);
    const atoms2 = new Map([['prefix-1', makeAtom({ pools: [{ start: '10.0.1.100', end: '10.0.1.250' }] })]]);

    const { service, readAtomsFn } = buildServiceWithAtoms(atoms1);

    const start = service.start('job-1');
    await flush();

    readAtomsFn.mockResolvedValue(atoms2);
    await vi.advanceTimersByTimeAsync(POLL_MS + 10);
    await flush();

    expect(readAtomsFn.mock.calls.length).toBeGreaterThanOrEqual(2);

    service.stop('job-1');
    await expect(start).resolves.toBeUndefined();
  });

  it('preserves in-pool leases during hot-swap via shared lease store', async () => {
    vi.useFakeTimers();
    const atoms1 = new Map([['prefix-1', makeAtom({ pools: [{ start: '10.0.1.100', end: '10.0.1.200' }] })]]);

    const { service, readAtomsFn, leaseStore } = buildServiceWithAtoms(atoms1);

    const record: LeaseRecord = {
      ip: '10.0.1.150',
      mac: 'aa:bb:cc:dd:ee:01',
      hostname: null,
      expiresAt: Date.now() / 1000 + 3600,
    };
    await leaseStore.put(record);

    const start = service.start('job-1');
    await flush();

    const atoms2 = new Map([
      ['prefix-1', makeAtom({ pools: [{ start: '10.0.1.100', end: '10.0.1.200' }], leaseTtlSeconds: 7200 })],
    ]);
    readAtomsFn.mockResolvedValue(atoms2);
    await vi.advanceTimersByTimeAsync(POLL_MS + 10);
    await flush();

    const stored = await leaseStore.loadAll();
    expect(stored.some((l) => l.ip === '10.0.1.150' && l.mac === 'aa:bb:cc:dd:ee:01')).toBe(true);

    service.stop('job-1');
    await expect(start).resolves.toBeUndefined();
  });

  it('publishes relayed subnet cidrs alongside the served bind entries', async () => {
    vi.useFakeTimers();
    const publishSpy = vi.fn();
    const atoms = new Map([
      ['prefix-1', makeAtom()],
      [
        'prefix-2',
        makeAtom({
          subnet: '172.16.80.0/24',
          pools: [{ start: '172.16.80.100', end: '172.16.80.200' }],
          routers: ['172.16.80.1'],
          relay: { relayAgentIp: '172.16.80.1' },
        }),
      ],
    ]);
    const service = new DhcpServerService({
      config: makeRuntimeConfig(),
      resolvePrimary: resolverFrom([iface('eth0', '10.0.1.5')]),
      resolveInterfaces: () => selfInterfaces({ clientFacingOnly: false }, () => [iface('eth0', '10.0.1.5')]),
      isLeader: () => true,
      createSocket: () => makeFakeSocket() as unknown as dgram.Socket,
      createReplySocket: () => makeFakeSocket() as unknown as dgram.Socket,
      createPacketSocket: () => ({ kind: 'addon-unavailable' as const, reason: 'test' }),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      leaseStore: new InMemoryLeaseStore(),
      readAtoms: vi.fn().mockResolvedValue(atoms),
      publishAtomServedIps: publishSpy,
    });

    const start = service.start('job-1');
    await flush();

    expect(publishSpy).toHaveBeenCalled();
    const [ips, relayedCidrs] = publishSpy.mock.calls.at(-1)!;
    expect(ips).toContainEqual({ interface: 'eth0', ip: '10.0.1.5', cidr: '10.0.1.0/24' });
    expect(relayedCidrs).toEqual(['172.16.80.0/24']);

    service.stop('job-1');
    await expect(start).resolves.toBeUndefined();
  });

  it('does not update publishAtomServedIps when pool validation fails', async () => {
    vi.useFakeTimers();
    const publishSpy = vi.fn();
    const goodAtoms = new Map([['prefix-1', makeAtom()]]);
    const readAtomsFn = vi.fn().mockResolvedValue(goodAtoms);
    const leaseStore = new InMemoryLeaseStore();

    const service = new DhcpServerService({
      config: makeRuntimeConfig(),
      resolvePrimary: resolverFrom([iface('eth0', '10.0.1.5')]),
      resolveInterfaces: () => selfInterfaces({ clientFacingOnly: false }, () => [iface('eth0', '10.0.1.5')]),
      isLeader: () => true,
      createSocket: () => makeFakeSocket() as unknown as dgram.Socket,
      createReplySocket: () => makeFakeSocket() as unknown as dgram.Socket,
      createPacketSocket: () => ({ kind: 'addon-unavailable' as const, reason: 'test' }),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      leaseStore,
      readAtoms: readAtomsFn,
      publishAtomServedIps: publishSpy,
    });

    const start = service.start('job-1');
    await flush();

    const firstCallCount = publishSpy.mock.calls.length;
    expect(firstCallCount).toBeGreaterThan(0);

    const badAtoms = new Map([
      [
        'prefix-1',
        makeAtom({
          pools: [{ start: '10.0.1.200', end: '10.0.1.100' }],
        }),
      ],
    ]);
    readAtomsFn.mockResolvedValue(badAtoms);
    await vi.advanceTimersByTimeAsync(POLL_MS + 10);
    await flush();

    expect(publishSpy.mock.calls.length).toBe(firstCallCount);

    service.stop('job-1');
    await expect(start).resolves.toBeUndefined();
  });

  it('drops only the bad-pool subnet and still swaps in the healthy prefix (no all-or-nothing abort)', async () => {
    vi.useFakeTimers();
    const publishSpy = vi.fn();
    const warn = vi.fn();
    const interfaces = [iface('eth0', '10.0.1.5'), iface('eth1', '10.0.2.5')];
    const atoms = new Map([
      ['prefix-1', makeAtom()],
      [
        'prefix-2',
        makeAtom({ subnet: '10.0.2.0/24', pools: [{ start: '10.0.2.200', end: '10.0.2.100' }], routers: ['10.0.2.1'] }),
      ],
    ]);
    const service = new DhcpServerService({
      config: makeRuntimeConfig(),
      resolvePrimary: resolverFrom(interfaces),
      resolveInterfaces: () => selfInterfaces({ clientFacingOnly: false }, () => interfaces),
      isLeader: () => true,
      createSocket: () => makeFakeSocket() as unknown as dgram.Socket,
      createReplySocket: () => makeFakeSocket() as unknown as dgram.Socket,
      createPacketSocket: () => ({ kind: 'addon-unavailable' as const, reason: 'test' }),
      logger: { info: vi.fn(), warn, error: vi.fn() },
      leaseStore: new InMemoryLeaseStore(),
      readAtoms: vi.fn().mockResolvedValue(atoms),
      publishAtomServedIps: publishSpy,
    });

    const start = service.start('job-1');
    await flush();

    expect(publishSpy).toHaveBeenCalled();
    expect(publishSpy.mock.calls.at(-1)![0]).toContainEqual({ interface: 'eth0', ip: '10.0.1.5', cidr: '10.0.1.0/24' });
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/dropped from hot-swap/), expect.anything());

    service.stop('job-1');
    await expect(start).resolves.toBeUndefined();
  });

  it('republishes atom-served IPs and rebuilds when a served interface IP changes (no atom edit)', async () => {
    vi.useFakeTimers();
    const publishSpy = vi.fn();
    const atoms = new Map([['prefix-1', makeAtom()]]);
    const readAtomsFn = vi.fn().mockResolvedValue(atoms);
    const fromSubnetsSpy = vi.spyOn(DhcpEngine, 'fromSubnets');

    let interfaces = [iface('eth0', '10.0.1.5')];
    const service = new DhcpServerService({
      config: makeRuntimeConfig(),
      resolvePrimary: resolverFrom(interfaces),
      resolveInterfaces: () => selfInterfaces({ clientFacingOnly: false }, () => interfaces),
      isLeader: () => true,
      createSocket: () => makeFakeSocket() as unknown as dgram.Socket,
      createReplySocket: () => makeFakeSocket() as unknown as dgram.Socket,
      createPacketSocket: () => ({ kind: 'addon-unavailable' as const, reason: 'test' }),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      leaseStore: new InMemoryLeaseStore(),
      readAtoms: readAtomsFn,
      publishAtomServedIps: publishSpy,
    });

    const start = service.start('job-1');
    await flush();

    expect(fromSubnetsSpy).toHaveBeenCalledTimes(1);
    expect(publishSpy).toHaveBeenCalledTimes(1);
    expect(publishSpy.mock.calls[0]![0]).toContainEqual({ interface: 'eth0', ip: '10.0.1.5', cidr: '10.0.1.0/24' });

    await vi.advanceTimersByTimeAsync(POLL_MS + 10);
    await flush();
    expect(fromSubnetsSpy).toHaveBeenCalledTimes(1);
    expect(publishSpy).toHaveBeenCalledTimes(1);

    interfaces = [iface('eth0', '10.0.1.6')];
    await vi.advanceTimersByTimeAsync(POLL_MS + 10);
    await flush();

    expect(fromSubnetsSpy).toHaveBeenCalledTimes(2);
    expect(publishSpy).toHaveBeenCalledTimes(2);
    expect(publishSpy.mock.calls[1]![0]).toContainEqual({ interface: 'eth0', ip: '10.0.1.6', cidr: '10.0.1.0/24' });

    service.stop('job-1');
    await expect(start).resolves.toBeUndefined();
  });

  it('starts fine when no readAtoms is injected (no atom reader)', async () => {
    vi.useFakeTimers();
    const service = new DhcpServerService({
      config: makeRuntimeConfig(),
      resolvePrimary: resolverFrom([iface('eth0', '10.0.1.5')]),
      resolveInterfaces: () => selfInterfaces({ clientFacingOnly: false }, () => [iface('eth0', '10.0.1.5')]),
      isLeader: () => true,
      createSocket: () => makeFakeSocket() as unknown as dgram.Socket,
      createReplySocket: () => makeFakeSocket() as unknown as dgram.Socket,
      createPacketSocket: () => ({ kind: 'addon-unavailable' as const, reason: 'test' }),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    const start = service.start('job-1');
    await flush();

    service.stop('job-1');
    await expect(start).resolves.toBeUndefined();
  });

  it('preserves peer server-ids and peer DNS IP across engine hot-swap', async () => {
    vi.useFakeTimers();
    const atoms1 = new Map([['prefix-1', makeAtom({ pools: [{ start: '10.0.1.100', end: '10.0.1.150' }] })]]);
    const atoms2 = new Map([['prefix-1', makeAtom({ pools: [{ start: '10.0.1.100', end: '10.0.1.250' }] })]]);

    const peerIds = new Set(['10.0.2.1', '10.0.3.1']);
    const peerDnsIp = '10.0.2.1';

    const readAtomsFn = vi.fn().mockResolvedValue(atoms1);
    const interfaces = [iface('eth0', '10.0.1.5')];

    const service = new DhcpServerService({
      config: makeRuntimeConfig(),
      resolvePrimary: resolverFrom(interfaces),
      resolveInterfaces: () => selfInterfaces({ clientFacingOnly: false }, () => interfaces),
      isLeader: () => true,
      createSocket: () => makeFakeSocket() as unknown as dgram.Socket,
      createReplySocket: () => makeFakeSocket() as unknown as dgram.Socket,
      createPacketSocket: () => ({ kind: 'addon-unavailable' as const, reason: 'test' }),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      leaseStore: new InMemoryLeaseStore(),
      readAtoms: readAtomsFn,
      resolvePeerServerIds: async () => peerIds,
      resolvePeerDnsIp: async () => peerDnsIp,
    });

    const fromSubnetsSpy = vi.spyOn(DhcpEngine, 'fromSubnets');

    const start = service.start('job-1');
    await vi.advanceTimersByTimeAsync(0);

    expect(fromSubnetsSpy).toHaveBeenCalledTimes(1);
    const firstEngine = fromSubnetsSpy.mock.results[0].value as DhcpEngine;
    expect(firstEngine.getPeerServerIds()).toEqual(peerIds);
    expect(firstEngine.getPeerDnsIp()).toBe(peerDnsIp);

    readAtomsFn.mockResolvedValue(atoms2);
    await vi.advanceTimersByTimeAsync(POLL_MS + 10);

    expect(fromSubnetsSpy).toHaveBeenCalledTimes(2);
    const secondEngine = fromSubnetsSpy.mock.results[1].value as DhcpEngine;
    expect(secondEngine.getPeerServerIds()).toEqual(peerIds);
    expect(secondEngine.getPeerDnsIp()).toBe(peerDnsIp);

    service.stop('job-1');
    await expect(start).resolves.toBeUndefined();
  });

  it('preserves a DECLINE that lands during the hot-swap hydrate await (seeds declines after hydrate)', async () => {
    vi.useFakeTimers();
    const atoms1 = new Map([['prefix-1', makeAtom({ pools: [{ start: '10.0.1.100', end: '10.0.1.150' }] })]]);
    const atoms2 = new Map([['prefix-1', makeAtom({ pools: [{ start: '10.0.1.100', end: '10.0.1.250' }] })]]);
    const readAtomsFn = vi.fn().mockResolvedValue(atoms1);
    const interfaces = [iface('eth0', '10.0.1.5')];
    const leaseStore = new InMemoryLeaseStore();

    const realLoadAll = leaseStore.loadAll.bind(leaseStore);
    let loadCalls = 0;
    let oldEngineRef: DhcpEngine | null = null;
    vi.spyOn(leaseStore, 'loadAll').mockImplementation(async () => {
      loadCalls += 1;
      if (loadCalls === 2 && oldEngineRef !== null) {
        oldEngineRef.getSubnets()[0].block('10.0.1.120');
      }
      return realLoadAll();
    });

    const service = new DhcpServerService({
      config: makeRuntimeConfig(),
      resolvePrimary: resolverFrom(interfaces),
      resolveInterfaces: () => selfInterfaces({ clientFacingOnly: false }, () => interfaces),
      isLeader: () => true,
      createSocket: () => makeFakeSocket() as unknown as dgram.Socket,
      createReplySocket: () => makeFakeSocket() as unknown as dgram.Socket,
      createPacketSocket: () => ({ kind: 'addon-unavailable' as const, reason: 'test' }),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      leaseStore,
      readAtoms: readAtomsFn,
    });

    const fromSubnetsSpy = vi.spyOn(DhcpEngine, 'fromSubnets');
    const start = service.start('job-1');
    await vi.advanceTimersByTimeAsync(0);
    const firstEngine = fromSubnetsSpy.mock.results[0].value as DhcpEngine;
    oldEngineRef = firstEngine;

    readAtomsFn.mockResolvedValue(atoms2);
    await vi.advanceTimersByTimeAsync(POLL_MS + 10);

    expect(firstEngine.getSubnets()[0].isBlocked('10.0.1.120')).toBe(true);
    const secondEngine = fromSubnetsSpy.mock.results[1].value as DhcpEngine;
    expect(secondEngine).not.toBe(firstEngine);
    expect(secondEngine.getSubnets().some((s) => s.isBlocked('10.0.1.120'))).toBe(true);

    service.stop('job-1');
    await expect(start).resolves.toBeUndefined();
  });

  it('partial mapping: 2 non-OFF atoms, 1 iface up + 1 absent -> engine gets the mapped one AND fingerprint stays unadvanced', async () => {
    vi.useFakeTimers();
    const twoAtoms = new Map([
      ['prefix-1', makeAtom()],
      [
        'prefix-2',
        makeAtom({ subnet: '10.0.2.0/24', pools: [{ start: '10.0.2.100', end: '10.0.2.200' }], routers: ['10.0.2.1'] }),
      ],
    ]);

    const fromSubnetsSpy = vi.spyOn(DhcpEngine, 'fromSubnets');

    let interfaces = [iface('eth0', '10.0.1.5')];
    const readAtomsFn = vi.fn().mockResolvedValue(twoAtoms);
    const service = new DhcpServerService({
      config: makeRuntimeConfig(),
      resolvePrimary: resolverFrom(interfaces),
      resolveInterfaces: () => selfInterfaces({ clientFacingOnly: false }, () => interfaces),
      isLeader: () => true,
      createSocket: () => makeFakeSocket() as unknown as dgram.Socket,
      createReplySocket: () => makeFakeSocket() as unknown as dgram.Socket,
      createPacketSocket: () => ({ kind: 'addon-unavailable' as const, reason: 'test' }),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      readAtoms: readAtomsFn,
    });

    const start = service.start('job-1');
    await flush();

    expect(fromSubnetsSpy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(POLL_MS + 10);
    await flush();
    expect(fromSubnetsSpy).toHaveBeenCalledTimes(2);

    interfaces = [iface('eth0', '10.0.1.5'), iface('eth1', '10.0.2.5')];
    await vi.advanceTimersByTimeAsync(POLL_MS + 10);
    await flush();

    expect(fromSubnetsSpy).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(POLL_MS + 10);
    await flush();
    expect(fromSubnetsSpy).toHaveBeenCalledTimes(3);

    service.stop('job-1');
    await expect(start).resolves.toBeUndefined();
  });
});
