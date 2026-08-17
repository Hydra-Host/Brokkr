// Piggyback wait + owner-retry must together fit the caller's `timeoutS` budget; NEGATIVE_CACHE_TTL_S must match the hub's TTL_NEGATIVE_CACHE_SECONDS.

import { randomUUID } from 'node:crypto';

import { isRecord } from '@repo/utils';
import type { z } from 'zod';

import { getLogger } from '../../logger/logger.service';

import { atomEnvelopeFailedSchema, atomEnvelopeOkSchema } from './atom-envelope';
import type { RenderReason } from './render-request.schema';

export const DEFAULT_TIMEOUT_S = 300;
export const DEFAULT_POLL_INTERVAL_S = 1.0;
export const NEGATIVE_CACHE_TTL_S = 60;

export interface AtomCache {
  get(key: string, jobId?: string): Promise<string | null>;
  delete(key: string, jobId?: string): Promise<number>;
}

export interface AtomFetcherLogger {
  debug(message: string, jobId?: string): void;
  warn(message: string, jobId?: string): void;
}

export const FORWARDING_LOGGER: AtomFetcherLogger = {
  debug: (msg, jobId) => void getLogger().debug(msg, { jobId }),
  warn: (msg, jobId) => void getLogger().warning(msg, { jobId }),
};

export interface EnqueueRenderRequestParams {
  requestId: string;
  domain: string;
  entityId?: string | null;
  params?: Readonly<Record<string, unknown>> | null;
  bridgeId: string;
  reason?: RenderReason | null;
}

export type EnqueueRenderRequest = (params: EnqueueRenderRequestParams) => Promise<boolean>;

interface InflightSlot {
  settled: Promise<void>;
  release: () => void;
}

const inflight = new Map<string, InflightSlot>();

function claimSlot(atomKey: string): { slot: InflightSlot; isOwner: boolean } {
  const existing = inflight.get(atomKey);
  if (existing !== undefined) {
    return { slot: existing, isOwner: false };
  }
  let release: () => void = () => undefined;
  const settled = new Promise<void>((resolve) => {
    release = resolve;
  });
  const slot: InflightSlot = { settled, release };
  inflight.set(atomKey, slot);
  return { slot, isOwner: true };
}

function releaseSlot(atomKey: string, slot: InflightSlot): void {
  slot.release();
  if (inflight.get(atomKey) === slot) {
    inflight.delete(atomKey);
  }
}

function nowMs(): number {
  return performance.now();
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitWithTimeoutMs(promise: Promise<void>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), Math.max(0, ms));
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function parseJson(raw: string): unknown {
  return JSON.parse(raw);
}

function isNegativeCache(raw: string): boolean {
  let parsed: unknown;
  try {
    parsed = parseJson(raw);
  } catch {
    return false;
  }
  return isRecord(parsed) && parsed['status'] === 'failed';
}

function keysRepr(parsed: unknown): string {
  if (isRecord(parsed)) return `[${Object.keys(parsed).join(', ')}]`;
  if (Array.isArray(parsed)) return 'list';
  if (parsed === null) return 'null';
  return typeof parsed;
}

function peekWrittenAt(raw: string): number | null {
  let parsed: unknown;
  try {
    parsed = parseJson(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const ts = parsed['written_at'];
  if (typeof ts === 'boolean') return ts ? 1 : 0;
  return typeof ts === 'number' && Number.isInteger(ts) ? ts : null;
}

function parseEnvelope<T>(
  raw: string,
  atomKey: string,
  valueSchema: z.ZodType<T, z.ZodTypeDef, unknown>,
  logger: AtomFetcherLogger,
  jobId: string,
): T | null {
  let parsed: unknown;
  try {
    parsed = parseJson(raw);
  } catch {
    logger.warn(`Malformed JSON in atom ${atomKey}: ${JSON.stringify(raw.slice(0, 80))}`, jobId);
    return null;
  }

  const status = isRecord(parsed) ? parsed['status'] : null;
  if (status === 'failed') {
    const failed = atomEnvelopeFailedSchema.safeParse(parsed);
    if (!failed.success) {
      logger.warn(
        `Atom ${atomKey} has status=failed but envelope is malformed: ${failed.error.message} (keys: ${keysRepr(parsed)})`,
        jobId,
      );
      return null;
    }
    logger.debug(`Atom ${atomKey} negative-cache hit: ${failed.data.reason}`, jobId);
    return null;
  }

  const envelope = atomEnvelopeOkSchema.safeParse(parsed);
  if (!envelope.success) {
    logger.warn(
      `Atom ${atomKey} envelope failed validation: ${envelope.error.message} (keys: ${keysRepr(parsed)})`,
      jobId,
    );
    return null;
  }

  const value = valueSchema.safeParse(envelope.data.value);
  if (!value.success) {
    logger.warn(`Atom ${atomKey} value failed validation: ${value.error.message} (keys: ${keysRepr(parsed)})`, jobId);
    return null;
  }
  return value.data;
}

export interface ReadAtomOptions {
  jobId?: string;
  logger?: AtomFetcherLogger;
}

export async function readAtom<T>(
  cache: AtomCache,
  key: string,
  valueSchema: z.ZodType<T, z.ZodTypeDef, unknown>,
  options: ReadAtomOptions = {},
): Promise<T | null> {
  const { jobId = '', logger = FORWARDING_LOGGER } = options;
  const raw = await cache.get(key, jobId);
  if (raw === null) return null;
  return parseEnvelope(raw, key, valueSchema, logger, jobId);
}

export interface GetAtomOptions<T> {
  cache: AtomCache;
  enqueueRenderRequest: EnqueueRenderRequest;
  bridgeId: string;
  domain: string;
  entityId: string;
  atomKey: string;
  valueSchema: z.ZodType<T, z.ZodTypeDef, unknown>;
  params?: Readonly<Record<string, unknown>> | null;
  timeoutS?: number;
  pollIntervalS?: number;
  reason?: RenderReason;
  jobId?: string;
  logger?: AtomFetcherLogger;
}

export async function getAtom<T>(options: GetAtomOptions<T>): Promise<T | null> {
  const {
    cache,
    enqueueRenderRequest,
    bridgeId,
    domain,
    entityId,
    atomKey,
    valueSchema,
    params = null,
    timeoutS = DEFAULT_TIMEOUT_S,
    pollIntervalS = DEFAULT_POLL_INTERVAL_S,
    reason = 'missing',
    jobId = '',
    logger = FORWARDING_LOGGER,
  } = options;

  const deadline = nowMs() + timeoutS * 1000;

  const raw = await cache.get(atomKey, jobId);
  if (raw !== null) {
    const parsed = parseEnvelope(raw, atomKey, valueSchema, logger, jobId);
    if (parsed !== null) return parsed;
    if (!isNegativeCache(raw)) {
      logger.warn(`Atom ${atomKey} present but malformed; deleting and triggering render`, jobId);
      await cache.delete(atomKey, jobId);
    } else {
      return null;
    }
  }

  let observedStaleTs: number | null = null;

  {
    const { slot, isOwner } = claimSlot(atomKey);
    if (isOwner) {
      try {
        return await fetchAtom({
          cache,
          enqueueRenderRequest,
          bridgeId,
          domain,
          entityId,
          atomKey,
          valueSchema,
          params,
          timeoutS,
          pollIntervalS,
          reason,
          jobId,
          logger,
        });
      } finally {
        releaseSlot(atomKey, slot);
      }
    }

    const remaining = Math.max(0, deadline - nowMs());
    const completed = await waitWithTimeoutMs(slot.settled, remaining);
    if (!completed) {
      logger.warn(`Piggyback wait for ${atomKey} timed out after ${timeoutS}s`, jobId);
      return null;
    }

    const cached = await readAtom(cache, atomKey, valueSchema, { jobId, logger });
    if (cached !== null) return cached;

    const rawStale = await cache.get(atomKey, jobId);
    if (rawStale !== null) {
      observedStaleTs = peekWrittenAt(rawStale);
    }
  }

  const retryTimeoutS = Math.floor(Math.max(0, deadline - nowMs()) / 1000);
  if (retryTimeoutS <= 0) {
    logger.warn(`Piggyback for ${atomKey} exhausted shared budget before retry`, jobId);
    return null;
  }

  const { slot, isOwner } = claimSlot(atomKey);
  if (!isOwner) {
    logger.debug(`Concurrent piggyback retry for ${atomKey}; returning None`, jobId);
    return null;
  }

  try {
    logger.debug(`Piggyback cache miss for ${atomKey}; retrying with own render request`, jobId);
    return await fetchAtom({
      cache,
      enqueueRenderRequest,
      bridgeId,
      domain,
      entityId,
      atomKey,
      valueSchema,
      params,
      timeoutS: retryTimeoutS,
      pollIntervalS,
      reason,
      jobId,
      logger,
      sinceMs: observedStaleTs,
    });
  } finally {
    releaseSlot(atomKey, slot);
  }
}

interface FetchAtomParams<T> {
  cache: AtomCache;
  enqueueRenderRequest: EnqueueRenderRequest;
  bridgeId: string;
  domain: string;
  entityId: string;
  atomKey: string;
  valueSchema: z.ZodType<T, z.ZodTypeDef, unknown>;
  params: Readonly<Record<string, unknown>> | null;
  timeoutS: number;
  pollIntervalS: number;
  reason: RenderReason;
  jobId: string;
  logger: AtomFetcherLogger;
  sinceMs?: number | null;
}

async function fetchAtom<T>(p: FetchAtomParams<T>): Promise<T | null> {
  const requestId = randomUUID();
  const deadline = nowMs() + p.timeoutS * 1000;

  const sent = await p.enqueueRenderRequest({
    requestId,
    domain: p.domain,
    entityId: p.entityId,
    params: p.params,
    bridgeId: p.bridgeId,
    reason: p.reason,
  });
  if (!sent) return null;

  p.logger.debug(
    `Awaiting hub render for ${p.atomKey} (domain=${p.domain} request=${requestId} timeout=${p.timeoutS}s)`,
    p.jobId,
  );

  while (nowMs() < deadline) {
    await sleepMs(p.pollIntervalS * 1000);
    const raw = await p.cache.get(p.atomKey, p.jobId);
    if (raw === null) continue;
    if (p.sinceMs !== undefined && p.sinceMs !== null) {
      const ts = peekWrittenAt(raw);
      if (ts !== null && ts <= p.sinceMs) continue;
    }
    return parseEnvelope(raw, p.atomKey, p.valueSchema, p.logger, p.jobId);
  }

  p.logger.warn(`Render request for ${p.atomKey} timed out after ${p.timeoutS}s (request=${requestId})`, p.jobId);
  return null;
}
