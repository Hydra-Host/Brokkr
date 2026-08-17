import path from 'node:path';

import { type AnyDefinition, type ServiceDefinition, loadSync } from '@grpc/proto-loader';
import { describe, expect, it } from 'vitest';

import { TopologyBroadcasterService, buildEndpoints, hostsEntriesForPeer } from '../topology-broadcaster.service';
import type {
  BridgeRegistryReaderPort,
  BridgeSnapshot,
  ConnectionRegistryPort,
  GrpcConfigPort,
  SessionHandle,
  TopologyBroadcasterLogger,
  TopologyServerMessage,
} from '../topology-broadcaster.types';

interface StubSession extends SessionHandle {
  enqueue: (msg: TopologyServerMessage) => boolean;
  queue: TopologyServerMessage[];
  capacity: number;
}

function makeSession(peerIp: string | null = null, capacity = 256): StubSession {
  const queue: TopologyServerMessage[] = [];
  const session: StubSession = {
    peerIp,
    queue,
    capacity,
    enqueue: (msg) => {
      if (queue.length >= session.capacity) return false;
      queue.push(msg);
      return true;
    },
  };
  return session;
}

class StubRegistry implements ConnectionRegistryPort {
  constructor(private readonly handles: StubSession[]) {}
  async snapshotSessionHandles(): Promise<readonly SessionHandle[]> {
    return this.handles;
  }
}

class StubReader implements BridgeRegistryReaderPort {
  hostnames: readonly string[] = [];
  snapshot: BridgeSnapshot = [];
  async getAllBridgeHostnames(_jobId: string): Promise<readonly string[]> {
    return this.hostnames;
  }
  async getBridgeRegistrySnapshot(_jobId: string): Promise<BridgeSnapshot> {
    return this.snapshot;
  }
}

const silentLogger: TopologyBroadcasterLogger = {
  debug: () => undefined,
  info: () => undefined,
  warning: () => undefined,
};

const grpcCfg: GrpcConfigPort = { externalPort: 443 };

function setupBroadcaster(handles: StubSession[]): {
  broadcaster: TopologyBroadcasterService;
  reader: StubReader;
} {
  const reader = new StubReader();
  const broadcaster = new TopologyBroadcasterService(new StubRegistry(handles), reader, grpcCfg, silentLogger, 0);
  return { broadcaster, reader };
}

describe('build_endpoints', () => {
  it('shape matches agent.yaml format (bare host:port)', () => {
    const endpoints = buildEndpoints(['bridge-a', 'bridge-b'], 443);
    expect(endpoints).toEqual([
      { address: 'bridge-a:443', bridgeId: 'bridge-a' },
      { address: 'bridge-b:443', bridgeId: 'bridge-b' },
    ]);
  });

  it('empty input returns empty list', () => {
    expect(buildEndpoints([], 443)).toEqual([]);
  });
});

describe('TopologyBroadcaster — first tick seeds snapshot', () => {
  it('first poll broadcasts to every live session', async () => {
    const handle = makeSession();
    const { broadcaster, reader } = setupBroadcaster([handle]);
    reader.hostnames = ['bridge-a', 'bridge-b'];

    await broadcaster.pollOnce('test');

    expect(handle.queue.length).toBe(1);
    expect(handle.queue[0].topologyUpdate).toBeDefined();
  });
});

describe('TopologyBroadcaster — broadcast on fleet change', () => {
  it('broadcasts to every live session on add', async () => {
    const h1 = makeSession();
    const h2 = makeSession();
    const { broadcaster, reader } = setupBroadcaster([h1, h2]);
    reader.hostnames = ['bridge-a'];
    await broadcaster.pollOnce('test');
    h1.queue.length = 0;
    h2.queue.length = 0;

    reader.hostnames = ['bridge-a', 'bridge-b'];
    await broadcaster.pollOnce('test');

    for (const handle of [h1, h2]) {
      expect(handle.queue.length).toBe(1);
      const addrs = [...handle.queue[0].topologyUpdate.bridges].map((b) => b.address).sort();
      expect(addrs).toEqual(['bridge-a:443', 'bridge-b:443']);
    }
  });

  it('additive-only: registry dropout does not remove a bridge', async () => {
    const handle = makeSession();
    const { broadcaster, reader } = setupBroadcaster([handle]);
    reader.hostnames = ['bridge-a', 'bridge-b'];
    await broadcaster.pollOnce('test');
    handle.queue.length = 0;

    reader.hostnames = ['bridge-a'];
    await broadcaster.pollOnce('test');
    expect(handle.queue.length).toBe(0);

    reader.hostnames = ['bridge-a', 'bridge-c'];
    await broadcaster.pollOnce('test');
    expect(handle.queue.length).toBe(1);
    const addrs = [...handle.queue[0].topologyUpdate.bridges].map((b) => b.address).sort();
    expect(addrs).toEqual(['bridge-a:443', 'bridge-b:443', 'bridge-c:443']);
  });
});

describe('TopologyBroadcaster — skips broadcast when unchanged', () => {
  it('no push when snapshot matches previous', async () => {
    const handle = makeSession();
    const { broadcaster, reader } = setupBroadcaster([handle]);
    reader.hostnames = ['bridge-a'];

    await broadcaster.pollOnce('test');
    await broadcaster.pollOnce('test');
    await broadcaster.pollOnce('test');

    expect(handle.queue.length).toBe(1);
  });
});

describe('TopologyBroadcaster — empty registry sanity', () => {
  it('empty poll after a seed is ignored, not broadcast', async () => {
    const handle = makeSession();
    const { broadcaster, reader } = setupBroadcaster([handle]);
    reader.hostnames = ['bridge-a'];
    await broadcaster.pollOnce('test');
    handle.queue.length = 0;

    reader.hostnames = [];
    await broadcaster.pollOnce('test');
    expect(handle.queue.length).toBe(0);
  });

  it('empty poll on cold start seeds nothing; next non-empty acts as first tick', async () => {
    const handle = makeSession();
    const { broadcaster, reader } = setupBroadcaster([handle]);

    reader.hostnames = [];
    await broadcaster.pollOnce('test');
    expect(handle.queue.length).toBe(0);

    reader.hostnames = ['bridge-a'];
    await broadcaster.pollOnce('test');
    expect(handle.queue.length).toBe(1);
    expect(handle.queue[0].topologyUpdate).toBeDefined();
  });
});

describe('TopologyBroadcaster — per-session hostsEntries', () => {
  it('emits per-subnet hostsEntries from each handle peer_ip', async () => {
    const hA = makeSession('10.0.0.5');
    const hB = makeSession('192.168.1.5');
    const { broadcaster, reader } = setupBroadcaster([hA, hB]);

    reader.hostnames = ['bridge-1', 'bridge-2'];
    reader.snapshot = [
      [
        'bridge-1',
        [
          { iface: 'eth0', mac: 'aa', subnet: '10.0.0.0/24', ip: '10.0.0.231' },
          { iface: 'eth1', mac: 'bb', subnet: '192.168.1.0/24', ip: '192.168.1.231' },
        ],
      ],
      [
        'bridge-2',
        [
          { iface: 'eth0', mac: 'cc', subnet: '10.0.0.0/24', ip: '10.0.0.232' },
          { iface: 'eth1', mac: 'dd', subnet: '192.168.1.0/24', ip: '192.168.1.232' },
        ],
      ],
    ];

    await broadcaster.pollOnce('t');

    expect(hA.queue.length).toBe(1);
    expect(hB.queue.length).toBe(1);
    const bridgesA = hA.queue[0].topologyUpdate.bridges.map((b) => b.address);
    const bridgesB = hB.queue[0].topologyUpdate.bridges.map((b) => b.address);
    expect(bridgesA).toEqual(bridgesB);

    const heA = hA.queue[0].topologyUpdate.hostsEntries.map((e) => [e.ip, e.hostname]);
    const heB = hB.queue[0].topologyUpdate.hostsEntries.map((e) => [e.ip, e.hostname]);
    expect(heA).toEqual([
      ['10.0.0.231', 'bridge-1'],
      ['10.0.0.232', 'bridge-2'],
    ]);
    expect(heB).toEqual([
      ['192.168.1.231', 'bridge-1'],
      ['192.168.1.232', 'bridge-2'],
    ]);
  });

  it('keeps sticky interfaces when a later row is empty', async () => {
    const handle = makeSession('10.0.0.5');
    const { broadcaster, reader } = setupBroadcaster([handle]);
    reader.hostnames = ['bridge-a'];
    reader.snapshot = [['bridge-a', [{ iface: 'eth0', mac: 'aa', subnet: '10.0.0.0/24', ip: '10.0.0.231' }]]];
    await broadcaster.pollOnce('test');
    handle.queue.length = 0;

    reader.hostnames = ['bridge-a', 'bridge-b'];
    reader.snapshot = [
      ['bridge-a', []],
      ['bridge-b', [{ iface: 'eth0', mac: 'bb', subnet: '10.0.0.0/24', ip: '10.0.0.232' }]],
    ];
    await broadcaster.pollOnce('test');

    expect(handle.queue[0].topologyUpdate.hostsEntries).toEqual([
      { ip: '10.0.0.231', hostname: 'bridge-a' },
      { ip: '10.0.0.232', hostname: 'bridge-b' },
    ]);
  });

  it('empty hostsEntries when peer_ip is null', async () => {
    const handle = makeSession(null);
    const { broadcaster, reader } = setupBroadcaster([handle]);
    reader.hostnames = ['bridge-1'];
    reader.snapshot = [['bridge-1', [{ iface: 'eth0', mac: 'aa', subnet: '10.0.0.0/24', ip: '10.0.0.231' }]]];

    await broadcaster.pollOnce('t');
    expect(handle.queue.length).toBe(1);
    expect(handle.queue[0].topologyUpdate.hostsEntries).toEqual([]);
    expect(handle.queue[0].topologyUpdate.bridges.length).toBe(1);
  });

  it('empty hostsEntries when peer_ip is unparseable', async () => {
    const handle = makeSession('not-an-ip');
    const { broadcaster, reader } = setupBroadcaster([handle]);
    reader.hostnames = ['bridge-1'];
    reader.snapshot = [['bridge-1', [{ iface: 'eth0', mac: 'aa', subnet: '10.0.0.0/24', ip: '10.0.0.231' }]]];

    await broadcaster.pollOnce('t');
    expect(handle.queue[0].topologyUpdate.hostsEntries).toEqual([]);
  });
});

describe('TopologyBroadcaster — full queue is dropped', () => {
  it('dropped push to wedged session does not block healthy session', async () => {
    const stuck = makeSession(null, 1);
    stuck.queue.push({ topologyUpdate: { bridges: [], hostsEntries: [] } });
    const healthy = makeSession();
    const { broadcaster, reader } = setupBroadcaster([stuck, healthy]);

    reader.hostnames = ['bridge-a'];
    await broadcaster.pollOnce('test');
    reader.hostnames = ['bridge-a', 'bridge-b'];
    await broadcaster.pollOnce('test');

    const healthyHas = healthy.queue.some((m) => m.topologyUpdate !== undefined);
    expect(healthyHas).toBe(true);
  });
});

describe('hostsEntriesForPeer (unit-level)', () => {
  it('returns empty when peer is null/empty', () => {
    expect(hostsEntriesForPeer(null, [])).toEqual([]);
    expect(hostsEntriesForPeer('', [])).toEqual([]);
  });
});

function asServiceDefinition(def: AnyDefinition): ServiceDefinition {
  if (!('OpenSession' in def)) throw new Error('AgentService.OpenSession not found in proto');
  return def;
}

describe('TopologyUpdate proto round-trip (keepCase:false)', () => {
  const PROTO_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..', '..', 'proto');
  const PROTO_PATH = path.join(PROTO_ROOT, 'brokkr', 'agent', 'v1', 'agent.proto');
  const packageDef = loadSync(PROTO_PATH, {
    keepCase: false,
    longs: String,
    enums: Number,
    defaults: true,
    oneofs: true,
    includeDirs: [path.dirname(PROTO_PATH), PROTO_ROOT],
  });
  const service = asServiceDefinition(packageDef['brokkr.agent.v1.AgentService']);
  const { responseSerialize: serialize, responseDeserialize: deserialize } = service.OpenSession;

  it('camelCase oneof key survives serialization; snake_case serializes empty', () => {
    const camel: TopologyServerMessage = {
      topologyUpdate: {
        bridges: [{ address: 'bridge-a:443', bridgeId: 'bridge-a' }],
        hostsEntries: [{ ip: '10.0.0.231', hostname: 'bridge-a' }],
      },
    };
    const camelBytes = serialize(camel);
    expect(camelBytes.length).toBeGreaterThan(0);
    expect(deserialize(camelBytes)).toMatchObject({
      topologyUpdate: {
        bridges: [{ address: 'bridge-a:443', bridgeId: 'bridge-a' }],
        hostsEntries: [{ ip: '10.0.0.231', hostname: 'bridge-a' }],
      },
    });

    const snake = {
      topology_update: {
        bridges: [{ address: 'bridge-a:443', bridge_id: 'bridge-a' }],
        hosts_entries: [{ ip: '10.0.0.231', hostname: 'bridge-a' }],
      },
    };
    expect(serialize(snake).length).toBe(0);
  });
});
