import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { dispatch } from '../../../dispatch/dispatcher';
import { clearOperationsForTests, registerPluginOperation, replaceOperationForTests } from '../../../dispatch/registry';
import { registerCollectAll } from '../collectAll';

beforeEach(() => {
  vi.spyOn(Math, 'random').mockReturnValue(0);
});

afterEach(() => {
  vi.restoreAllMocks();
  clearOperationsForTests();
});

function registerFakeCollector(name: string) {
  registerPluginOperation(`collection.${name}`, z.unknown(), z.any(), async () => ({ value: 1 }));
}

function extractWorkResponse(sendCalls: { type: string }[]): { successes: number; failures: number } | null {
  const resp = sendCalls.find((m) => m.type === 'work.response') as
    | { type: 'work.response'; output?: { successes?: number; failures?: number } }
    | undefined;
  if (!resp || !resp.output) return null;
  return {
    successes: resp.output.successes ?? -1,
    failures: resp.output.failures ?? -1,
  };
}

describe('collectAll delivery-failure accounting', () => {
  it('counts dropped partial-result emits as failures, not silent successes', async () => {
    registerCollectAll('/tmp/snapshots-unused');
    registerFakeCollector('fake_a');
    registerFakeCollector('fake_b');

    const sent: { type: string }[] = [];
    const send = async (msg: { type: string }) => {
      sent.push(msg);
      if (msg.type === 'collection.result') {
        throw new Error('Stream closed with error code NGHTTP2_REFUSED_STREAM');
      }
    };

    await dispatch(
      {
        type: 'work.request',
        work_id: 'w-1',
        operation: 'collection.collectAll',
        input: { collectors: ['fake_a', 'fake_b'] },
        timeout_ms: 30_000,
      } as never,
      send as never,
    );

    expect(extractWorkResponse(sent)).toEqual({ successes: 0, failures: 2 });
  });

  it('skips partial-result emit after dispatcher abort to avoid corrupting next work', async () => {
    registerCollectAll('/tmp/snapshots-unused');
    registerPluginOperation('collection.slow', z.unknown(), z.any(), async () => {
      await new Promise((r) => setTimeout(r, 80));
      return { value: 1 };
    });

    const sent: { type: string }[] = [];
    const send = async (msg: { type: string }) => {
      sent.push(msg);
    };

    await dispatch(
      {
        type: 'work.request',
        work_id: 'w-late',
        operation: 'collection.collectAll',
        input: { collectors: ['slow'] },
        timeout_ms: 20,
      } as never,
      send as never,
    ).catch(() => undefined);

    await new Promise((r) => setTimeout(r, 120));

    const collectionResults = sent.filter((m) => m.type === 'collection.result');
    expect(collectionResults).toHaveLength(0);
  });

  it('counts successful deliveries as successes when send resolves', async () => {
    registerCollectAll('/tmp/snapshots-unused');
    registerFakeCollector('fake_c');
    registerFakeCollector('fake_d');

    const sent: { type: string }[] = [];
    const send = async (msg: { type: string }) => {
      sent.push(msg);
    };

    await dispatch(
      {
        type: 'work.request',
        work_id: 'w-2',
        operation: 'collection.collectAll',
        input: { collectors: ['fake_c', 'fake_d'] },
        timeout_ms: 30_000,
      } as never,
      send as never,
    );

    expect(extractWorkResponse(sent)).toEqual({ successes: 2, failures: 0 });
  });
});

void replaceOperationForTests;
