import { create } from '@bufbuild/protobuf';
import { createClient } from '@connectrpc/connect';
import { createGrpcTransport } from '@connectrpc/connect-node';
import * as http2 from 'node:http2';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentService } from '../../gen/brokkr/agent/v1/agent_pb';
import { PartialResultSchema } from '../../gen/brokkr/agent/v1/work_pb';
import type { TransportPool } from '../pool';
import { createResultReporter } from '../result-reporter';

interface StubControl {
  port: number;
  accepted: number;
  refused: number;
  refuseRate: number;
  setRefuseRate(rate: number): void;
  setRefuseFirstN(n: number): void;
  close(): Promise<void>;
}

async function startStub(): Promise<StubControl> {
  const state = { refuseRate: 0, refuseFirstN: 0, refusedSoFar: 0, accepted: 0, refused: 0 };
  const server = http2.createServer();
  const sessions = new Set<http2.Http2Session>();
  server.on('session', (session) => {
    sessions.add(session);
    session.on('close', () => sessions.delete(session));
  });

  server.on('stream', (stream) => {
    stream.on('error', () => {});

    const shouldRefuse =
      (state.refuseFirstN > 0 && state.refusedSoFar < state.refuseFirstN) ||
      (state.refuseRate > 0 && Math.random() < state.refuseRate);
    if (shouldRefuse) {
      state.refused += 1;
      state.refusedSoFar += 1;
      stream.close(http2.constants.NGHTTP2_REFUSED_STREAM);
      return;
    }
    stream.on('data', () => {});
    stream.on('end', () => {
      stream.respond({ ':status': 200, 'content-type': 'application/grpc' }, { waitForTrailers: true });
      stream.on('wantTrailers', () => {
        stream.sendTrailers({ 'grpc-status': '0' });
      });
      stream.write(Buffer.from([0x00, 0x00, 0x00, 0x00, 0x00]));
      stream.end();
      state.accepted += 1;
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    port,
    get accepted() {
      return state.accepted;
    },
    get refused() {
      return state.refused;
    },
    get refuseRate() {
      return state.refuseRate;
    },
    setRefuseRate(rate) {
      state.refuseRate = rate;
    },
    setRefuseFirstN(n) {
      state.refuseFirstN = n;
      state.refusedSoFar = 0;
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const session of sessions) session.destroy();
        sessions.clear();
        server.close(() => resolve());
      }),
  };
}

function makeRealPool(baseUrl: string): TransportPool {
  const transport = createGrpcTransport({ baseUrl });
  const client = createClient(AgentService, transport);
  return {
    listAddresses: () => [baseUrl],
    getClient: () => client,
    removeBridge: () => {},
  };
}

function makePartial(workId: string): import('../../gen/brokkr/agent/v1/work_pb').PartialResult {
  return create(PartialResultSchema, { workId, unit: 'ip_a' });
}

const FAST_BACKOFF = { retryInitialMs: 1, retryMaxMs: 4 } as const;

describe('result-reporter e2e against real RST_STREAM', () => {
  let stub: StubControl;
  beforeEach(async () => {
    stub = await startStub();
  });
  afterEach(async () => {
    await stub.close();
  });

  it('recovers from a burst of REFUSED_STREAM frames via retry', async () => {
    stub.setRefuseFirstN(5);
    const pool = makeRealPool(`http://127.0.0.1:${stub.port}`);
    const reporter = createResultReporter(pool);
    await reporter.reportPartialResult(makePartial('w-1'), FAST_BACKOFF);
    expect(stub.refused).toBe(5);
    expect(stub.accepted).toBeGreaterThanOrEqual(1);
  });

  it('reportPartialResult eventually delivers when all retries hit some refusals', async () => {
    stub.setRefuseRate(0.3);
    const pool = makeRealPool(`http://127.0.0.1:${stub.port}`);
    const reporter = createResultReporter(pool);
    await reporter.reportPartialResult(makePartial('w-2'), FAST_BACKOFF);
    expect(stub.accepted).toBeGreaterThanOrEqual(1);
  });

  it('throws if all retries exhaust (sustained refusal)', async () => {
    stub.setRefuseRate(1.0);
    const pool = makeRealPool(`http://127.0.0.1:${stub.port}`);
    const reporter = createResultReporter(pool);
    await expect(reporter.reportPartialResult(makePartial('w-3'), FAST_BACKOFF)).rejects.toThrow();
    expect(stub.accepted).toBe(0);
    expect(stub.refused).toBeGreaterThan(0);
  }, 60_000);

  it('24 concurrent emits under transient pressure: zero data loss vs zero lies', async () => {
    stub.setRefuseRate(0.2);
    const pool = makeRealPool(`http://127.0.0.1:${stub.port}`);
    const reporter = createResultReporter(pool);
    const N = 24;
    const results = await Promise.allSettled(
      Array.from({ length: N }, (_, i) => reporter.reportPartialResult(makePartial(`w-${i}`), FAST_BACKOFF)),
    );
    const succeeded = results.filter((r) => r.status === 'fulfilled').length;
    const failed = results.filter((r) => r.status === 'rejected').length;
    expect(succeeded).toBeLessThanOrEqual(stub.accepted);
    expect(succeeded + failed).toBe(N);
  });
});
