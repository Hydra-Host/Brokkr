import { LifecycleJobPhase as PrismaLifecycleJobPhase } from '@repo/database';
import { isAppRoute } from '@ts-rest/core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { contract } from './index';
import {
  DeviceTokenPageSchema,
  DeviceTokenRowSchema,
  LifecycleJobDetailSchema,
  LifecycleJobPageSchema,
  LifecycleJobPhaseSchema,
  LifecycleJobRowSchema,
  LifecycleQueueJoinSchema,
  WebhookDeliveryRowSchema,
} from './schemas/hub';

const HUB_ROUTES = [
  'listWebhookDeliveries',
  'listLifecycleJobs',
  'getLifecycleJob',
  'listDeviceTokens',
  'getDeviceTokenEvents',
] as const;

const PAGED_ROUTES = [
  'listWebhookDeliveries',
  'listLifecycleJobs',
  'listDeviceTokens',
  'getDeviceTokenEvents',
] as const;

function queryOf(name: (typeof PAGED_ROUTES)[number]) {
  const route = contract[name];
  if (!isAppRoute(route) || !(route.query instanceof z.ZodObject)) throw new Error(`${name} has no query schema`);
  return route.query;
}

const token = (over: Record<string, unknown> = {}) => ({
  id: 'tok-1',
  displayId: 'dtok_0123456789ab',
  deviceId: 'dev-1',
  deploymentId: null,
  context: 'BROKKR_LIVE',
  status: 'ACTIVE',
  rotationGeneration: 0,
  expiresAtMs: null,
  lastUsedAtMs: 1_700_000_000_000,
  lastUsedIp: '127.0.0.1',
  usedWithinThrottleWindow: true,
  revokedAtMs: null,
  revokedReason: null,
  issuedBy: null,
  createdAtMs: 1_700_000_000_000,
  ...over,
});

const delivery = (over: Record<string, unknown> = {}) => ({
  id: 'del-1',
  webhookId: 'wh-1',
  endpoint: 'https://example.test/hook',
  eventType: 'DEPLOYMENT_INTERRUPTED',
  status: 'FAILED',
  httpStatus: 500,
  attempts: 3,
  errorMessage: 'boom',
  idempotencyKey: null,
  nextRetryAtMs: null,
  createdAtMs: 1_700_000_000_000,
  deliveredAtMs: null,
  lockedBy: null,
  lockedAtMs: null,
  lockExpiresAtMs: null,
  payload: { ok: true },
  payloadTruncated: false,
  responseBody: null,
  responseBodyTruncated: false,
  ...over,
});

describe('hub routes', () => {
  it('are all GET, so the surface stays read-only', () => {
    for (const name of HUB_ROUTES) {
      const route = contract[name];
      if (!isAppRoute(route)) throw new Error(`${name} route missing`);
      expect(route.method, name).toBe('GET');
    }
  });

  it('caps every paged read, so no route can ask the database for an unbounded page', () => {
    for (const name of PAGED_ROUTES) {
      const query = queryOf(name);
      expect(query.safeParse({ limit: 200 }).success, name).toBe(true);
      expect(query.safeParse({ limit: 201 }).success, name).toBe(false);
      expect(query.safeParse({ limit: 0 }).success, name).toBe(false);
      expect(query.safeParse({ offset: -1 }).success, name).toBe(false);
    }
  });

  it('coerces the page numbers a url carries as strings, on every paged route', () => {
    for (const name of PAGED_ROUTES) {
      expect(queryOf(name).parse({ limit: '25', offset: '50' }), name).toMatchObject({ limit: 25, offset: 50 });
      expect(queryOf(name).safeParse({ limit: '25.5' }).success, name).toBe(false);
    }
  });

  it('pages by default rather than reading everything when the query is empty', () => {
    for (const name of PAGED_ROUTES) {
      expect(queryOf(name).parse({}), name).toMatchObject({ limit: 50, offset: 0 });
    }
  });
});

describe('hub schemas', () => {
  it('models no token hash field at all, so a reader cannot populate one', () => {
    expect(Object.keys(DeviceTokenRowSchema.shape)).not.toContain('tokenHash');
    expect(DeviceTokenRowSchema.parse({ ...token(), tokenHash: 'deadbeef' })).not.toHaveProperty('tokenHash');
  });

  it('models no webhook secret field at all', () => {
    expect(Object.keys(WebhookDeliveryRowSchema.shape)).not.toContain('secret');
    expect(WebhookDeliveryRowSchema.parse({ ...delivery(), secret: 'shh' })).not.toHaveProperty('secret');
  });

  it('keeps a never-used token distinct from one whose recency could not be read', () => {
    const never = DeviceTokenRowSchema.parse(token({ lastUsedAtMs: null, usedWithinThrottleWindow: false }));
    const unknown = DeviceTokenRowSchema.parse(token({ lastUsedAtMs: null, usedWithinThrottleWindow: null }));

    expect(never.usedWithinThrottleWindow).toBe(false);
    expect(unknown.usedWithinThrottleWindow).toBeNull();
    expect(never).not.toEqual(unknown);
  });

  it('requires the recency probe error to be stated, so an unread sentinel cannot look idle', () => {
    const { recencyReadError, ...withoutProbeError } = {
      rows: [],
      skipped: 0,
      readError: null,
      recencyReadError: null,
    };
    expect(recencyReadError).toBeNull();
    expect(DeviceTokenPageSchema.safeParse(withoutProbeError).success).toBe(false);
  });

  it('rejects a phase outside the engine vocabulary', () => {
    expect(LifecycleJobPhaseSchema.safeParse('AWAITING_PHONE_HOME').success).toBe(true);
    expect(LifecycleJobPhaseSchema.safeParse('IN_PROGRESS').success).toBe(false);
  });

  it('keeps the phase vocabulary in lockstep with the prisma LifecycleJobPhase enum', () => {
    expect([...LifecycleJobPhaseSchema.options].sort()).toEqual(Object.values(PrismaLifecycleJobPhase).sort());
  });

  it('reports the payload and the response body as cut against their own caps, not one shared flag', () => {
    const row = WebhookDeliveryRowSchema.parse(
      delivery({ payloadTruncated: false, responseBody: 'prefix', responseBodyTruncated: true }),
    );

    expect(row.payloadTruncated).toBe(false);
    expect(row.responseBodyTruncated).toBe(true);
    expect(WebhookDeliveryRowSchema.safeParse({ ...delivery(), responseBodyTruncated: undefined }).success).toBe(false);
  });

  it('requires a job detail to say whether its timeline was cut, so a short one is not read as complete', () => {
    const detail = {
      job: null,
      payload: null,
      payloadTruncated: false,
      events: [],
      eventsTruncated: false,
      eventsSkipped: 0,
      eventsReadError: null,
    };

    expect(LifecycleJobDetailSchema.parse(detail).eventsTruncated).toBe(false);
    const { eventsTruncated, ...withoutFlag } = detail;
    expect(eventsTruncated).toBe(false);
    expect(LifecycleJobDetailSchema.safeParse(withoutFlag).success).toBe(false);
  });

  it('keeps an httpStatus that never arrived distinct from a zero', () => {
    const none = WebhookDeliveryRowSchema.parse(delivery({ httpStatus: null }));
    expect(none.httpStatus).toBeNull();
    expect(WebhookDeliveryRowSchema.parse(delivery({ httpStatus: 0 })).httpStatus).toBe(0);
  });
});

describe('the lifecycle phase filter', () => {
  const query = () => {
    const route = contract.listLifecycleJobs;
    if (!isAppRoute(route) || !(route.query instanceof z.ZodObject)) throw new Error('no query schema');
    return route.query;
  };

  it('reads a comma-separated list, so one url param carries a whole phase group', () => {
    expect(query().parse({ phases: 'RUNNING,DISPATCHED' }).phases).toEqual(['RUNNING', 'DISPATCHED']);
  });

  it('rejects a phase outside the engine vocabulary rather than dropping it and widening the listing', () => {
    expect(query().safeParse({ phases: 'RUNNING,IN_PROGRESS' }).success).toBe(false);
  });

  it('treats an absent filter as every phase, not as none', () => {
    expect(query().parse({}).phases).toEqual([]);
    expect(query().parse({ phases: '' }).phases).toEqual([]);
  });

  it('tolerates the spacing a hand-edited url carries', () => {
    expect(query().parse({ phases: ' RUNNING , FAILED ' }).phases).toEqual(['RUNNING', 'FAILED']);
  });
});

describe('the lifecycle queue join', () => {
  const join = {
    joinable: true,
    unjoinableReason: null,
    deviceId: 'dev-1',
    matches: [],
    searchedQueues: [{ prefix: 'zone-1', name: 'lifecycle', kind: 'saga' as const }],
    discoveryCapped: false,
    readError: null,
  };

  it('requires the capped flag, so a short match list cannot pass as a complete one', () => {
    const { discoveryCapped, ...withoutFlag } = join;

    expect(discoveryCapped).toBe(false);
    expect(LifecycleQueueJoinSchema.safeParse(withoutFlag).success).toBe(false);
  });

  it('keeps a job that cannot be joined distinct from one with no queue jobs', () => {
    const unjoinable = LifecycleQueueJoinSchema.parse({
      ...join,
      joinable: false,
      unjoinableReason: 'this lifecycle job is not scoped to a device',
      deviceId: null,
    });
    const empty = LifecycleQueueJoinSchema.parse(join);

    expect(unjoinable.matches).toEqual(empty.matches);
    expect(unjoinable.joinable).toBe(false);
    expect(empty.joinable).toBe(true);
    expect(unjoinable).not.toEqual(empty);
  });

  it('states where it looked, so an empty result can be read against the search', () => {
    expect(LifecycleQueueJoinSchema.parse(join).searchedQueues).toHaveLength(1);
    expect(LifecycleQueueJoinSchema.safeParse({ ...join, searchedQueues: undefined }).success).toBe(false);
  });
});

describe('the lifecycle list row', () => {
  it('carries the newest step, so a phase is not the only thing a row says', () => {
    expect(Object.keys(LifecycleJobRowSchema.shape)).toContain('latestStep');
    expect(LifecycleJobRowSchema.shape.latestStep.safeParse(null).success).toBe(true);
  });

  it('requires the census to report its own failure rather than counting zero', () => {
    const page = { rows: [], skipped: 0, readError: null, counts: [], countsReadError: null };

    expect(LifecycleJobPageSchema.parse(page).counts).toEqual([]);
    const { countsReadError, ...withoutError } = page;
    expect(countsReadError).toBeNull();
    expect(LifecycleJobPageSchema.safeParse(withoutError).success).toBe(false);
  });
});
