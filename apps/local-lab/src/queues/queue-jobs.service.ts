import { Injectable } from '@nestjs/common';
import { QueueKeys, type Job } from 'bullmq';
import { z } from 'zod';

import { redactPayloadCapped, type RedactedPayload } from '../common/redact';
import {
  QueueJobAadSchema,
  QueueJobObservedStateSchema,
  type QueueJob,
  type QueueJobAad,
  type QueueJobDetail,
  type QueueJobObservedState,
  type QueueJobPage,
  type QueueJobState,
  type QueueRef,
} from '../contract';
import { QueueReaderService } from './queue-reader.service';
import { QueueRegistryService } from './queue-registry.service';
import {
  parseSagaJobId,
  QUEUE_LIST_STATES,
  QUEUE_SET_STATES,
  QUEUE_ZSET_STATES,
  queueKey,
  type ParsedSagaJobId,
} from './saga-topology';

export const JOB_PAGE_CAP = 200;

const ALL_STATES: readonly QueueJobState[] = [...QUEUE_LIST_STATES, ...QUEUE_ZSET_STATES];

// the queue's own keys share the namespace a job id is appended to, so ":meta" would read back as a
// fabricated job. Derived from bullmq's key map plus the lab's state vocabulary so it cannot drift.
const RESERVED_JOB_IDS: ReadonlySet<string> = new Set([
  ...Object.keys(new QueueKeys().getKeys('')),
  ...QUEUE_LIST_STATES,
  ...QUEUE_ZSET_STATES,
  ...QUEUE_SET_STATES,
]);

// bullmq exports no list of these. ":processed" and ":failed" are hashes, so they fabricate a job
// exactly as ":meta" does; the rest are lists/sets/strings and only turn a 404 into a WRONGTYPE 500.
const JOB_SIDE_KEY_NAMES: ReadonlySet<string> = new Set([
  'logs',
  'dependencies',
  'processed',
  'unsuccessful',
  'failed',
  'lock',
]);

// colons are legitimate: a repeatable job id is "repeat:<schedulerId>:<millis>", and only its ends can
// collide — with a queue key, a side key, or the scheduler's own hash at "repeat:<schedulerId>".
export function addressesOneJob(jobId: string): boolean {
  if (jobId.length === 0) return false;
  const segments = jobId.split(':');
  const last = segments[segments.length - 1] ?? '';
  if (RESERVED_JOB_IDS.has(last) || JOB_SIDE_KEY_NAMES.has(last)) return false;
  return !RESERVED_JOB_IDS.has(segments[0] ?? '') || /^\d+$/.test(last);
}

// results-inbox jobs are enqueued with no explicit id, so bullmq numbers them and only the payload —
// ciphertext for an enrolled zone — names a device. No key pattern can filter that family by device.
function supportsDeviceFilter(ref: QueueRef): boolean {
  return ref.kind !== 'results';
}

const JobDataSchema = z.record(z.string(), z.unknown());

const AadSchema = z.record(z.string(), z.unknown());

const ZoneFieldsSchema = z
  .object({
    zone_prefix: z.string().optional().catch(undefined),
    zone_id: z.string().optional().catch(undefined),
  })
  .passthrough();

export interface ListQueueJobsOptions {
  states: QueueJobState[];
  limit: number;
  offset: number;
  deviceId: string | null;
}

interface JobEnvelope {
  data: Record<string, unknown> | null;
  sealed: boolean;
  aad: Record<string, unknown> | null;
}

interface FoundJobs {
  jobs: QueueJob[];
  truncated: boolean;
  discoveryCapped: boolean;
}

function readEnvelope(raw: unknown): JobEnvelope {
  const parsed = JobDataSchema.safeParse(raw);
  if (!parsed.success) return { data: null, sealed: false, aad: null };
  const data = parsed.data;
  if (!('envelope_v' in data)) return { data, sealed: false, aad: null };
  return { data, sealed: true, aad: AadSchema.safeParse(data.aad).data ?? null };
}

// deliberately stricter than the attribution read below: exposure whitelists the six frozen fields, so a partial
// or padded header yields null rather than forwarding whatever the envelope carried.
function aadOf(envelope: JobEnvelope): QueueJobAad | null {
  if (!envelope.sealed || !envelope.aad) return null;
  return QueueJobAadSchema.safeParse(envelope.aad).data ?? null;
}

// a sealed envelope's only readable part is its aad header, which the detail renders in its own
// section — projecting the envelope fields as the payload would double-render it
function payloadOf(envelope: JobEnvelope): RedactedPayload {
  if (envelope.sealed || !envelope.data) return { value: null, truncated: false };
  return redactPayloadCapped(envelope.data);
}

// a saga queue's prefix IS the zone, and it is the only source for a plaintext hub→bridge job: SagaJobData
// carries no zone field, so an unenrolled zone would otherwise read as null on every saga job.
function zoneIdOf(envelope: JobEnvelope, ref: QueueRef): string | null {
  const fallback = ref.kind === 'saga' ? ref.prefix : null;
  const source = envelope.sealed ? envelope.aad : envelope.data;
  if (!source) return fallback;
  const parsed = ZoneFieldsSchema.safeParse(source);
  if (!parsed.success) return fallback;
  return parsed.data.zone_prefix ?? parsed.data.zone_id ?? fallback;
}

// bullmq's per-job lookup says 'waiting' where every count and key in the lab says 'wait'.
function observedState(state: string): QueueJobObservedState {
  const parsed = QueueJobObservedStateSchema.safeParse(state === 'waiting' ? 'wait' : state);
  return parsed.success ? parsed.data : 'unknown';
}

// enrich_via_pxe and network_scan enqueue with the zone id in the device slot, and a saga queue's own
// prefix is that zone uuid — so an id whose leading uuid is the prefix provably names no device.
function deviceIdOf(parsedId: ParsedSagaJobId | null, ref: QueueRef): string | null {
  const deviceId = parsedId?.deviceId ?? null;
  return deviceId === ref.prefix ? null : deviceId;
}

function summarize(job: Job, state: QueueJobObservedState, ref: QueueRef): QueueJob {
  const id = job.id ?? '';
  const parsedId = id ? parseSagaJobId(id) : null;
  const envelope = readEnvelope(job.data);
  return {
    id,
    name: job.name,
    state,
    attemptsMade: job.attemptsMade ?? 0,
    timestamp: job.timestamp ?? null,
    processedOn: job.processedOn ?? null,
    finishedOn: job.finishedOn ?? null,
    delay: job.delay ?? 0,
    failedReason: job.failedReason ? job.failedReason : null,
    deviceId: deviceIdOf(parsedId, ref),
    sagaName: parsedId?.sagaName ?? null,
    planId: parsedId?.planId ?? null,
    sealed: envelope.sealed,
    zoneId: zoneIdOf(envelope, ref),
  };
}

@Injectable()
export class QueueJobsService {
  constructor(
    private readonly registry: QueueRegistryService,
    private readonly reader: QueueReaderService,
  ) {}

  async list(prefix: string, name: string, options: ListQueueJobsOptions): Promise<QueueJobPage | null> {
    const ref = await this.registry.resolve(prefix, name);
    if (!ref) return null;

    const states = options.states.length > 0 ? options.states : [...ALL_STATES];
    const found = options.deviceId
      ? await this.byDevice(ref, options.deviceId, options.states.length > 0 ? new Set(options.states) : null, options)
      : await this.byState(ref, states, options);
    if (!found) return null;

    return {
      queue: ref,
      states,
      limit: options.limit,
      offset: options.offset,
      deviceId: options.deviceId,
      deviceFilterSupported: supportsDeviceFilter(ref),
      cap: JOB_PAGE_CAP,
      jobs: found.jobs,
      truncated: found.truncated,
      discoveryCapped: found.discoveryCapped,
    };
  }

  async get(prefix: string, name: string, jobId: string): Promise<QueueJobDetail | null> {
    if (!addressesOneJob(jobId)) return null;

    const ref = await this.registry.resolve(prefix, name);
    if (!ref) return null;

    return this.reader.withQueue(ref, async (queue) => {
      const job = await queue.getJob(jobId);
      if (!job) return null;
      const envelope = readEnvelope(job.data);
      const payload = payloadOf(envelope);
      return {
        ...summarize(job, observedState(await job.getState()), ref),
        aad: aadOf(envelope),
        payload: payload.value,
        payloadTruncated: payload.truncated,
        stacktrace: job.stacktrace ?? [],
      };
    });
  }

  // one index read per requested state, so each job's state is known without a per-job state lookup.
  private async byState(
    ref: QueueRef,
    states: QueueJobState[],
    options: ListQueueJobsOptions,
  ): Promise<FoundJobs | null> {
    return this.reader.withQueue(ref, async (queue) => {
      const jobs: QueueJob[] = [];
      const seen = new Set<string>();
      let truncated = false;

      for (const state of states) {
        const room = Math.min(options.limit, JOB_PAGE_CAP - jobs.length);
        if (room <= 0) {
          truncated = true;
          break;
        }
        const page = await queue.getJobs([state], options.offset, options.offset + room - 1);
        if (page.length >= room) truncated = true;
        for (const job of page) {
          const id = job?.id;
          if (!id || seen.has(id)) continue;
          seen.add(id);
          jobs.push(summarize(job, state, ref));
        }
      }
      return { jobs, truncated, discoveryCapped: false };
    });
  }

  // discovery by job-id SCAN, not by filtering a window: "no jobs for this device" must mean exactly that.
  private async byDevice(
    ref: QueueRef,
    deviceId: string,
    filter: Set<QueueJobState> | null,
    options: ListQueueJobsOptions,
  ): Promise<FoundJobs | null> {
    if (!supportsDeviceFilter(ref)) return { jobs: [], truncated: false, discoveryCapped: false };

    const keyPrefix = queueKey(ref.prefix, ref.name, '');
    // matched anywhere in the id, not just leading it: a device-status-effects id reads "device-<uuid>-…".
    const scanned = await this.reader.scanKeys(`${keyPrefix}*${deviceId}*`, JOB_PAGE_CAP);
    // the scan matches a job's own hash and its side keys alike, so the same guard the detail read uses
    const ids = scanned.keys.map((key) => key.slice(keyPrefix.length)).filter(addressesOneJob);

    return this.reader.withQueue(ref, async (queue) => {
      const jobs: QueueJob[] = [];
      for (const id of ids) {
        // a substring hit only proves the uuid is somewhere in the id, so drop one the id attributes
        // elsewhere — to another device, or to the zone rather than to any device.
        const owner = parseSagaJobId(id)?.deviceId ?? null;
        if (owner !== null && (owner !== deviceId || owner === ref.prefix)) continue;
        const job = await queue.getJob(id);
        if (!job) continue;
        const state = observedState(await job.getState());
        if (filter && (state === 'unknown' || !filter.has(state))) continue;
        jobs.push(summarize(job, state, ref));
      }
      jobs.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
      const page = jobs.slice(options.offset, options.offset + options.limit);
      return {
        jobs: page,
        truncated: scanned.truncated || jobs.length > options.offset + options.limit,
        // the scan restarts from the first key every request, so ids past the cap are unreachable at any offset
        discoveryCapped: scanned.truncated,
      };
    });
  }
}
