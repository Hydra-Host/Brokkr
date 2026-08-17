import { promises as fs } from 'node:fs';
import path from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { ConnectionRegistry } from '../../../../src/agent/connection-registry/connection-registry.service';
import {
  type CancelSignal,
  type SessionHandle,
} from '../../../../src/agent/connection-registry/connection-registry.types';
import {
  Dispatcher,
  type AgentVersionGate,
  type CancelWorkEncoder,
  type DispatchLogger,
} from '../../../../src/agent/dispatch/dispatcher.service';
import { WorkResponseStatus } from '../../../../src/agent/dispatch/protobuf-codec';
import {
  ResultPublisherService,
  type RedisPipeline,
  type ResultPubSub,
  type ResultPubSubMessage,
  type ResultPublisherRedis,
} from '../../../../src/agent/result-publisher/result-publisher.service';

const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures');

const PROVISION_SEQUENCE = [
  'storage.wipeDisks',
  'storage.detectExistingVolumeGroups',
  'storage.resolveDisks',
  'storage.detectUefiMode',
  'storage.prepareStorage',
  'deploy.deployOS',
] as const;

const COMMISSION_SEQUENCE = ['storage.wipeDisks', 'collection.collectAll'] as const;

const DEPROVISION_SEQUENCE = ['storage.wipeDisks', 'collection.collectAll'] as const;

interface FixtureCall {
  operation: string;
  expected_input_keys?: string[];
  response: Record<string, unknown>;
}

interface Fixture {
  device_id: string;
  calls: FixtureCall[];
}

interface FakeAgentRecord {
  operation: string;
  workId: string;
  jobId: string;
  inputJson: Record<string, unknown>;
}

const TEXT_DECODER = new TextDecoder();

const TEXT_ENCODER = new TextEncoder();

function encodeVarint(value: number): number[] {
  let v = BigInt(value);
  const bytes: number[] = [];
  while (v >= 0x80n) {
    bytes.push(Number(v & 0x7fn) | 0x80);
    v >>= 7n;
  }
  bytes.push(Number(v));
  return bytes;
}

function encodeTag(fieldNumber: number, wireType: number): number[] {
  return encodeVarint((fieldNumber << 3) | wireType);
}

function encodeLenDelimited(fieldNumber: number, payload: Uint8Array): number[] {
  return [...encodeTag(fieldNumber, 2), ...encodeVarint(payload.length), ...payload];
}

function encodeWorkResponse(args: { workId: string; status: WorkResponseStatus; output: Uint8Array }): Uint8Array {
  const parts: number[] = [];
  if (args.workId !== '') {
    parts.push(...encodeLenDelimited(1, TEXT_ENCODER.encode(args.workId)));
  }
  if (args.status !== WorkResponseStatus.UNSPECIFIED) {
    parts.push(...encodeTag(2, 0), ...encodeVarint(args.status));
  }
  if (args.output.length !== 0) {
    parts.push(...encodeLenDelimited(3, args.output));
  }
  return new Uint8Array(parts);
}

class InMemoryRedis implements ResultPublisherRedis {
  private readonly store = new Map<string, Buffer>();
  private readonly subscribers = new Set<InMemoryPubSub>();

  async set(key: string, value: string | Buffer, _exSeconds: number): Promise<void> {
    this.store.set(key, Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf-8'));
  }

  async get(key: string): Promise<Buffer | null> {
    return this.store.get(key) ?? null;
  }

  async del(key: string): Promise<number> {
    return this.store.delete(key) ? 1 : 0;
  }

  async hgetall(): Promise<Record<string, string>> {
    return {};
  }

  pipeline(): RedisPipeline {
    const ops: Array<() => Promise<void> | void> = [];
    const pipe: RedisPipeline = {
      set: (key, value, ex) => {
        ops.push(() => this.set(key, value, ex));
        return pipe;
      },
      publish: (channel, message) => {
        ops.push(() => {
          for (const sub of this.subscribers) sub.deliver(channel, message);
        });
        return pipe;
      },
      hset: () => pipe,
      expire: () => pipe,
      rpush: () => pipe,
      exec: async () => {
        for (const op of ops) await op();
        return [];
      },
    };
    return pipe;
  }

  subscribePubSub(): ResultPubSub {
    const sub = new InMemoryPubSub(this.subscribers);
    return sub;
  }
}

class InMemoryPubSub implements ResultPubSub {
  private readonly channels = new Set<string>();
  private readonly inbox: Array<{ channel: string; message: string }> = [];
  private readonly waiters: Array<(msg: ResultPubSubMessage | null) => void> = [];
  private closed = false;

  constructor(private readonly registry: Set<InMemoryPubSub>) {
    this.registry.add(this);
  }

  async subscribe(channel: string): Promise<void> {
    this.channels.add(channel);
  }

  async unsubscribe(channel: string): Promise<void> {
    this.channels.delete(channel);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.registry.delete(this);
    while (this.waiters.length > 0) {
      const w = this.waiters.shift();
      if (w !== undefined) w(null);
    }
  }

  deliver(channel: string, message: string): void {
    if (!this.channels.has(channel) || this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter !== undefined) {
      waiter({ data: message });
      return;
    }
    this.inbox.push({ channel, message });
  }

  async getMessage(innerTimeoutMs: number, _outerTimeoutMs: number): Promise<ResultPubSubMessage | null> {
    const pending = this.inbox.shift();
    if (pending !== undefined) return { data: pending.message };
    if (this.closed) return null;
    return new Promise<ResultPubSubMessage | null>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const onMessage = (msg: ResultPubSubMessage | null): void => {
        if (timer !== null) clearTimeout(timer);
        resolve(msg);
      };
      this.waiters.push(onMessage);
      timer = setTimeout(
        () => {
          const idx = this.waiters.indexOf(onMessage);
          if (idx >= 0) this.waiters.splice(idx, 1);
          resolve(null);
        },
        Math.max(1, innerTimeoutMs),
      );
    });
  }
}

interface Rig {
  registry: ConnectionRegistry;
  publisher: ResultPublisherService;
  dispatcher: Dispatcher;
  fakeRecords: FakeAgentRecord[];
  bgTasks: Array<{ stop: () => void; done: Promise<void> }>;
}

function silentLogger(): DispatchLogger {
  return {
    debug() {},
    info() {},
    warn() {},
  };
}

function noopVersionGate(): AgentVersionGate {
  return {
    expectedVersion: () => '',
    triggerUpgrade: () => {},
  };
}

function noopCancelEncoder(): CancelWorkEncoder {
  return {
    encode: () => new Uint8Array(),
  };
}

function makeRig(): Rig {
  const registry = new ConnectionRegistry();
  const publisher = new ResultPublisherService(new InMemoryRedis());
  const dispatcher = new Dispatcher(registry, publisher, silentLogger(), noopVersionGate(), noopCancelEncoder());
  return { registry, publisher, dispatcher, fakeRecords: [], bgTasks: [] };
}

async function teardownRig(rig: Rig): Promise<void> {
  for (const task of rig.bgTasks) task.stop();
  for (const task of rig.bgTasks) {
    await task.done.catch(() => undefined);
  }
}

interface QueueWorkRequest {
  workId: string;
  operation: string;
  input: Uint8Array;
  jobId: string;
  deadline?: { seconds: number; nanos: number };
}

interface ServerMessageEnvelope {
  workRequest?: QueueWorkRequest;
  cancelWork?: { workId: string; reason: string };
}

function isWorkRequestEnvelope(value: unknown): value is { workRequest: QueueWorkRequest } {
  if (typeof value !== 'object' || value === null) return false;
  const env = value as ServerMessageEnvelope;
  return (
    env.workRequest !== undefined &&
    typeof env.workRequest.workId === 'string' &&
    typeof env.workRequest.operation === 'string' &&
    env.workRequest.input instanceof Uint8Array &&
    typeof env.workRequest.jobId === 'string'
  );
}

function spawnFakeAgent(args: {
  handle: SessionHandle;
  cancelled: CancelSignal;
  publisher: ResultPublisherService;
  scripted: FixtureCall[];
  records: FakeAgentRecord[];
}): { stop: () => void; done: Promise<void> } {
  let nextIdx = 0;
  let stopped = false;
  const stopSignal: CancelSignal & { signal(): void } = (() => {
    let isSetFlag = false;
    const waiters: Array<() => void> = [];
    return {
      isSet: () => isSetFlag || args.cancelled.isSet(),
      wait: async () => {
        if (isSetFlag || args.cancelled.isSet()) return;
        await Promise.race([new Promise<void>((r) => waiters.push(r)), args.cancelled.wait()]);
      },
      signal: () => {
        if (isSetFlag) return;
        isSetFlag = true;
        for (const w of waiters.splice(0, waiters.length)) w();
      },
    };
  })();

  const done = (async () => {
    while (!stopped) {
      const item = await args.handle.queue.getOrCancel(stopSignal);
      if (typeof item === 'symbol' || stopped) return;
      if (!isWorkRequestEnvelope(item)) continue;

      const decoded = item.workRequest;

      let payload: Record<string, unknown> = {};
      if (decoded.input.length > 0) {
        try {
          payload = JSON.parse(TEXT_DECODER.decode(decoded.input)) as Record<string, unknown>;
        } catch {
          payload = {};
        }
      }

      args.records.push({
        operation: decoded.operation,
        workId: decoded.workId,
        jobId: decoded.jobId,
        inputJson: payload,
      });

      if (nextIdx >= args.scripted.length) {
        throw new Error(
          `Fake agent received an extra unscripted dispatch: op=${decoded.operation} after ${nextIdx} scripted responses consumed`,
        );
      }
      const expected = args.scripted[nextIdx];
      if (expected.operation !== decoded.operation) {
        throw new Error(
          `Dispatch-order mismatch at index ${nextIdx}: fixture expects ${expected.operation} but saga dispatched ${decoded.operation}`,
        );
      }
      for (const key of expected.expected_input_keys ?? []) {
        if (!(key in payload)) {
          throw new Error(
            `WorkRequest for op ${decoded.operation} missing expected input key ${key}; got keys: ${Object.keys(payload).sort().join(',')}`,
          );
        }
      }

      const responseBytes = encodeWorkResponse({
        workId: decoded.workId,
        status: WorkResponseStatus.SUCCESS,
        output: TEXT_ENCODER.encode(JSON.stringify(expected.response)),
      });
      await args.publisher.publishResult(decoded.workId, Buffer.from(responseBytes));
      nextIdx += 1;
    }
  })();

  return {
    stop: () => {
      stopped = true;
      stopSignal.signal();
    },
    done,
  };
}

async function loadFixture(sagaName: string): Promise<Fixture> {
  const raw = await fs.readFile(path.join(FIXTURES_DIR, sagaName, 'responses.json'), 'utf-8');
  return JSON.parse(raw) as Fixture;
}

async function driveSagaScenario(rig: Rig, sagaName: string, expectedSequence: readonly string[]): Promise<void> {
  const fixture = await loadFixture(sagaName);
  const deviceId = fixture.device_id;
  const scripted = fixture.calls;

  const fixtureOps = scripted.map((c) => c.operation);
  expect(fixtureOps).toEqual([...expectedSequence]);

  const handle = await rig.registry.register(deviceId, { agentVersion: '0.0.0-dev' });
  const fakeAgent = spawnFakeAgent({
    handle,
    cancelled: handle.cancelled,
    publisher: rig.publisher,
    scripted,
    records: rig.fakeRecords,
  });
  rig.bgTasks.push(fakeAgent);

  const jobId = `saga-${sagaName}-replay-job`;
  for (const spec of scripted) {
    const payload: Record<string, unknown> = {};
    for (const key of spec.expected_input_keys ?? []) {
      if (key === 'disk_layouts') {
        payload[key] = [{ disks: ['sda'], fs_type: 'ext4', mountpoint: '/', wipe: true }];
      } else if (key === 'environment') {
        payload[key] = 'development';
      } else if (key === 'job_id') {
        payload[key] = jobId;
      } else if (key === 'target_path') {
        payload[key] = '/target';
      } else if (key === 'curtin_yaml') {
        payload[key] = 'storage:\n  version: 1\n';
      } else {
        payload[key] = '';
      }
    }

    const result = await rig.dispatcher.dispatch(deviceId, spec.operation, payload, {
      jobId,
      timeoutS: 3.0,
    });
    expect(result).toEqual(spec.response);
  }

  const observedOps = rig.fakeRecords.map((r) => r.operation);
  expect(observedOps).toEqual([...expectedSequence]);
  for (const rec of rig.fakeRecords) {
    expect(rec.workId).not.toBe('');
    expect(rec.jobId).toBe(jobId);
  }
}

describe('integration/grpc: dispatch replay', () => {
  let rig: Rig;

  beforeEach(() => {
    rig = makeRig();
    return async () => teardownRig(rig);
  });

  it('provision saga: 6 gRPC dispatches in fixed order', async () => {
    await driveSagaScenario(rig, 'provision', PROVISION_SEQUENCE);
    expect(rig.fakeRecords).toHaveLength(6);
    await teardownRig(rig);
  });

  it('commission saga: 2 gRPC dispatches in fixed order', async () => {
    await driveSagaScenario(rig, 'commission', COMMISSION_SEQUENCE);
    expect(rig.fakeRecords).toHaveLength(2);
    await teardownRig(rig);
  });

  it('deprovision saga: 2 gRPC dispatches in fixed order', async () => {
    await driveSagaScenario(rig, 'deprovision', DEPROVISION_SEQUENCE);
    expect(rig.fakeRecords).toHaveLength(2);
    await teardownRig(rig);
  });

  it('fixture files present for all scenarios', async () => {
    for (const sagaName of ['provision', 'commission', 'deprovision']) {
      const fixturePath = path.join(FIXTURES_DIR, sagaName, 'responses.json');
      const stat = await fs.stat(fixturePath);
      expect(stat.isFile()).toBe(true);
      const payload = JSON.parse(await fs.readFile(fixturePath, 'utf-8')) as Fixture;
      expect(payload.device_id).toBeDefined();
      expect(Array.isArray(payload.calls)).toBe(true);
      for (const entry of payload.calls) {
        expect(entry.operation).toBeDefined();
        expect(entry.response).toBeDefined();
      }
    }
  });
});
