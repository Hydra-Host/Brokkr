import * as dgram from 'node:dgram';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RecordingMeterFake } from '../../__test__/telemetry-meter-fake.js';
import {
  selfInterfaces,
  selfPrimary,
  type NetworkInterface,
  type SelfPrimaryInterface,
} from '../../bridge-network/self-network.js';
import { DhcpServerService } from '../dhcp-manager.service.js';
import { DHCPDISCOVER, DHCPREQUEST, encodeIp, OPT_REQUESTED_IP, OPT_SERVER_ID } from '../dhcp-options.js';
import { DhcpEngine } from '../dhcp-server.js';
import { InMemoryLeaseStore } from '../lease-store/in-memory-lease-store.js';
import { Subnet, type SubnetConfig } from '../subnet.js';
import {
  iface,
  makeAtom,
  makeFakeSocket,
  makeRuntimeConfig,
  POLL_MS,
  request,
  type DhcpAtomValue,
} from './test-factories.js';

const holder = vi.hoisted((): { fake: RecordingMeterFake | null } => ({ fake: null }));

vi.mock('@repo/telemetry', async () => {
  const { createRecordingMeterFake } = await import('../../__test__/telemetry-meter-fake.js');
  const fake = createRecordingMeterFake();
  holder.fake = fake;
  return {
    getTelemetryMeter: () => fake.meter,
    emitTelemetryLog: vi.fn(),
    getBullMqTelemetry: () => undefined,
    isTelemetryEnabled: () => false,
    enrichActiveSpan: vi.fn(),
  };
});

let telemetryFake: RecordingMeterFake;
beforeEach(() => {
  const fake = holder.fake;
  if (fake === null) throw new Error('@repo/telemetry mock did not install the meter fake');
  telemetryFake = fake;
});

const MESSAGES = 'brokkr.dhcp.messages';
const LEASES_ACTIVE = 'brokkr.dhcp.leases_active';
const POOL_SIZE = 'brokkr.dhcp.pool_size';
const ENGINE_REBUILDS = 'brokkr.dhcp.engine_rebuilds';

function messageTypes(): Array<Record<string, unknown> | undefined> {
  return (telemetryFake.counters[MESSAGES] ?? []).map((entry) => entry.attrs);
}

function subnetConfig(overrides: Partial<SubnetConfig> = {}): SubnetConfig {
  return {
    subnetMask: '255.255.255.0',
    rangeStart: '10.0.1.100',
    rangeEnd: '10.0.1.200',
    reservations: [],
    excludeIps: [],
    routers: [],
    dnsServers: [],
    leaseTtlSeconds: 3600,
    declineBackoffSeconds: 600,
    tftpServer: '',
    bootfile: '',
    bootfileByArch: new Map(),
    bootBootfile: '',
    bootServerName: '',
    bootServerAddress: '',
    dhcpOptions: [],
    dnsSelf: false,
    serverId: '10.0.1.1',
    ...overrides,
  };
}

function buildEngine(): DhcpEngine {
  return DhcpEngine.fromSubnets(
    { mode: 'AUTHORITATIVE', networks: [{ interfaceKey: 'eth0', subnets: [subnetConfig()] }] },
    () => 1000,
    new InMemoryLeaseStore(),
    { warn: vi.fn(), error: vi.fn() },
  );
}

const INGRESS = { ifindex: 1, ifname: 'eth0' };

describe('DhcpEngine message telemetry', () => {
  beforeEach(() => {
    telemetryFake.reset();
  });

  it('counts a handled DISCOVER and the OFFER it produces', () => {
    const engine = buildEngine();
    const reply = engine.handle(request(DHCPDISCOVER), '10.0.1.1', false, INGRESS);

    expect(reply).not.toBeNull();
    expect(messageTypes()).toEqual([{ type: 'discover' }, { type: 'offer' }]);
  });

  it('counts a SELECTING REQUEST and the ACK it produces', () => {
    const engine = buildEngine();
    const req = request(DHCPREQUEST, {
      options: new Map([
        [OPT_SERVER_ID, encodeIp('10.0.1.1')],
        [OPT_REQUESTED_IP, encodeIp('10.0.1.100')],
      ]),
    });
    const reply = engine.handle(req, '10.0.1.1', false, INGRESS);

    expect(reply).not.toBeNull();
    expect(messageTypes()).toEqual([{ type: 'request' }, { type: 'ack' }]);
  });

  it('counts the NAK sent for an off-subnet REQUEST', () => {
    const engine = buildEngine();
    const req = request(DHCPREQUEST, {
      options: new Map([
        [OPT_SERVER_ID, encodeIp('10.0.1.1')],
        [OPT_REQUESTED_IP, encodeIp('192.168.9.9')],
      ]),
    });
    const reply = engine.handle(req, '10.0.1.1', false, INGRESS);

    expect(reply?.isNak).toBe(true);
    expect(messageTypes()).toEqual([{ type: 'request' }, { type: 'nak' }]);
  });
});

describe('Subnet gauge sources', () => {
  it('derives the CIDR label and static pool capacity at construction', () => {
    const subnet = new Subnet(subnetConfig(), () => 1000);
    expect(subnet.cidr).toBe('10.0.1.0/24');
    expect(subnet.poolSize).toBe(101);
  });

  it('excluded in-pool IPs shrink capacity; out-of-pool reservations grow it', () => {
    const subnet = new Subnet(
      subnetConfig({
        excludeIps: ['10.0.1.150'],
        reservations: [{ mac: 'aa:bb:cc:dd:ee:ff', ip: '10.0.1.50' }],
      }),
      () => 1000,
    );
    expect(subnet.poolSize).toBe(101);
  });

  it('activeLeaseCount ignores expired leases', () => {
    const subnet = new Subnet(subnetConfig(), () => 1000);
    subnet.commitLease('aa:bb:cc:dd:ee:01', '10.0.1.100', 2000);
    subnet.commitLease('aa:bb:cc:dd:ee:02', '10.0.1.101', 900);
    expect(subnet.activeLeaseCount()).toBe(1);
  });
});

describe('DhcpServerService rebuild + gauge telemetry', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function resolverFrom(interfaces: NetworkInterface[]): typeof selfPrimary {
    return (opts, discover): SelfPrimaryInterface | null => selfPrimary(opts, discover ?? (() => interfaces));
  }

  async function flush(): Promise<void> {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  }

  function buildService(atomsMap: ReadonlyMap<string, DhcpAtomValue>) {
    const interfaces = [iface('eth0', '10.0.1.5')];
    const readAtomsFn = vi.fn().mockResolvedValue(atomsMap);
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
    });
    return { service, readAtomsFn };
  }

  it('counts initial/config_change/teardown rebuilds and reads the live engine subnets', async () => {
    vi.useFakeTimers();
    telemetryFake.reset();
    const { service, readAtomsFn } = buildService(new Map([['prefix-1', makeAtom()]]));

    const start = service.start('job-1');
    await flush();

    expect(telemetryFake.counters[ENGINE_REBUILDS]).toEqual([{ value: 1, attrs: { reason: 'initial' } }]);
    expect(await telemetryFake.collect(LEASES_ACTIVE)).toEqual([{ value: 0, attrs: { subnet: '10.0.1.0/24' } }]);
    expect(await telemetryFake.collect(POOL_SIZE)).toEqual([{ value: 101, attrs: { subnet: '10.0.1.0/24' } }]);

    readAtomsFn.mockResolvedValue(
      new Map([['prefix-1', makeAtom({ pools: [{ start: '10.0.1.100', end: '10.0.1.149' }] })]]),
    );
    await vi.advanceTimersByTimeAsync(POLL_MS + 10);
    await flush();

    expect(telemetryFake.counters[ENGINE_REBUILDS]).toEqual([
      { value: 1, attrs: { reason: 'initial' } },
      { value: 1, attrs: { reason: 'config_change' } },
    ]);
    expect(await telemetryFake.collect(POOL_SIZE)).toEqual([{ value: 50, attrs: { subnet: '10.0.1.0/24' } }]);

    readAtomsFn.mockResolvedValue(new Map());
    await vi.advanceTimersByTimeAsync(POLL_MS + 10);
    await flush();

    expect(telemetryFake.counters[ENGINE_REBUILDS]).toEqual([
      { value: 1, attrs: { reason: 'initial' } },
      { value: 1, attrs: { reason: 'config_change' } },
      { value: 1, attrs: { reason: 'teardown' } },
    ]);
    expect(await telemetryFake.collect(LEASES_ACTIVE)).toEqual([]);
    expect(await telemetryFake.collect(POOL_SIZE)).toEqual([]);

    service.stop('job-1');
    await expect(start).resolves.toBeUndefined();
  });
});
