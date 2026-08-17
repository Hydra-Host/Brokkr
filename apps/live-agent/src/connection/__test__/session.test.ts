import { create } from '@bufbuild/protobuf';
import { Code, ConnectError } from '@connectrpc/connect';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../dispatch/dispatcher', () => ({
  dispatch: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../phone-home', () => ({
  firePhoneHomeOverGrpc: vi.fn().mockResolvedValue(undefined),
}));

import type { AgentConfig } from '../../config';
import { dispatch as mockDispatch } from '../../dispatch/dispatcher';
import {
  HostsEntrySchema,
  ServerMessageSchema,
  SessionAcceptedSchema,
  TopologyUpdateSchema,
} from '../../gen/brokkr/agent/v1/agent_pb';
import { WorkRequestSchema, WorkResponse_Status } from '../../gen/brokkr/agent/v1/work_pb';
import { type BufferedEntry, setLogSink } from '../../logger';
import { firePhoneHomeOverGrpc as mockFirePhoneHome } from '../../phone-home';
import { AGENT_VERSION } from '../../version';
import type { ResultReporter } from '../result-reporter';
import { runSession } from '../session';

function makeConfig(): AgentConfig {
  return {
    device_id: 'dev-drift',
    zone_id: '00000000-0000-4000-8000-000000000001',
    insecure: false,
    bridges: [{ address: 'test-bridge:443' }],
    auth: { token: 'test-token' },
    tls: { ca_bundle_path: '/nonexistent/ca.crt', reject_unauthorized: false },
    telemetry: { traces_enabled: false },
    agent: {
      heartbeat_interval_ms: 30_000,
      heartbeat_timeout_ms: 90_000,
      reconnect_backoff_initial_ms: 1_000,
      reconnect_backoff_max_ms: 60_000,
      work_timeout_default_ms: 300_000,
      max_concurrent_dispatches: 96,
      token_renew_interval_ms: 3_600_000,
      log_level: 'info',
      collection_snapshot_path: '/tmp/brokkr-test-snapshots',
    },
  };
}

function makeStubReporter(): ResultReporter {
  return {
    reportResult: vi.fn().mockResolvedValue(undefined),
    reportProgress: vi.fn().mockResolvedValue(undefined),
    reportPartialResult: vi.fn().mockResolvedValue(undefined),
  };
}

function makeClientYieldingAccept(echoedVersion: string) {
  const stream = (async function* () {
    yield create(ServerMessageSchema, {
      kind: {
        case: 'sessionAccepted',
        value: create(SessionAcceptedSchema, {
          bridgeId: 'test-bridge-id',
          topology: [],
          agentVersion: echoedVersion,
        }),
      },
    });
  })();
  return {
    openSession: vi.fn().mockReturnValue(stream),
    fetchBundle: vi.fn(),
  };
}

describe('runSession SessionAccepted version drift', () => {
  let captured: BufferedEntry[];

  beforeEach(() => {
    captured = [];
    setLogSink((e) => captured.push(e));
  });

  afterEach(() => {
    setLogSink(null);
  });

  it('logs a warn entry when the bridge-echoed agent_version differs from AGENT_VERSION', async () => {
    const driftedVersion = `${AGENT_VERSION}-differs-for-test`;
    const client = makeClientYieldingAccept(driftedVersion);

    await runSession(
      client as unknown as Parameters<typeof runSession>[0],
      'https://test-bridge:443',
      makeConfig(),
      makeStubReporter(),
      { onRegistered: vi.fn(), onTopologyUpdate: vi.fn() },
      new AbortController().signal,
    );

    const driftWarns = captured.filter(
      (e) => e.log_level === 'warn' && e.message.startsWith('agent version drift detected'),
    );
    expect(driftWarns).toHaveLength(1);
    expect(driftWarns[0]!.message).toContain(`agent_version=${AGENT_VERSION}`);
    expect(driftWarns[0]!.message).toContain(`bridge_expected_version=${driftedVersion}`);
  });

  it('does not log a drift warn when versions match', async () => {
    const client = makeClientYieldingAccept(AGENT_VERSION);

    await runSession(
      client as unknown as Parameters<typeof runSession>[0],
      'https://test-bridge:443',
      makeConfig(),
      makeStubReporter(),
      { onRegistered: vi.fn(), onTopologyUpdate: vi.fn() },
      new AbortController().signal,
    );

    const driftWarns = captured.filter(
      (e) => e.log_level === 'warn' && e.message.startsWith('agent version drift detected'),
    );
    expect(driftWarns).toHaveLength(0);
  });

  it('does not log a drift warn when the bridge echoes an empty string (pre-populated bridges)', async () => {
    const client = makeClientYieldingAccept('');

    await runSession(
      client as unknown as Parameters<typeof runSession>[0],
      'https://test-bridge:443',
      makeConfig(),
      makeStubReporter(),
      { onRegistered: vi.fn(), onTopologyUpdate: vi.fn() },
      new AbortController().signal,
    );

    const driftWarns = captured.filter(
      (e) => e.log_level === 'warn' && e.message.startsWith('agent version drift detected'),
    );
    expect(driftWarns).toHaveLength(0);
  });
});

describe('runSession phone-home on session_accepted', () => {
  beforeEach(() => {
    vi.mocked(mockFirePhoneHome).mockClear();
  });

  it('fires phone-home once on sessionAccepted', async () => {
    const client = makeClientYieldingAccept(AGENT_VERSION);

    await runSession(
      client as unknown as Parameters<typeof runSession>[0],
      'https://test-bridge:443',
      makeConfig(),
      makeStubReporter(),
      { onRegistered: vi.fn(), onTopologyUpdate: vi.fn() },
      new AbortController().signal,
    );

    expect(mockFirePhoneHome).toHaveBeenCalledTimes(1);
    const provider = vi.mocked(mockFirePhoneHome).mock.calls[0]![0];
    expect(typeof provider).toBe('function');
    expect(provider()).not.toBeNull();
  });

  it('does not fire phone-home when the stream yields no sessionAccepted', async () => {
    const client = {
      openSession: vi.fn().mockReturnValue((async function* () {})()),
      fetchBundle: vi.fn(),
    };

    await runSession(
      client as unknown as Parameters<typeof runSession>[0],
      'https://test-bridge:443',
      makeConfig(),
      makeStubReporter(),
      { onRegistered: vi.fn(), onTopologyUpdate: vi.fn() },
      new AbortController().signal,
    );

    expect(mockFirePhoneHome).not.toHaveBeenCalled();
  });
});

function makeClientYieldingWork(workRequest: ReturnType<typeof create<typeof WorkRequestSchema>>) {
  const stream = (async function* () {
    yield create(ServerMessageSchema, {
      kind: {
        case: 'sessionAccepted',
        value: create(SessionAcceptedSchema, {
          bridgeId: 'test-bridge-id',
          topology: [],
          agentVersion: AGENT_VERSION,
        }),
      },
    });
    yield create(ServerMessageSchema, {
      kind: { case: 'workRequest', value: workRequest },
    });
  })();
  return {
    openSession: vi.fn().mockReturnValue(stream),
    fetchBundle: vi.fn(),
  };
}

function makeClientThrowingConnectError(code: Code) {
  // eslint-disable-next-line require-yield -- generator throws before yielding by design (drives session.ts catch path)
  const stream = (async function* (): AsyncGenerator<ReturnType<typeof create<typeof ServerMessageSchema>>> {
    await Promise.resolve();
    throw new ConnectError('test error', code);
  })();
  return {
    openSession: vi.fn().mockReturnValue(stream),
    fetchBundle: vi.fn(),
  };
}

describe('runSession permanent-vs-transient classification', () => {
  it.each([
    ['Unauthenticated', Code.Unauthenticated, false],
    ['PermissionDenied', Code.PermissionDenied, false],
    ['NotFound', Code.NotFound, true],
    ['InvalidArgument', Code.InvalidArgument, true],
    ['FailedPrecondition', Code.FailedPrecondition, true],
    ['Unavailable', Code.Unavailable, false],
    ['DeadlineExceeded', Code.DeadlineExceeded, false],
  ])('classifies %s as permanent=%s', async (_name, code, expectPermanent) => {
    const client = makeClientThrowingConnectError(code);
    const result = await runSession(
      client as unknown as Parameters<typeof runSession>[0],
      'https://test-bridge:443',
      makeConfig(),
      makeStubReporter(),
      { onRegistered: vi.fn(), onTopologyUpdate: vi.fn() },
      new AbortController().signal,
    );
    expect(result.permanent).toBe(expectPermanent);
  });
});

function makeClientYieldingWorkThenCancel(
  workRequest: ReturnType<typeof create<typeof WorkRequestSchema>>,
  cancelWorkId: string,
) {
  const stream = (async function* () {
    yield create(ServerMessageSchema, {
      kind: {
        case: 'sessionAccepted',
        value: create(SessionAcceptedSchema, {
          bridgeId: 'test-bridge-id',
          topology: [],
          agentVersion: AGENT_VERSION,
        }),
      },
    });
    yield create(ServerMessageSchema, {
      kind: { case: 'workRequest', value: workRequest },
    });
    await Promise.resolve();
    yield create(ServerMessageSchema, {
      kind: { case: 'cancelWork', value: { workId: cancelWorkId, reason: 'saga_cancelled' } },
    });
  })();
  return {
    openSession: vi.fn().mockReturnValue(stream),
    fetchBundle: vi.fn(),
  };
}

describe('runSession cancelWork (F-13)', () => {
  beforeEach(() => {
    vi.mocked(mockDispatch).mockClear();
  });

  it('aborts the matching in-flight dispatch via the parent signal', async () => {
    let capturedSignal: AbortSignal | undefined;
    vi.mocked(mockDispatch).mockImplementation(async (_req, _send, opts) => {
      capturedSignal = opts?.parentSignal;
      await new Promise<void>((resolve) => {
        if (capturedSignal?.aborted) {
          resolve();
        } else {
          capturedSignal?.addEventListener('abort', () => resolve(), { once: true });
        }
      });
    });

    const work = create(WorkRequestSchema, {
      workId: 'w-cancel-target',
      operation: 'system.getArchitecture',
      input: new Uint8Array(),
    });
    const client = makeClientYieldingWorkThenCancel(work, 'w-cancel-target');

    await runSession(
      client as unknown as Parameters<typeof runSession>[0],
      'https://test-bridge:443',
      makeConfig(),
      makeStubReporter(),
      { onRegistered: vi.fn(), onTopologyUpdate: vi.fn() },
      new AbortController().signal,
    );

    expect(capturedSignal).toBeDefined();
    expect(capturedSignal?.aborted).toBe(true);
  });

  it('CAS-delete on dispatch finally: cancel + retry with same work_id keeps the new dispatch registered', async () => {
    const captured: AbortSignal[] = [];
    vi.mocked(mockDispatch).mockImplementation(async (_req, _send, opts) => {
      const sig = opts!.parentSignal!;
      captured.push(sig);
      await new Promise<void>((resolve) => {
        if (sig.aborted) {
          resolve();
        } else {
          sig.addEventListener('abort', () => resolve(), { once: true });
        }
      });
    });

    const work = create(WorkRequestSchema, {
      workId: 'w-race',
      operation: 'system.getArchitecture',
      input: new Uint8Array(),
    });

    const stream = (async function* () {
      yield create(ServerMessageSchema, {
        kind: {
          case: 'sessionAccepted',
          value: create(SessionAcceptedSchema, {
            bridgeId: 'test-bridge-id',
            topology: [],
            agentVersion: AGENT_VERSION,
          }),
        },
      });
      yield create(ServerMessageSchema, { kind: { case: 'workRequest', value: work } });
      await Promise.resolve();
      yield create(ServerMessageSchema, {
        kind: { case: 'cancelWork', value: { workId: 'w-race', reason: 'saga_cancelled' } },
      });
      await Promise.resolve();
      yield create(ServerMessageSchema, { kind: { case: 'workRequest', value: work } });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      yield create(ServerMessageSchema, {
        kind: { case: 'cancelWork', value: { workId: 'w-race', reason: 'saga_cancelled' } },
      });
    })();
    const client = { openSession: vi.fn().mockReturnValue(stream), fetchBundle: vi.fn() };

    await runSession(
      client as unknown as Parameters<typeof runSession>[0],
      'https://test-bridge:443',
      makeConfig(),
      makeStubReporter(),
      { onRegistered: vi.fn(), onTopologyUpdate: vi.fn() },
      new AbortController().signal,
    );

    expect(captured).toHaveLength(2);
    expect(captured[0]!.aborted).toBe(true);
    expect(captured[1]!.aborted).toBe(true);
  });

  it('cancel_work for unknown work_id is a no-op (debug log only)', async () => {
    vi.mocked(mockDispatch).mockResolvedValue(undefined);

    const work = create(WorkRequestSchema, {
      workId: 'w-already-finished',
      operation: 'system.getArchitecture',
      input: new Uint8Array(),
    });
    const client = makeClientYieldingWorkThenCancel(work, 'w-never-existed');

    const result = await runSession(
      client as unknown as Parameters<typeof runSession>[0],
      'https://test-bridge:443',
      makeConfig(),
      makeStubReporter(),
      { onRegistered: vi.fn(), onTopologyUpdate: vi.fn() },
      new AbortController().signal,
    );
    expect(result.permanent).toBe(false);
  });
});

describe('runSession workRequest timeout fallback', () => {
  beforeEach(() => {
    vi.mocked(mockDispatch).mockClear();
  });

  it('fills missing timeout_ms with config.agent.work_timeout_default_ms', async () => {
    const work = create(WorkRequestSchema, {
      workId: 'w-no-deadline',
      operation: 'system.getArchitecture',
      input: new Uint8Array(),
    });
    const client = makeClientYieldingWork(work);

    const config = makeConfig();
    await runSession(
      client as unknown as Parameters<typeof runSession>[0],
      'https://test-bridge:443',
      config,
      makeStubReporter(),
      { onRegistered: vi.fn(), onTopologyUpdate: vi.fn() },
      new AbortController().signal,
    );

    expect(mockDispatch).toHaveBeenCalledTimes(1);
    const zodReq = vi.mocked(mockDispatch).mock.calls[0]![0];
    expect(zodReq.timeout_ms).toBe(config.agent.work_timeout_default_ms);
  });

  it('fills zero-valued timeout_ms (proto3 default Duration) with config default', async () => {
    const work = create(WorkRequestSchema, {
      workId: 'w-zero-deadline',
      operation: 'system.getArchitecture',
      input: new Uint8Array(),
      deadline: { seconds: 0n, nanos: 0 },
    });
    const client = makeClientYieldingWork(work);

    const config = makeConfig();
    await runSession(
      client as unknown as Parameters<typeof runSession>[0],
      'https://test-bridge:443',
      config,
      makeStubReporter(),
      { onRegistered: vi.fn(), onTopologyUpdate: vi.fn() },
      new AbortController().signal,
    );

    expect(mockDispatch).toHaveBeenCalledTimes(1);
    const zodReq = vi.mocked(mockDispatch).mock.calls[0]![0];
    expect(zodReq.timeout_ms).toBe(config.agent.work_timeout_default_ms);
  });

  it('preserves an explicit bridge-supplied timeout_ms', async () => {
    const work = create(WorkRequestSchema, {
      workId: 'w-with-deadline',
      operation: 'system.getArchitecture',
      input: new Uint8Array(),
      deadline: { seconds: 12n, nanos: 500_000_000 },
    });
    const client = makeClientYieldingWork(work);

    await runSession(
      client as unknown as Parameters<typeof runSession>[0],
      'https://test-bridge:443',
      makeConfig(),
      makeStubReporter(),
      { onRegistered: vi.fn(), onTopologyUpdate: vi.fn() },
      new AbortController().signal,
    );

    expect(mockDispatch).toHaveBeenCalledTimes(1);
    const zodReq = vi.mocked(mockDispatch).mock.calls[0]![0];
    expect(zodReq.timeout_ms).toBe(12_500);
  });
});

function makeClientYieldingWorks(works: ReturnType<typeof create<typeof WorkRequestSchema>>[]) {
  const stream = (async function* () {
    yield create(ServerMessageSchema, {
      kind: {
        case: 'sessionAccepted',
        value: create(SessionAcceptedSchema, { bridgeId: 'test-bridge-id', topology: [], agentVersion: AGENT_VERSION }),
      },
    });
    for (const work of works) {
      yield create(ServerMessageSchema, { kind: { case: 'workRequest', value: work } });
    }
  })();
  return { openSession: vi.fn().mockReturnValue(stream), fetchBundle: vi.fn() };
}

describe('runSession dispatch concurrency cap', () => {
  beforeEach(() => {
    vi.mocked(mockDispatch).mockClear();
  });

  function blockUntilAborted() {
    vi.mocked(mockDispatch).mockImplementation(async (_req, _send, opts) => {
      const sig = opts!.parentSignal!;
      if (sig.aborted) return;
      await new Promise<void>((resolve) => sig.addEventListener('abort', () => resolve(), { once: true }));
    });
  }

  it('throttles work beyond the cap with a THROTTLED failure and never dispatches it', async () => {
    blockUntilAborted();
    const works = ['w-1', 'w-2', 'w-3', 'w-4'].map((id) =>
      create(WorkRequestSchema, { workId: id, operation: 'system.getArchitecture', input: new Uint8Array() }),
    );
    const client = makeClientYieldingWorks(works);
    const reporter = makeStubReporter();
    const config = makeConfig();
    config.agent.max_concurrent_dispatches = 2;

    await runSession(
      client as unknown as Parameters<typeof runSession>[0],
      'https://test-bridge:443',
      config,
      reporter,
      { onRegistered: vi.fn(), onTopologyUpdate: vi.fn() },
      new AbortController().signal,
    );

    expect(mockDispatch).toHaveBeenCalledTimes(2);
    const dispatchedIds = vi.mocked(mockDispatch).mock.calls.map((c) => c[0].work_id);
    expect(dispatchedIds).toEqual(['w-1', 'w-2']);

    const throttled = vi.mocked(reporter.reportResult).mock.calls.map((c) => c[0]);
    expect(throttled).toHaveLength(2);
    for (const resp of throttled) {
      expect(resp.status).toBe(WorkResponse_Status.FAILURE);
      expect(resp.error?.code).toBe('THROTTLED');
    }
    expect(throttled.map((r) => r.workId)).toEqual(['w-3', 'w-4']);
  });

  it('counts a cancelled-but-still-tearing-down dispatch against the cap (no undercount)', async () => {
    let release!: () => void;
    const tearingDown = new Promise<void>((r) => {
      release = r;
    });
    vi.mocked(mockDispatch).mockImplementation(async () => {
      await tearingDown;
    });

    const w1 = create(WorkRequestSchema, {
      workId: 'w-1',
      operation: 'system.getArchitecture',
      input: new Uint8Array(),
    });
    const w2 = create(WorkRequestSchema, {
      workId: 'w-2',
      operation: 'system.getArchitecture',
      input: new Uint8Array(),
    });
    const stream = (async function* () {
      yield create(ServerMessageSchema, {
        kind: {
          case: 'sessionAccepted',
          value: create(SessionAcceptedSchema, { bridgeId: 'b', topology: [], agentVersion: AGENT_VERSION }),
        },
      });
      yield create(ServerMessageSchema, { kind: { case: 'workRequest', value: w1 } });
      yield create(ServerMessageSchema, {
        kind: { case: 'cancelWork', value: { workId: 'w-1', reason: 'cancelled' } },
      });
      yield create(ServerMessageSchema, { kind: { case: 'workRequest', value: w2 } });
    })();
    const client = { openSession: vi.fn().mockReturnValue(stream), fetchBundle: vi.fn() };
    const reporter = makeStubReporter();
    const config = makeConfig();
    config.agent.max_concurrent_dispatches = 1;

    await runSession(
      client as unknown as Parameters<typeof runSession>[0],
      'https://test-bridge:443',
      config,
      reporter,
      { onRegistered: vi.fn(), onTopologyUpdate: vi.fn() },
      new AbortController().signal,
    );

    expect(mockDispatch).toHaveBeenCalledTimes(1);
    const throttled = vi.mocked(reporter.reportResult).mock.calls.map((c) => c[0]);
    expect(throttled.map((r) => r.workId)).toEqual(['w-2']);
    expect(throttled[0]!.error?.code).toBe('THROTTLED');

    release();
  });
});

describe('runSession TopologyUpdate forwarding', () => {
  it('forwards hostsEntries from TopologyUpdate to the onTopologyUpdate callback', async () => {
    const stream = (async function* () {
      yield create(ServerMessageSchema, {
        kind: {
          case: 'sessionAccepted',
          value: create(SessionAcceptedSchema, {
            bridgeId: 'bridge-1',
            topology: [],
            agentVersion: AGENT_VERSION,
          }),
        },
      });
      yield create(ServerMessageSchema, {
        kind: {
          case: 'topologyUpdate',
          value: create(TopologyUpdateSchema, {
            bridges: [],
            hostsEntries: [
              create(HostsEntrySchema, { ip: '10.0.0.231', hostname: 'bridge-1' }),
              create(HostsEntrySchema, { ip: '10.0.0.232', hostname: 'bridge-2' }),
            ],
          }),
        },
      });
    })();
    const client = {
      openSession: vi.fn().mockReturnValue(stream),
      fetchBundle: vi.fn(),
    };

    const onTopologyUpdate = vi.fn();
    await runSession(
      client as unknown as Parameters<typeof runSession>[0],
      'https://test-bridge:443',
      makeConfig(),
      makeStubReporter(),
      { onRegistered: vi.fn(), onTopologyUpdate },
      new AbortController().signal,
    );

    expect(onTopologyUpdate).toHaveBeenCalledTimes(1);
    const [bridgesArg, hostsArg] = onTopologyUpdate.mock.calls[0]!;
    expect(bridgesArg).toEqual([]);
    expect(hostsArg).toEqual([
      { ip: '10.0.0.231', hostname: 'bridge-1' },
      { ip: '10.0.0.232', hostname: 'bridge-2' },
    ]);
  });

  it('forwards an empty hostsEntries list when bridge omits the field', async () => {
    const stream = (async function* () {
      yield create(ServerMessageSchema, {
        kind: {
          case: 'sessionAccepted',
          value: create(SessionAcceptedSchema, {
            bridgeId: 'bridge-1',
            topology: [],
            agentVersion: AGENT_VERSION,
          }),
        },
      });
      yield create(ServerMessageSchema, {
        kind: {
          case: 'topologyUpdate',
          value: create(TopologyUpdateSchema, { bridges: [] }),
        },
      });
    })();
    const client = {
      openSession: vi.fn().mockReturnValue(stream),
      fetchBundle: vi.fn(),
    };

    const onTopologyUpdate = vi.fn();
    await runSession(
      client as unknown as Parameters<typeof runSession>[0],
      'https://test-bridge:443',
      makeConfig(),
      makeStubReporter(),
      { onRegistered: vi.fn(), onTopologyUpdate },
      new AbortController().signal,
    );

    expect(onTopologyUpdate).toHaveBeenCalledTimes(1);
    const [, hostsArg] = onTopologyUpdate.mock.calls[0]!;
    expect(hostsArg).toEqual([]);
  });
});
