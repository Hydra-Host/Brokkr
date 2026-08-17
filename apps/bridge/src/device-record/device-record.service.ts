import { randomUUID } from 'node:crypto';

import { Inject, Injectable, Optional } from '@nestjs/common';

import { deviceLookup, deviceRecord } from '../common/redis/redis-keys';
import { getLeaderConfig } from '../leader-election/leader-election.config';
import { getLogger } from '../logger/logger.service';

import type { AtomCache, EnqueueRenderRequest } from './atom/atom-fetcher';
import { getAtom, readAtom } from './atom/atom-fetcher';
import { deviceRecordSchema, type DeviceRecord } from './device-record.schema';
import { IDENTIFIER_KINDS, isHardwarePlaceholder, type IdentifierKind } from './identifier-kinds';

export const DEFAULT_RESOLVE_TIMEOUT_S = 30;
export const DEFAULT_POLL_INTERVAL_S = 1.0;

export enum ResolveOutcome {
  UNKNOWN = 'UNKNOWN',
  KNOWN_RECORD_MISSING = 'KNOWN_RECORD_MISSING',
}

export type ResolveResult = DeviceRecord | ResolveOutcome;

export function isResolveOutcome(result: ResolveResult): result is ResolveOutcome {
  return result === ResolveOutcome.UNKNOWN || result === ResolveOutcome.KNOWN_RECORD_MISSING;
}

const MAC_KINDS: ReadonlySet<string> = new Set<IdentifierKind>(['mac', 'ipmi_mac']);

export interface DeviceRecordLogger {
  debug(message: string, jobId?: string): void;
  info(message: string, jobId?: string): void;
  warn(message: string, jobId?: string): void;
}

const FORWARDING_LOGGER: DeviceRecordLogger = {
  debug: (msg, jobId) => void getLogger().debug(msg, { jobId }),
  info: (msg, jobId) => void getLogger().info(msg, { jobId }),
  warn: (msg, jobId) => void getLogger().warning(msg, { jobId }),
};

export const DEVICE_RECORD_CACHE = Symbol('DeviceRecordCache');
export const DEVICE_RECORD_RENDER_ENQUEUER = Symbol('DeviceRecordRenderEnqueuer');
export const DEVICE_RECORD_LOGGER = Symbol('DeviceRecordLogger');

export interface ResolveDeviceOptions {
  buildarch?: string | null;
  jobId?: string;
  timeoutS?: number;
  pollIntervalS?: number;
  renderFacts?: Record<string, string> | null;
}

function nowMs(): number {
  return performance.now();
}

function remainingBudgetS(deadlineMs: number): number {
  return Math.max(0, Math.floor((deadlineMs - nowMs()) / 1000));
}

function normalizeMacForLookup(value: string): string {
  return value.replaceAll(':', '-').toLowerCase();
}

function lookupKey(kind: IdentifierKind, value: string): string {
  const normalized = MAC_KINDS.has(kind) ? normalizeMacForLookup(value) : value.toLowerCase();
  return deviceLookup(kind, normalized);
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

@Injectable()
export class DeviceRecordService {
  constructor(
    @Inject(DEVICE_RECORD_CACHE) private readonly cache: AtomCache,
    @Inject(DEVICE_RECORD_RENDER_ENQUEUER)
    private readonly enqueueRenderRequest: EnqueueRenderRequest,
    @Optional() @Inject(DEVICE_RECORD_LOGGER) logger?: DeviceRecordLogger,
  ) {
    this.logger = logger ?? FORWARDING_LOGGER;
  }

  private readonly logger: DeviceRecordLogger;

  async resolveDevice(
    identifiers: Readonly<Record<string, string>>,
    options: ResolveDeviceOptions = {},
  ): Promise<ResolveResult> {
    const {
      buildarch = null,
      jobId = '',
      timeoutS = DEFAULT_RESOLVE_TIMEOUT_S,
      pollIntervalS = DEFAULT_POLL_INTERVAL_S,
      renderFacts = null,
    } = options;

    // Fillers are dropped here too (not only in ChainService) so no resolveDevice caller can false-hit or mint colliding device:lookup keys via render-on-miss.
    const usable: Record<IdentifierKind, string> = {} as Record<IdentifierKind, string>;
    for (const kind of IDENTIFIER_KINDS) {
      const value = identifiers[kind];
      if (value && !isHardwarePlaceholder(value)) usable[kind] = value;
    }
    if (Object.keys(usable).length === 0) {
      this.logger.warn('resolve_device called with no usable identifiers', jobId);
      return ResolveOutcome.UNKNOWN;
    }

    const deadline = nowMs() + timeoutS * 1000;

    let deviceId = await this.resolveViaPointers(usable, jobId);
    if (deviceId !== null) {
      this.logger.info(`Resolved device ${deviceId} via pointer lookup`, jobId);
      return this.fetchRecordOrKnownMissing(deviceId, jobId, remainingBudgetS(deadline));
    }

    const sent = await this.requestRenderForIdentifiers(usable, buildarch, renderFacts);
    if (!sent) return ResolveOutcome.UNKNOWN;

    this.logger.debug(`Awaiting hub-side identifier resolution (kinds=[${Object.keys(usable).join(', ')}])`, jobId);

    while (nowMs() < deadline) {
      await sleepMs(pollIntervalS * 1000);
      deviceId = await this.resolveViaPointers(usable, jobId);
      if (deviceId !== null) {
        this.logger.info(`Resolved device ${deviceId} via hub render-on-miss`, jobId);
        return this.fetchRecordOrKnownMissing(deviceId, jobId, remainingBudgetS(deadline));
      }
    }

    this.logger.warn(
      `resolve_device timed out after ${timeoutS}s waiting for hub render (kinds=[${Object.keys(usable).join(', ')}])`,
      jobId,
    );
    return ResolveOutcome.UNKNOWN;
  }

  // Unlike resolveDevice, never enqueues a render-request or polls — fire-and-forget callers must not pollute discovery:pending.
  async resolveByPointerOnly(identifiers: Readonly<Record<string, string>>, jobId: string): Promise<ResolveResult> {
    const usable: Record<IdentifierKind, string> = {} as Record<IdentifierKind, string>;
    for (const kind of IDENTIFIER_KINDS) {
      const value = identifiers[kind];
      if (value) usable[kind] = value;
    }
    if (Object.keys(usable).length === 0) return ResolveOutcome.UNKNOWN;

    const deviceId = await this.resolveViaPointers(usable, jobId);
    if (deviceId === null) return ResolveOutcome.UNKNOWN;

    const record = await readAtom(this.cache, deviceRecord(deviceId), deviceRecordSchema, { jobId });
    return record ?? ResolveOutcome.KNOWN_RECORD_MISSING;
  }

  private async resolveViaPointers(
    identifiers: Readonly<Record<string, string>>,
    jobId: string,
  ): Promise<string | null> {
    for (const kind of IDENTIFIER_KINDS) {
      const value = identifiers[kind];
      if (!value) continue;
      const key = lookupKey(kind, value);
      const raw = await this.cache.get(key, jobId);
      if (raw === null) continue;
      const deviceId = raw.trim();
      if (deviceId) return deviceId;
      this.logger.warn(`device_record pointer ${key} resolved to empty value ${JSON.stringify(raw)}; ignoring`, jobId);
    }
    return null;
  }

  private async requestRenderForIdentifiers(
    identifiers: Readonly<Record<string, string>>,
    buildarch: string | null,
    renderFacts: Record<string, string> | null,
  ): Promise<boolean> {
    const bundle: Record<string, string> = { ...identifiers };
    for (const [key, value] of Object.entries(renderFacts ?? {})) {
      if (value) bundle[key] = value;
    }
    const params: Record<string, unknown> = { identifiers: bundle };
    if (buildarch) params['buildarch'] = buildarch;
    return this.enqueueRenderRequest({
      requestId: randomUUID(),
      domain: 'device_record',
      params,
      bridgeId: getLeaderConfig().instanceId,
      reason: 'missing',
    });
  }

  private async fetchRecordOrKnownMissing(deviceId: string, jobId: string, timeoutS: number): Promise<ResolveResult> {
    const record = await getAtom({
      cache: this.cache,
      enqueueRenderRequest: this.enqueueRenderRequest,
      bridgeId: getLeaderConfig().instanceId,
      domain: 'device_record',
      entityId: deviceId,
      atomKey: deviceRecord(deviceId),
      valueSchema: deviceRecordSchema,
      timeoutS,
      jobId,
    });
    if (record !== null) return record;
    this.logger.warn(
      `device ${deviceId} resolved via pointer but record atom is missing; treating as known-but-record-missing (no discovery re-registration)`,
      jobId,
    );
    return ResolveOutcome.KNOWN_RECORD_MISSING;
  }
}
