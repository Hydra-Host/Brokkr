import { afterEach, describe, expect, it } from 'vitest';

import { ContextLogger } from '../../logger/logger.service';
import { resetActiveBridgePluginsForTests, setActiveBridgePlugins } from '../../plugin-host/active-plugins-holder';
import {
  resetBridgePluginEventBusForTests,
  setBridgePluginEventBus,
} from '../../plugin-host/bridge-plugin-event-holder';
import { buildLeaderConfig } from '../leader-election.config';
import {
  LeaderElectionService,
  type InterfaceEnumerator,
  type LeaderCache,
  type VersionInfo,
} from '../leader-election.service';

type CacheCall =
  | { op: 'setNx'; key: string; value: string; ttlSeconds: number }
  | { op: 'renewIfOwner'; key: string; expectedValue: string; ttlSeconds: number }
  | { op: 'deleteIfOwner'; key: string; expectedValue: string }
  | { op: 'get'; key: string }
  | { op: 'hset'; key: string; mapping: Record<string, string>; ttlSeconds: number }
  | { op: 'hgetall'; key: string }
  | { op: 'delete'; key: string }
  | { op: 'scan'; pattern: string };

interface ScriptedOp {
  op: CacheCall['op'];
  returns?: unknown;
  raises?: Error;
}

function scriptedCache(ops: ScriptedOp[]): { cache: LeaderCache; calls: CacheCall[] } {
  const calls: CacheCall[] = [];
  let index = 0;

  function next(expectedOp: CacheCall['op']): ScriptedOp {
    const op = ops[index++];
    if (!op) throw new Error(`scripted cache exhausted (expected ${expectedOp})`);
    if (op.op !== expectedOp) {
      throw new Error(`scripted cache: expected ${op.op} but got ${expectedOp}`);
    }
    if (op.raises) throw op.raises;
    return op;
  }

  const cache: LeaderCache = {
    async setNx(key, value, opts) {
      calls.push({ op: 'setNx', key, value, ttlSeconds: opts.ttlSeconds });
      return next('setNx').returns as boolean;
    },
    async renewIfOwner(key, expectedValue, opts) {
      calls.push({ op: 'renewIfOwner', key, expectedValue, ttlSeconds: opts.ttlSeconds });
      return next('renewIfOwner').returns as boolean;
    },
    async deleteIfOwner(key, expectedValue) {
      calls.push({ op: 'deleteIfOwner', key, expectedValue });
      const ret = next('deleteIfOwner').returns;
      return Boolean(ret);
    },
    async get(key) {
      calls.push({ op: 'get', key });
      return next('get').returns as string | null;
    },
    async hset(key, mapping, opts) {
      calls.push({ op: 'hset', key, mapping, ttlSeconds: opts.ttlSeconds });
      return (next('hset').returns as number) ?? 1;
    },
    async hgetall(key) {
      calls.push({ op: 'hgetall', key });
      return (next('hgetall').returns as Record<string, string>) ?? {};
    },
    async delete(key) {
      calls.push({ op: 'delete', key });
      return (next('delete').returns as number) ?? 0;
    },
    async scan(pattern) {
      calls.push({ op: 'scan', pattern });
      return (next('scan').returns as string[]) ?? [];
    },
  };

  return { cache, calls };
}

const emptyInterfaces: InterfaceEnumerator = {
  async enumerate() {
    return [];
  },
};

const versions: () => VersionInfo = () => ({
  brokkrWorkerVersion: '0.0.0-test',
  brokkrLiveVersion: '0.0.0-live',
});

function makeService(cache: LeaderCache, interfaces: InterfaceEnumerator = emptyInterfaces) {
  const config = buildLeaderConfig({ BRIDGE_HOSTNAME: 'test-instance' });
  return new LeaderElectionService(cache, interfaces, versions, new ContextLogger(), config, 'pattern-b');
}

describe('LeaderElectionService — initial acquisition', () => {
  it('set_nx → True promotes to leader and writes registry', async () => {
    const { cache, calls } = scriptedCache([
      { op: 'setNx', returns: true },
      { op: 'hset', returns: 1 },
    ]);
    const service = makeService(cache);

    expect(service.isLeader).toBe(false);
    expect(service.leaderSinceTimestamp).toBeNull();

    await service.heartbeat();

    expect(service.isLeader).toBe(true);
    expect(service.leaderSinceTimestamp).not.toBeNull();
    expect(calls.map((c) => c.op)).toEqual(['setNx', 'hset']);
    const setNx = calls[0];
    if (setNx.op !== 'setNx') throw new Error('unexpected');
    expect(setNx.value).toBe('test-instance');
    expect(setNx.ttlSeconds).toBe(30);
  });

  it('set_nx → false keeps follower, queries current leader, writes registry', async () => {
    const { cache, calls } = scriptedCache([
      { op: 'setNx', returns: false },
      { op: 'get', returns: 'other-instance' },
      { op: 'hset', returns: 1 },
    ]);
    const service = makeService(cache);

    await service.heartbeat();

    expect(service.isLeader).toBe(false);
    expect(service.leaderSinceTimestamp).toBeNull();
    expect(calls.map((c) => c.op)).toEqual(['setNx', 'get', 'hset']);
    const hset = calls[2];
    if (hset.op !== 'hset') throw new Error('unexpected');
    expect(hset.mapping.is_leader).toBe('False');
  });
});

describe('LeaderElectionService — heartbeat renewal', () => {
  it('renew_if_owner → true keeps leadership and preserves leader_since', async () => {
    const { cache, calls } = scriptedCache([
      { op: 'setNx', returns: true },
      { op: 'hset', returns: 1 },
      { op: 'renewIfOwner', returns: true },
      { op: 'hset', returns: 1 },
    ]);
    const service = makeService(cache);

    await service.heartbeat();
    const sinceAfterClaim = service.leaderSinceTimestamp;
    expect(service.isLeader).toBe(true);

    await service.heartbeat();

    expect(service.isLeader).toBe(true);
    expect(service.leaderSinceTimestamp).toBe(sinceAfterClaim);
    expect(calls.map((c) => c.op)).toEqual(['setNx', 'hset', 'renewIfOwner', 'hset']);
    const renew = calls[2];
    if (renew.op !== 'renewIfOwner') throw new Error('unexpected');
    expect(renew.expectedValue).toBe('test-instance');
    expect(renew.ttlSeconds).toBe(30);
  });

  it('renew_if_owner → false demotes back to follower; registry still updated', async () => {
    const { cache, calls } = scriptedCache([
      { op: 'setNx', returns: true },
      { op: 'hset', returns: 1 },
      { op: 'renewIfOwner', returns: false },
      { op: 'hset', returns: 1 },
    ]);
    const service = makeService(cache);

    await service.heartbeat();
    expect(service.isLeader).toBe(true);

    await service.heartbeat();

    expect(service.isLeader).toBe(false);
    expect(service.leaderSinceTimestamp).toBeNull();
    const lastHset = [...calls].reverse().find((c) => c.op === 'hset');
    if (!lastHset || lastHset.op !== 'hset') throw new Error('unexpected');
    expect(lastHset.mapping.is_leader).toBe('False');
  });
});

describe('LeaderElectionService — stop', () => {
  it('stop while leader calls deleteIfOwner with the ownership token', async () => {
    const { cache, calls } = scriptedCache([
      { op: 'setNx', returns: true },
      { op: 'hset', returns: 1 },
      { op: 'deleteIfOwner', returns: 1 },
      { op: 'delete', returns: 1 },
    ]);
    const service = makeService(cache);

    await service.heartbeat();
    expect(service.isLeader).toBe(true);

    await service.stop();

    expect(service.isLeader).toBe(false);
    expect(service.leaderSinceTimestamp).toBeNull();
    const del = calls.find((c) => c.op === 'deleteIfOwner');
    if (!del || del.op !== 'deleteIfOwner') throw new Error('unexpected');
    expect(del.expectedValue).toBe('test-instance');

    await service.heartbeat();
    expect(calls.map((c) => c.op)).toEqual(['setNx', 'hset', 'deleteIfOwner', 'delete']);
  });

  it('stop while not leader still calls deleteIfOwner (owner-gated)', async () => {
    const { cache, calls } = scriptedCache([
      { op: 'deleteIfOwner', returns: 0 },
      { op: 'delete', returns: 0 },
    ]);
    const service = makeService(cache);

    expect(service.isLeader).toBe(false);
    await service.stop();
    expect(service.isLeader).toBe(false);
    const del = calls[0];
    if (del.op !== 'deleteIfOwner') throw new Error('unexpected');
    expect(del.expectedValue).toBe('test-instance');
  });
});

describe('LeaderElectionService — stop best-effort cleanup (Redis unreachable)', () => {
  it('deregisters even when releaseLeadership (deleteIfOwner) throws, and stop() resolves', async () => {
    const { cache, calls } = scriptedCache([
      { op: 'setNx', returns: true },
      { op: 'hset', returns: 1 },
      { op: 'deleteIfOwner', raises: new Error('redis down') },
      { op: 'delete', returns: 1 },
    ]);
    const service = makeService(cache);

    await service.heartbeat();
    expect(service.isLeader).toBe(true);

    await expect(service.stop()).resolves.toBeUndefined();

    expect(calls.map((c) => c.op)).toEqual(['setNx', 'hset', 'deleteIfOwner', 'delete']);
    expect(service.isLeader).toBe(false);
    expect(service.leaderSinceTimestamp).toBeNull();
  });

  it('resolves without throwing when both cleanup ops throw', async () => {
    const { cache, calls } = scriptedCache([
      { op: 'setNx', returns: true },
      { op: 'hset', returns: 1 },
      { op: 'deleteIfOwner', raises: new Error('redis down') },
      { op: 'delete', raises: new Error('redis still down') },
    ]);
    const service = makeService(cache);

    await service.heartbeat();
    await expect(service.stop()).resolves.toBeUndefined();

    expect(calls.map((c) => c.op)).toEqual(['setNx', 'hset', 'deleteIfOwner', 'delete']);
    expect(service.isLeader).toBe(false);
  });
});

describe('LeaderElectionService — registry payload', () => {
  it('hset mapping has the wire-locked keys + registry_ttl_seconds', async () => {
    const { cache, calls } = scriptedCache([
      { op: 'setNx', returns: true },
      { op: 'hset', returns: 1 },
    ]);
    const service = makeService(cache);

    await service.heartbeat();

    const hset = calls[1];
    if (hset.op !== 'hset') throw new Error('unexpected');
    expect(hset.key).toBe('bridge:instance:test-instance');
    expect(hset.mapping.instance_id).toBe('test-instance');
    expect(hset.mapping.is_leader).toBe('True');
    expect(JSON.parse(hset.mapping.interfaces_json)).toEqual([]);
    expect(Number.isFinite(Number(hset.mapping.registered_at))).toBe(true);
    expect(hset.mapping.brokkr_worker_version).toBe('0.0.0-test');
    expect(hset.mapping.brokkr_live_version).toBe('0.0.0-live');
    expect(hset.ttlSeconds).toBe(120);
  });

  it('interface enumeration errors are swallowed; registry payload has []', async () => {
    const { cache, calls } = scriptedCache([
      { op: 'setNx', returns: true },
      { op: 'hset', returns: 1 },
    ]);
    const failing: InterfaceEnumerator = {
      async enumerate() {
        throw new Error('boom');
      },
    };
    const service = makeService(cache, failing);

    await service.heartbeat();

    const hset = calls[1];
    if (hset.op !== 'hset') throw new Error('unexpected');
    expect(JSON.parse(hset.mapping.interfaces_json)).toEqual([]);
  });

  it('interfaces_json byte form matches JSON.stringify output', async () => {
    const { cache, calls } = scriptedCache([
      { op: 'setNx', returns: true },
      { op: 'hset', returns: 1 },
    ]);
    const populated: InterfaceEnumerator = {
      async enumerate() {
        return [
          { iface: 'eth0', mac: 'aa:bb:cc:dd:ee:ff', subnet: '10.0.0.0/24', ip: '10.0.0.5' },
          { iface: 'wg0', mac: '', subnet: '192.168.1.0/24', ip: '192.168.1.10' },
        ];
      },
    };
    const service = makeService(cache, populated);

    await service.heartbeat();

    const hset = calls[1];
    if (hset.op !== 'hset') throw new Error('unexpected');
    expect(hset.mapping.interfaces_json).toBe(
      '[{"iface":"eth0","mac":"aa:bb:cc:dd:ee:ff","subnet":"10.0.0.0/24","ip":"10.0.0.5"},{"iface":"wg0","mac":"","subnet":"192.168.1.0/24","ip":"192.168.1.10"}]',
    );
  });
});

describe('LeaderElectionService — ownership token uniqueness', () => {
  it('setNx and deleteIfOwner use the same instance_id token', async () => {
    const { cache, calls } = scriptedCache([
      { op: 'setNx', returns: true },
      { op: 'hset', returns: 1 },
      { op: 'deleteIfOwner', returns: 1 },
      { op: 'delete', returns: 1 },
    ]);
    const service = makeService(cache);

    await service.heartbeat();
    await service.stop();

    const setNx = calls[0];
    const del = calls.find((c) => c.op === 'deleteIfOwner');
    if (setNx.op !== 'setNx') throw new Error('unexpected');
    if (!del || del.op !== 'deleteIfOwner') throw new Error('unexpected');
    expect(setNx.value).toBe(del.expectedValue);
    expect(setNx.value).toBe('test-instance');
  });
});

describe('LeaderElectionService — cache failure during heartbeat', () => {
  it('renew_if_owner throwing clears isLeader and re-raises', async () => {
    const { cache, calls } = scriptedCache([
      { op: 'setNx', returns: true },
      { op: 'hset', returns: 1 },
      { op: 'renewIfOwner', raises: new Error('redis down') },
    ]);
    const service = makeService(cache);

    await service.heartbeat();
    expect(service.isLeader).toBe(true);

    await expect(service.heartbeat()).rejects.toThrow('redis down');

    expect(service.isLeader).toBe(false);
    expect(service.leaderSinceTimestamp).toBeNull();
    const hsetCount = calls.filter((c) => c.op === 'hset').length;
    expect(hsetCount).toBe(1);
  });
});

interface Gate {
  release: (value?: unknown) => void;
  reject: (err: Error) => void;
  awaited: Promise<void>;
}

function gatedCache(scripts: Partial<Record<CacheCall['op'], unknown>>): {
  cache: LeaderCache;
  calls: CacheCall[];
  gateFor: (op: CacheCall['op'], nth?: number) => Promise<Gate>;
} {
  const calls: CacheCall[] = [];
  const pending: { op: CacheCall['op']; gate: Gate }[] = [];
  const waiters: { op: CacheCall['op']; nth: number; resolve: (g: Gate) => void }[] = [];
  const seen: Record<string, number> = {};

  function makeGate(op: CacheCall['op']): Promise<unknown> {
    let release!: (v?: unknown) => void;
    let reject!: (e: Error) => void;
    const awaited = new Promise<void>((res, rej) => {
      release = () => res();
      reject = rej;
    });
    const gate: Gate = { release, reject, awaited };
    pending.push({ op, gate });
    const n = (seen[op] = (seen[op] ?? 0) + 1);
    const w = waiters.findIndex((x) => x.op === op && x.nth === n);
    if (w !== -1) {
      const [matched] = waiters.splice(w, 1);
      matched.resolve(gate);
    }
    return gate.awaited.then(() => scripts[op]);
  }

  const cache: LeaderCache = {
    async setNx(key, value, opts) {
      calls.push({ op: 'setNx', key, value, ttlSeconds: opts.ttlSeconds });
      return (await makeGate('setNx')) as boolean;
    },
    async renewIfOwner(key, expectedValue, opts) {
      calls.push({ op: 'renewIfOwner', key, expectedValue, ttlSeconds: opts.ttlSeconds });
      return (await makeGate('renewIfOwner')) as boolean;
    },
    async deleteIfOwner(key, expectedValue) {
      calls.push({ op: 'deleteIfOwner', key, expectedValue });
      return Boolean(await makeGate('deleteIfOwner'));
    },
    async get(key) {
      calls.push({ op: 'get', key });
      return (await makeGate('get')) as string | null;
    },
    async hset(key, mapping, opts) {
      calls.push({ op: 'hset', key, mapping, ttlSeconds: opts.ttlSeconds });
      return ((await makeGate('hset')) as number) ?? 1;
    },
    async hgetall(key) {
      calls.push({ op: 'hgetall', key });
      return ((await makeGate('hgetall')) as Record<string, string>) ?? {};
    },
    async delete(key) {
      calls.push({ op: 'delete', key });
      return ((await makeGate('delete')) as number) ?? 0;
    },
    async scan(pattern) {
      calls.push({ op: 'scan', pattern });
      return ((await makeGate('scan')) as string[]) ?? [];
    },
  };

  function gateFor(op: CacheCall['op'], nth = 1): Promise<Gate> {
    const idx = pending.filter((p) => p.op === op).length;
    if (idx >= nth) {
      return Promise.resolve(pending.filter((p) => p.op === op)[nth - 1].gate);
    }
    return new Promise<Gate>((resolve) => {
      waiters.push({ op, nth, resolve });
    });
  }

  return { cache, calls, gateFor };
}

const flush = (): Promise<void> => new Promise<void>((r) => setTimeout(r, 0));

describe('LeaderElectionService — timeout step-down + ownership re-derivation', () => {
  it('re-derives leadership from an owned key on the follower path (no leaderless-while-owned window)', async () => {
    const { cache, calls } = scriptedCache([
      { op: 'setNx', returns: false },
      { op: 'get', returns: 'test-instance' },
      { op: 'hset', returns: 1 },
    ]);
    const service = makeService(cache);

    await service.heartbeat();

    expect(service.isLeader).toBe(true);
    expect(service.leaderSinceTimestamp).not.toBeNull();
    expect(calls.map((c) => c.op)).toEqual(['setNx', 'get', 'hset']);
    const hset = calls[2];
    if (hset.op !== 'hset') throw new Error('unexpected');
    expect(hset.mapping.is_leader).toBe('True');
  });

  it('steps a leader down deterministically when the heartbeat is aborted (timeout)', async () => {
    const { cache, calls } = scriptedCache([
      { op: 'setNx', returns: true },
      { op: 'hset', returns: 1 },
      { op: 'renewIfOwner', returns: true },
    ]);
    const service = makeService(cache);

    await service.heartbeat();
    expect(service.isLeader).toBe(true);

    const aborted = new AbortController();
    aborted.abort();
    await expect(service.heartbeat(aborted.signal)).rejects.toMatchObject({ name: 'AbortError' });

    expect(service.isLeader).toBe(false);
    expect(service.leaderSinceTimestamp).toBeNull();
    expect(calls.filter((c) => c.op === 'hset').length).toBe(1);
  });

  it('a timed-out (orphaned) heartbeat does not run concurrently with the next tick', async () => {
    const { cache, calls, gateFor } = gatedCache({
      setNx: true,
      renewIfOwner: true,
      hset: 1,
    });
    const service = makeService(cache);

    const claim = service.heartbeat();
    (await gateFor('setNx', 1)).release();
    (await gateFor('hset', 1)).release();
    await claim;
    expect(service.isLeader).toBe(true);

    const orphan = service.heartbeat();
    await gateFor('renewIfOwner', 1);

    const next = service.heartbeat();
    await flush();
    expect(calls.filter((c) => c.op === 'renewIfOwner').length).toBe(1);

    (await gateFor('renewIfOwner', 1)).release();
    (await gateFor('hset', 2)).release();
    await orphan;
    (await gateFor('renewIfOwner', 2)).release();
    (await gateFor('hset', 3)).release();
    await next;

    expect(calls.filter((c) => c.op === 'renewIfOwner').length).toBe(2);
  });
});

describe('LeaderElectionService — lifecycle mutex serialization', () => {
  it('heartbeat() then stop() run in order without interleaving when not awaited', async () => {
    const { cache, calls, gateFor } = gatedCache({
      setNx: true,
      hset: 1,
      deleteIfOwner: 1,
      delete: 1,
    });
    const service = makeService(cache);

    const hb = service.heartbeat();
    const st = service.stop();

    const setNx = await gateFor('setNx', 1);
    setNx.release();
    const hset = await gateFor('hset', 1);
    await flush();
    expect(calls.some((c) => c.op === 'deleteIfOwner')).toBe(false);

    hset.release();
    await hb;

    const del = await gateFor('deleteIfOwner', 1);
    del.release();
    const reg = await gateFor('delete', 1);
    reg.release();
    await st;

    expect(calls.map((c) => c.op)).toEqual(['setNx', 'hset', 'deleteIfOwner', 'delete']);
  });

  it('back-to-back heartbeats serialize; the second does not start until the first finishes', async () => {
    const { cache, calls, gateFor } = gatedCache({
      setNx: true,
      hset: 1,
      renewIfOwner: true,
    });
    const service = makeService(cache);

    const first = service.heartbeat();
    const second = service.heartbeat();

    const setNx = await gateFor('setNx', 1);
    await flush();
    expect(calls.some((c) => c.op === 'renewIfOwner')).toBe(false);
    expect(calls.filter((c) => c.op === 'setNx').length).toBe(1);

    setNx.release();
    const hset1 = await gateFor('hset', 1);
    hset1.release();
    await first;

    const renew = await gateFor('renewIfOwner', 1);
    renew.release();
    const hset2 = await gateFor('hset', 2);
    hset2.release();
    await second;

    expect(calls.map((c) => c.op)).toEqual(['setNx', 'hset', 'renewIfOwner', 'hset']);
  });
});

describe('LeaderElectionService — opportunistic vacant claim (tryClaimLeadershipIfVacant)', () => {
  it('claims via setNx then writes is_leader=true to the registry', async () => {
    const { cache, calls } = scriptedCache([
      { op: 'setNx', returns: true },
      { op: 'hset', returns: 1 },
    ]);
    const service = makeService(cache);

    expect(service.isLeader).toBe(false);
    const claimed = await service.tryClaimLeadershipIfVacant();

    expect(claimed).toBe(true);
    expect(service.isLeader).toBe(true);
    expect(service.leaderSinceTimestamp).not.toBeNull();
    expect(calls.map((c) => c.op)).toEqual(['setNx', 'hset']);
    const setNx = calls[0];
    if (setNx.op !== 'setNx') throw new Error('unexpected');
    expect(setNx.key).toBe('bridge:leader');
    expect(setNx.value).toBe('test-instance');
    expect(setNx.ttlSeconds).toBe(30);
    const hset = calls[1];
    if (hset.op !== 'hset') throw new Error('unexpected');
    expect(hset.mapping.is_leader).toBe('True');
  });

  it('setNx → false (a live peer still holds the key) keeps follower; no second leader', async () => {
    const { cache, calls } = scriptedCache([{ op: 'setNx', returns: false }]);
    const service = makeService(cache);

    const claimed = await service.tryClaimLeadershipIfVacant();

    expect(claimed).toBe(false);
    expect(service.isLeader).toBe(false);
    expect(service.leaderSinceTimestamp).toBeNull();
    expect(calls.map((c) => c.op)).toEqual(['setNx']);
  });

  it('is a no-op when already leader (never re-claims, never double-grants)', async () => {
    const { cache, calls } = scriptedCache([
      { op: 'setNx', returns: true },
      { op: 'hset', returns: 1 },
    ]);
    const service = makeService(cache);

    await service.heartbeat();
    expect(service.isLeader).toBe(true);
    const since = service.leaderSinceTimestamp;

    const claimed = await service.tryClaimLeadershipIfVacant();

    expect(claimed).toBe(false);
    expect(service.isLeader).toBe(true);
    expect(service.leaderSinceTimestamp).toBe(since);
    expect(calls.map((c) => c.op)).toEqual(['setNx', 'hset']);
  });

  it('is a no-op after stop() (never re-acquires a released key)', async () => {
    const { cache, calls } = scriptedCache([
      { op: 'deleteIfOwner', returns: 0 },
      { op: 'delete', returns: 0 },
    ]);
    const service = makeService(cache);

    await service.stop();
    const claimed = await service.tryClaimLeadershipIfVacant();

    expect(claimed).toBe(false);
    expect(service.isLeader).toBe(false);
    expect(calls.some((c) => c.op === 'setNx')).toBe(false);
  });

  it('runs under the shared lifecycle lock: a concurrent stop() cannot interleave with its setNx', async () => {
    const { cache, calls, gateFor } = gatedCache({
      setNx: true,
      hset: 1,
      deleteIfOwner: 1,
      delete: 1,
    });
    const service = makeService(cache);

    const claim = service.tryClaimLeadershipIfVacant();
    const st = service.stop();

    const setNx = await gateFor('setNx', 1);
    await flush();
    expect(calls.some((c) => c.op === 'deleteIfOwner')).toBe(false);

    setNx.release();
    const hset = await gateFor('hset', 1);
    hset.release();
    await claim;

    const del = await gateFor('deleteIfOwner', 1);
    del.release();
    const reg = await gateFor('delete', 1);
    reg.release();
    await st;

    expect(calls.map((c) => c.op)).toEqual(['setNx', 'hset', 'deleteIfOwner', 'delete']);
  });
});

describe('LeaderElectionService — mid-tick abort', () => {
  it('aborting after the first cache op throws AbortError before the next op and does not flip leadership', async () => {
    const { cache, calls, gateFor } = gatedCache({
      setNx: true,
    });
    const service = makeService(cache);
    const controller = new AbortController();

    const hb = service.heartbeat(controller.signal);

    const setNx = await gateFor('setNx', 1);
    controller.abort();
    setNx.release();

    await expect(hb).rejects.toMatchObject({ name: 'AbortError' });

    expect(calls.map((c) => c.op)).toEqual(['setNx']);
    expect(service.isLeader).toBe(false);
    expect(service.leaderSinceTimestamp).toBeNull();
  });
});

describe('LeaderElectionService — initial-tick observability', () => {
  it('initial_tick_ok is null before start()', async () => {
    const { cache } = scriptedCache([
      { op: 'get', returns: null },
      { op: 'scan', returns: [] },
    ]);
    const service = makeService(cache);

    const info = await service.getLeaderInfo();
    expect(info.initial_tick_ok).toBeNull();
    expect(info.last_initial_tick_error).toBeNull();
  });

  it('records a successful bootstrap heartbeat', async () => {
    const { cache } = scriptedCache([
      { op: 'setNx', returns: true },
      { op: 'hset', returns: 1 },
      { op: 'get', returns: 'test-instance' },
      { op: 'scan', returns: [] },
    ]);
    const service = makeService(cache);

    await service.start();

    const info = await service.getLeaderInfo();
    expect(info.initial_tick_ok).toBe(true);
    expect(info.last_initial_tick_error).toBeNull();
  });

  it('records a failed bootstrap heartbeat without throwing (swallow preserved)', async () => {
    const { cache } = scriptedCache([
      { op: 'setNx', raises: new Error('redis down') },
      { op: 'get', returns: null },
      { op: 'scan', returns: [] },
    ]);
    const service = makeService(cache);

    await expect(service.start()).resolves.toBeUndefined();

    const info = await service.getLeaderInfo();
    expect(info.initial_tick_ok).toBe(false);
    expect(info.last_initial_tick_error).toContain('redis down');
  });
});

describe('LeaderElectionService — plugin event emission', () => {
  afterEach(() => {
    resetBridgePluginEventBusForTests();
  });

  it('emits leadership.changed on acquisition and on a failed-heartbeat step-down', async () => {
    const emitted: Array<{ event: string; payload: unknown }> = [];
    setBridgePluginEventBus({
      emit: (event, payload) => {
        emitted.push({ event, payload });
      },
      on: () => () => undefined,
      off: () => undefined,
    });
    const { cache } = scriptedCache([
      { op: 'setNx', returns: true },
      { op: 'hset', returns: 1 },
      { op: 'renewIfOwner', raises: new Error('redis timeout') },
    ]);
    const service = makeService(cache);

    await service.heartbeat();
    await expect(service.heartbeat()).rejects.toThrow('redis timeout');

    expect(service.isLeader).toBe(false);
    expect(emitted).toEqual([
      { event: 'bridge.leadership.changed', payload: { instanceId: 'test-instance', isLeader: true } },
      { event: 'bridge.leadership.changed', payload: { instanceId: 'test-instance', isLeader: false } },
    ]);
  });
});

describe('LeaderElectionService — active plugin reporting', () => {
  afterEach(() => {
    resetActiveBridgePluginsForTests();
  });

  it('publishes the active plugin roster in the instance registry hash', async () => {
    setActiveBridgePlugins([{ id: 'bridge-hello-world', version: '0.1.0' }]);
    const { cache, calls } = scriptedCache([
      { op: 'setNx', returns: true },
      { op: 'hset', returns: 1 },
    ]);
    const service = makeService(cache);

    await service.heartbeat();

    const hset = calls[1];
    if (hset.op !== 'hset') throw new Error('unexpected');
    expect(hset.mapping.active_plugins_json).toBe(JSON.stringify([{ id: 'bridge-hello-world', version: '0.1.0' }]));
  });

  it('publishes an empty roster when no plugins are active', async () => {
    const { cache, calls } = scriptedCache([
      { op: 'setNx', returns: true },
      { op: 'hset', returns: 1 },
    ]);
    const service = makeService(cache);

    await service.heartbeat();

    const hset = calls[1];
    if (hset.op !== 'hset') throw new Error('unexpected');
    expect(hset.mapping.active_plugins_json).toBe('[]');
  });
});
