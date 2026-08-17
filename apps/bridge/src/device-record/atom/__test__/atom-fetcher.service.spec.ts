
import { describe, expect, it, vi, type Mock } from 'vitest';
import { z } from 'zod';

import {
  getAtom,
  readAtom,
  type AtomCache,
  type AtomFetcherLogger,
  type EnqueueRenderRequest,
  type EnqueueRenderRequestParams,
} from '../atom-fetcher';

const ATOM_KEY = 'netplan:device:42:config:live';
const REQUEST_ID = '550e8400-e29b-41d4-a716-446655440000';
const STALE_TS = 1_730_000_000_000;
const FRESH_TS = 1_730_000_001_000;
const BRIDGE_ID = 'bridge-1';
const DOMAIN = 'netplan';
const ENTITY_ID = '42';

const valueSchema = z.object({ yaml: z.string() }).strict();
const VALUE = { yaml: 'netplan: blob' };

function okEnvelope(value: unknown, writtenAt: number = STALE_TS): string {
  return JSON.stringify({
    status: 'ok',
    value,
    written_at: writtenAt,
    request_id: REQUEST_ID,
  });
}

function failedEnvelope(reason: string = 'render error', writtenAt: number = STALE_TS): string {
  return JSON.stringify({
    status: 'failed',
    reason,
    written_at: writtenAt,
    request_id: REQUEST_ID,
  });
}

interface MockCacheOptions {
  initial?: string | null;
  eventual?: Array<string | null>;
}

interface MockCache {
  cache: AtomCache;
  get: Mock<(...args: any[]) => any>;
  delete: Mock<(...args: any[]) => any>;
}

function makeCache({ initial = null, eventual = [] }: MockCacheOptions = {}): MockCache {
  const results: Array<string | null> = [initial, ...eventual];
  const get = vi.fn(async (_key: string, _jobId?: string) => {
    if (results.length > 0) return results.shift() ?? null;
    return null;
  });
  const del = vi.fn(async (_key: string, _jobId?: string) => 1);
  return {
    cache: { get, delete: del },
    get,
    delete: del,
  };
}

function makeLogger(): {
  logger: AtomFetcherLogger;
  debug: Mock<(...args: any[]) => any>;
  warn: Mock<(...args: any[]) => any>;
} {
  const debug = vi.fn();
  const warn = vi.fn();
  return { logger: { debug, warn }, debug, warn };
}

function getAtomDefaults<T>(overrides: {
  cache: AtomCache;
  enqueueRenderRequest: EnqueueRenderRequest;
  valueSchema: z.ZodType<T, z.ZodTypeDef, unknown>;
  logger?: AtomFetcherLogger;
  params?: Readonly<Record<string, unknown>> | null;
  reason?: 'missing' | 'stale' | 'explicit';
  pollIntervalS?: number;
  timeoutS?: number;
}) {
  return {
    bridgeId: BRIDGE_ID,
    domain: DOMAIN,
    entityId: ENTITY_ID,
    atomKey: ATOM_KEY,
    pollIntervalS: overrides.pollIntervalS ?? 0,
    ...overrides,
  };
}

describe('readAtom', () => {
  it('happy path returns typed value', async () => {
    const { cache, get } = makeCache({ initial: okEnvelope({ yaml: 'netplan: blob' }) });
    const result = await readAtom(cache, ATOM_KEY, valueSchema);
    expect(result).toEqual(VALUE);
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith(ATOM_KEY, '');
  });

  it('returns null on absent key', async () => {
    const { cache } = makeCache({ initial: null });
    const result = await readAtom(cache, ATOM_KEY, valueSchema);
    expect(result).toBeNull();
  });

  it('returns null on failed status (logs debug)', async () => {
    const { cache } = makeCache({ initial: failedEnvelope('device not found') });
    const { logger, debug } = makeLogger();
    const result = await readAtom(cache, ATOM_KEY, valueSchema, { logger });
    expect(result).toBeNull();
    expect(debug).toHaveBeenCalled();
  });

  it('returns null on malformed JSON (logs warn)', async () => {
    const { cache } = makeCache({ initial: 'not-json{' });
    const { logger, warn } = makeLogger();
    const result = await readAtom(cache, ATOM_KEY, valueSchema, { logger });
    expect(result).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('returns null on envelope schema mismatch (logs warn)', async () => {
    const { cache } = makeCache({ initial: JSON.stringify({ status: 'ok' }) });
    const { logger, warn } = makeLogger();
    const result = await readAtom(cache, ATOM_KEY, valueSchema, { logger });
    expect(result).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('returns null on value model mismatch (logs warn)', async () => {
    const { cache } = makeCache({ initial: okEnvelope({ wrong_field: 'x' }) });
    const { logger, warn } = makeLogger();
    const result = await readAtom(cache, ATOM_KEY, valueSchema, { logger });
    expect(result).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('getAtom', () => {
  it('returns immediately when atom is present', async () => {
    const { cache, get } = makeCache({ initial: okEnvelope({ yaml: 'netplan: blob' }) });
    const enqueueRenderRequest = vi.fn(async (_p: EnqueueRenderRequestParams) => true);

    const result = await getAtom(getAtomDefaults({ cache, enqueueRenderRequest, valueSchema }));

    expect(result).toEqual(VALUE);
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith(ATOM_KEY, '');
    expect(enqueueRenderRequest).not.toHaveBeenCalled();
  });

  it('returns null on negative-cache hit', async () => {
    const { cache } = makeCache({ initial: failedEnvelope('entity not found') });
    const enqueueRenderRequest = vi.fn(async (_p: EnqueueRenderRequestParams) => true);

    const result = await getAtom(getAtomDefaults({ cache, enqueueRenderRequest, valueSchema }));

    expect(result).toBeNull();
    expect(enqueueRenderRequest).not.toHaveBeenCalled();
  });

  it('enqueues render request on miss and returns polled value', async () => {
    const { cache } = makeCache({
      initial: null,
      eventual: [okEnvelope({ yaml: 'netplan: blob' })],
    });
    const enqueueRenderRequest = vi.fn(async (_p: EnqueueRenderRequestParams) => true);

    const result = await getAtom(
      getAtomDefaults({
        cache,
        enqueueRenderRequest,
        valueSchema,
        params: { phase: 'live' },
      }),
    );

    expect(result).toEqual(VALUE);
    expect(enqueueRenderRequest).toHaveBeenCalledTimes(1);
    const call = enqueueRenderRequest.mock.calls[0][0] as EnqueueRenderRequestParams;
    expect(call.domain).toBe(DOMAIN);
    expect(call.entityId).toBe(ENTITY_ID);
    expect(call.params).toEqual({ phase: 'live' });
    expect(call.requestId).toBeDefined();
    expect(call.bridgeId).toBe(BRIDGE_ID);
  });

  it('returns null when render request enqueue fails', async () => {
    const { cache, get } = makeCache({ initial: null });
    const enqueueRenderRequest = vi.fn(async (_p: EnqueueRenderRequestParams) => false);

    const result = await getAtom(getAtomDefaults({ cache, enqueueRenderRequest, valueSchema }));

    expect(result).toBeNull();
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('returns null on timeout when atom never appears', async () => {
    const get = vi.fn(async () => null);
    const cache: AtomCache = { get, delete: vi.fn(async () => 1) };
    const enqueueRenderRequest = vi.fn(async (_p: EnqueueRenderRequestParams) => true);

    const result = await getAtom(
      getAtomDefaults({
        cache,
        enqueueRenderRequest,
        valueSchema,
        timeoutS: 0,
      }),
    );

    expect(result).toBeNull();
    expect(enqueueRenderRequest).toHaveBeenCalledTimes(1);
  });

  it('polling terminates on failed envelope', async () => {
    const { cache } = makeCache({
      initial: null,
      eventual: [failedEnvelope('not renderable')],
    });
    const enqueueRenderRequest = vi.fn(async (_p: EnqueueRenderRequestParams) => true);

    const result = await getAtom(getAtomDefaults({ cache, enqueueRenderRequest, valueSchema }));

    expect(result).toBeNull();
    expect(enqueueRenderRequest).toHaveBeenCalledTimes(1);
  });

  it('passes reason through to enqueue', async () => {
    const { cache } = makeCache({
      initial: null,
      eventual: [okEnvelope({ yaml: 'netplan: blob' })],
    });
    const enqueueRenderRequest = vi.fn(async (_p: EnqueueRenderRequestParams) => true);

    await getAtom(
      getAtomDefaults({
        cache,
        enqueueRenderRequest,
        valueSchema,
        reason: 'explicit',
      }),
    );

    const call = enqueueRenderRequest.mock.calls[0][0] as EnqueueRenderRequestParams;
    expect(call.reason).toBe('explicit');
  });

  it('concurrent calls for the same key enqueue only once', async () => {
    let callCount = 0;
    const ok = okEnvelope({ yaml: 'netplan: blob' });

    const get = vi.fn(async () => {
      callCount += 1;
      if (callCount <= 2) return null;
      return ok;
    });
    const cache: AtomCache = { get, delete: vi.fn(async () => 1) };
    const enqueueRenderRequest = vi.fn(async (_p: EnqueueRenderRequestParams) => true);

    const [a, b] = await Promise.all([
      getAtom(getAtomDefaults({ cache, enqueueRenderRequest, valueSchema })),
      getAtom(getAtomDefaults({ cache, enqueueRenderRequest, valueSchema })),
    ]);

    expect(a).toEqual(VALUE);
    expect(b).toEqual(VALUE);
    expect(enqueueRenderRequest).toHaveBeenCalledTimes(1);
  });

  it('piggybacker after a failed envelope skips stale and retries to fresh', async () => {
    const freshOk = okEnvelope({ yaml: 'netplan: blob' }, FRESH_TS);
    const staleFailed = failedEnvelope('transient render error', STALE_TS);

    let releaseOwnerEnqueue: () => void = () => undefined;
    const ownerEnqueueGate = new Promise<void>((resolve) => {
      releaseOwnerEnqueue = resolve;
    });

    let ownerInFetchResolve: () => void = () => undefined;
    const ownerInFetch = new Promise<void>((resolve) => {
      ownerInFetchResolve = resolve;
    });

    let enqueueCall = 0;
    const enqueueRenderRequest: EnqueueRenderRequest = vi.fn(async () => {
      enqueueCall += 1;
      if (enqueueCall === 1) {
        ownerInFetchResolve();
        await ownerEnqueueGate;
      }
      return true;
    });

    const results: Array<string | null> = [null, null, staleFailed, staleFailed, staleFailed, staleFailed, freshOk];
    const get = vi.fn(async () => (results.length > 0 ? results.shift()! : null));
    const del = vi.fn(async () => 1);
    const cache: AtomCache = { get, delete: del };

    const ownerPromise = getAtom(getAtomDefaults({ cache, enqueueRenderRequest, valueSchema }));
    await ownerInFetch;

    const piggyPromise = getAtom(getAtomDefaults({ cache, enqueueRenderRequest, valueSchema }));
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    releaseOwnerEnqueue();

    const [ownerResult, piggyResult] = await Promise.all([ownerPromise, piggyPromise]);

    expect(ownerResult).toBeNull();
    expect(piggyResult).toEqual(VALUE);
    expect(del).not.toHaveBeenCalled();
  });

  it('concurrent piggyback fallthrough: one wins, one surrenders', async () => {
    const failed = failedEnvelope('transient', STALE_TS);
    const ok = okEnvelope({ yaml: 'netplan: blob' }, FRESH_TS);

    let releaseOwnerEnqueue: () => void = () => undefined;
    const ownerEnqueueGate = new Promise<void>((resolve) => {
      releaseOwnerEnqueue = resolve;
    });
    let releaseWinnerEnqueue: () => void = () => undefined;
    const winnerEnqueueGate = new Promise<void>((resolve) => {
      releaseWinnerEnqueue = resolve;
    });

    let ownerInFetchResolve: () => void = () => undefined;
    const ownerInFetch = new Promise<void>((resolve) => {
      ownerInFetchResolve = resolve;
    });

    let enqueueCall = 0;
    const enqueueRenderRequest: EnqueueRenderRequest = vi.fn(async () => {
      enqueueCall += 1;
      if (enqueueCall === 1) {
        ownerInFetchResolve();
        await ownerEnqueueGate;
      } else if (enqueueCall === 2) {
        await winnerEnqueueGate;
      }
      return true;
    });

    let piggiesAreWaiting = false;
    let loserSurrendered = false;

    const get = vi.fn(async () => {
      if (!piggiesAreWaiting) return null;
      if (loserSurrendered) return ok;
      return failed;
    });
    const cache: AtomCache = { get, delete: vi.fn(async () => 1) };

    const debug = vi.fn((message: string) => {
      if (message.includes('Concurrent piggyback retry')) {
        loserSurrendered = true;
        releaseWinnerEnqueue();
      }
    });
    const logger: AtomFetcherLogger = { debug, warn: vi.fn() };

    const ownerPromise = getAtom(getAtomDefaults({ cache, enqueueRenderRequest, valueSchema, logger }));
    await ownerInFetch;

    const piggyA = getAtom(getAtomDefaults({ cache, enqueueRenderRequest, valueSchema, logger }));
    const piggyB = getAtom(getAtomDefaults({ cache, enqueueRenderRequest, valueSchema, logger }));
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    piggiesAreWaiting = true;
    releaseOwnerEnqueue();

    const [ownerResult, aResult, bResult] = await Promise.all([ownerPromise, piggyA, piggyB]);

    expect(ownerResult).toBeNull();
    const piggyResults = [aResult, bResult];
    expect(piggyResults).toContainEqual(VALUE);
    expect(piggyResults).toContain(null);
  });

  it('owner finish releases inflight slot for a subsequent caller', async () => {
    const ok = okEnvelope({ yaml: 'netplan: blob' }, FRESH_TS);
    const { cache, get } = makeCache({
      initial: null,
      eventual: [ok],
    });
    const enqueueRenderRequest = vi.fn(async (_p: EnqueueRenderRequestParams) => true);

    const ownerResult = await getAtom(
      getAtomDefaults({
        cache,
        enqueueRenderRequest,
        valueSchema,
        timeoutS: 0,
      }),
    );
    expect(ownerResult).toBeNull();

    const freshResult = await getAtom(getAtomDefaults({ cache, enqueueRenderRequest, valueSchema }));
    expect(freshResult).toEqual(VALUE);
    expect(enqueueRenderRequest).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalled();
  });
});
