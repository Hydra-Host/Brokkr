// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  DeviceTokenEventPage,
  DeviceTokenPage,
  LifecycleJobDetail,
  LifecycleJobPage,
  LifecycleQueueJoin,
  WebhookDeliveryPage,
} from '@/contract';
import { stateTone } from '@/features/datastore/queues/queue-health';
import type { HubSearch } from '@/lib/hub-search';

interface LinkStubProps {
  to: string;
  search: (prev: Record<string, unknown>) => Record<string, unknown>;
  children: ReactNode;
  className?: string;
  title?: string;
}

const { state, linkTargets } = vi.hoisted(() => ({
  linkTargets: [] as { to: string; search: (prev: Record<string, unknown>) => Record<string, unknown> }[],
  state: {
    deliveries: null as WebhookDeliveryPage | null,
    jobs: null as LifecycleJobPage | null,
    tokens: null as DeviceTokenPage | null,
    jobDetail: null as LifecycleJobDetail | null,
    queueJoin: null as LifecycleQueueJoin | null,
    tokenEvents: null as DeviceTokenEventPage | null,
    error: null as string | null,
  },
}));

vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  Link: ({ to, search, children, className, title }: LinkStubProps) => {
    linkTargets.push({ to, search });
    return (
      <a href={to} className={className} title={title}>
        {children}
      </a>
    );
  },
}));

vi.mock('@/features/hub/use-hub', () => ({
  useWebhookDeliveries: () => ({ page: state.deliveries, error: state.error, isPending: false }),
  useLifecycleJobs: () => ({ page: state.jobs, error: state.error, isPending: false }),
  useLifecycleJob: () => ({ detail: state.jobDetail, error: null, isPending: false }),
  useLifecycleQueueJobs: () => ({ join: state.queueJoin, error: null, isPending: false }),
  useDeviceTokens: () => ({ page: state.tokens, error: state.error, isPending: false }),
  useDeviceTokenEvents: () => ({ page: state.tokenEvents, error: null, isPending: false }),
}));

import { HubView } from './hub';

const NOW = 1_700_000_000_000;

const search = (over: Partial<HubSearch> = {}): HubSearch => ({
  tab: 'lifecycle',
  deliveryStatus: undefined,
  webhookId: undefined,
  phases: [],
  jobId: undefined,
  deviceId: undefined,
  tokenStatus: undefined,
  tokenId: undefined,
  ...over,
});

const token = (over = {}) => ({
  id: 'tok-1',
  displayId: 'dtok_0123456789ab',
  deviceId: 'dev-1',
  deploymentId: null,
  context: 'BROKKR_LIVE',
  status: 'ACTIVE' as const,
  rotationGeneration: 0,
  expiresAtMs: null,
  lastUsedAtMs: NOW - 4000,
  lastUsedIp: '127.0.0.1',
  usedWithinThrottleWindow: false,
  revokedAtMs: null,
  revokedReason: null,
  issuedBy: null,
  createdAtMs: NOW,
  ...over,
});

const delivery = (over = {}) => ({
  id: 'del-1',
  webhookId: 'wh-1',
  endpoint: 'https://example.test/hook',
  eventType: 'DEPLOYMENT_INTERRUPTED',
  status: 'RETRYING' as const,
  httpStatus: 500,
  attempts: 2,
  errorMessage: null,
  idempotencyKey: null,
  nextRetryAtMs: null,
  createdAtMs: NOW - 1000,
  deliveredAtMs: null,
  lockedBy: null,
  lockedAtMs: null,
  lockExpiresAtMs: null,
  payload: {},
  payloadTruncated: false,
  responseBody: null,
  responseBodyTruncated: false,
  ...over,
});

const job = (over = {}) => ({
  id: 'plan-1',
  jobType: 'Provision',
  phase: 'AWAITING_PHONE_HOME' as const,
  deviceId: 'dev-1',
  deploymentId: null,
  source: 'API',
  performedBy: null,
  error: null,
  scheduledAtMs: null,
  phoneHomeDeadlineMs: null,
  linkedJobId: null,
  createdAtMs: NOW,
  updatedAtMs: NOW,
  latestStep: null,
  ...over,
});

const detail = (over: Partial<LifecycleJobDetail> = {}): LifecycleJobDetail => ({
  job: job(),
  payload: { request: { hostname: 'cpu-1' } },
  payloadTruncated: false,
  events: [],
  eventsTruncated: false,
  eventsSkipped: 0,
  eventsReadError: null,
  ...over,
});

const tokenEvent = (over = {}) => ({
  id: 'tev-1',
  event: 'USED',
  actor: null,
  ip: '127.0.0.1',
  userAgent: null,
  createdAtMs: NOW,
  ...over,
});

const event = (over = {}) => ({
  id: 'evt-1',
  sagaName: 'provision',
  stepName: 'wipe',
  eventType: 'step',
  status: 'complete',
  attempt: 0,
  error: null,
  occurredAtMs: NOW,
  recordedAtMs: NOW,
  ...over,
});

const setSearch = vi.fn();
const show = (over: Partial<HubSearch> = {}) =>
  render(<HubView search={search(over)} setSearch={setSearch} nowMs={NOW} />);

beforeEach(() => {
  state.deliveries = null;
  state.jobs = { rows: [], skipped: 0, readError: null, counts: [], countsReadError: null };
  state.tokens = { rows: [], skipped: 0, readError: null, recencyReadError: null };
  state.jobDetail = null;
  state.queueJoin = null;
  linkTargets.length = 0;
  state.tokenEvents = null;
  state.error = null;
  setSearch.mockClear();
});

afterEach(cleanup);

describe('HubView', () => {
  it('renders with no router mounted at all', () => {
    show();
    expect(screen.getByText('Lifecycle jobs')).toBeDefined();
  });

  it('marks the surface read-only', () => {
    show();
    expect(screen.getByText('read-only')).toBeDefined();
  });

  it('renders the tab the search names', () => {
    show({ tab: 'tokens' });
    expect(screen.getByText('audit trail')).toBeDefined();
  });
});

describe('webhook deliveries tab', () => {
  it('flags a lock held past its expiry as wedged rather than in flight', () => {
    state.deliveries = {
      rows: [delivery({ lockedBy: 'worker-1', lockedAtMs: NOW - 60_000, lockExpiresAtMs: NOW - 1000 })],
      skipped: 0,
      readError: null,
    };
    show({ tab: 'webhooks' });

    expect(screen.getByText(/worker-1 \(stale\)/)).toBeDefined();
    expect(screen.getByTitle(/wedged, not in flight/)).toBeDefined();
  });

  it('renders no http status at all when the attempt never got a response', () => {
    state.deliveries = { rows: [delivery({ httpStatus: null })], skipped: 0, readError: null };
    show({ tab: 'webhooks' });

    expect(screen.queryAllByText('0')).toHaveLength(0);
    expect(screen.getByTitle(/not a zero status/)).toBeDefined();
  });

  it('distinguishes an unreadable list from one with no matches', () => {
    state.deliveries = { rows: [], skipped: 0, readError: null };
    const { unmount } = show({ tab: 'webhooks' });
    expect(screen.getByText('no deliveries match')).toBeDefined();
    unmount();

    state.deliveries = { rows: [], skipped: 0, readError: 'ECONNREFUSED' };
    show({ tab: 'webhooks' });
    expect(screen.queryByText('no deliveries match')).toBeNull();
    expect(screen.getByText(/ECONNREFUSED/)).toBeDefined();
  });

  it('marks a response body that is only a prefix, and leaves a whole one unmarked', () => {
    state.deliveries = {
      rows: [delivery({ responseBody: 'upstream said', responseBodyTruncated: true })],
      skipped: 0,
      readError: null,
    };
    const { unmount } = show({ tab: 'webhooks' });
    expect(screen.getByText(/upstream said …\[cut\]/)).toBeDefined();
    unmount();

    state.deliveries = {
      rows: [delivery({ responseBody: 'upstream said', responseBodyTruncated: false })],
      skipped: 0,
      readError: null,
    };
    show({ tab: 'webhooks' });
    expect(screen.getByText('upstream said')).toBeDefined();
    expect(screen.queryByText(/\[cut\]/)).toBeNull();
  });

  it('states how many rows it could not parse rather than showing a silently short list', () => {
    state.deliveries = { rows: [delivery()], skipped: 2, readError: null };
    show({ tab: 'webhooks' });

    expect(screen.getByText('2 row(s) unreadable and omitted')).toBeDefined();
  });
});

describe('device tokens tab', () => {
  it('identifies a token by its non-secret display id', () => {
    state.tokens = { rows: [token()], skipped: 0, readError: null, recencyReadError: null };
    show({ tab: 'tokens' });

    expect(screen.getByText('dtok_0123456789ab')).toBeDefined();
  });

  it('prefers the live sentinel over the throttled column', () => {
    state.tokens = {
      rows: [token({ usedWithinThrottleWindow: true })],
      skipped: 0,
      readError: null,
      recencyReadError: null,
    };
    show({ tab: 'tokens' });

    expect(screen.getByText('used just now')).toBeDefined();
  });

  it('renders the recency cell itself as unknown, not merely a banner beside a stale age', () => {
    state.tokens = {
      rows: [token({ usedWithinThrottleWindow: null })],
      skipped: 0,
      readError: null,
      recencyReadError: 'ECONNREFUSED',
    };
    show({ tab: 'tokens' });

    expect(screen.getByText('?')).toBeDefined();
    expect(screen.queryByText(/ago/)).toBeNull();
    expect(screen.queryByText('never used')).toBeNull();
    expect(screen.getByText(/recency probe unavailable/)).toBeDefined();
  });

  it('keeps a genuinely never-used token distinct from an unread one', () => {
    state.tokens = {
      rows: [token({ lastUsedAtMs: null, usedWithinThrottleWindow: false })],
      skipped: 0,
      readError: null,
      recencyReadError: null,
    };
    show({ tab: 'tokens' });

    expect(screen.getByText('never used')).toBeDefined();
  });
});

describe('the lifecycle job detail pane', () => {
  it('renders a live phone-home watchdog as time remaining, not as an already-fired deadline', () => {
    state.jobDetail = detail({ job: job({ phoneHomeDeadlineMs: NOW + 240_000 }) });
    show({ tab: 'lifecycle', jobId: 'plan-1' });

    expect(screen.getByText(/phone-home deadline in 4m/)).toBeDefined();
    expect(screen.queryByText(/phone-home deadline 0s ago/)).toBeNull();
  });

  it('says a missed deadline is overdue rather than dressing it as time remaining', () => {
    state.jobDetail = detail({ job: job({ phoneHomeDeadlineMs: NOW - 120_000 }) });
    show({ tab: 'lifecycle', jobId: 'plan-1' });

    expect(screen.getByText(/phone-home deadline 2m overdue/)).toBeDefined();
  });

  it('renders the redacted payload the reader produced', () => {
    state.jobDetail = detail();
    show({ tab: 'lifecycle', jobId: 'plan-1' });

    expect(screen.getByText(/cpu-1/)).toBeDefined();
  });

  it('marks a payload that is only a prefix', () => {
    state.jobDetail = detail({ payloadTruncated: true });
    show({ tab: 'lifecycle', jobId: 'plan-1' });

    expect(screen.getByText(/payload \(truncated\)/)).toBeDefined();
  });

  it('renders the step timeline grouped under the saga that ran it', () => {
    state.jobDetail = detail({ events: [event({ stepName: 'install' })] });
    show({ tab: 'lifecycle', jobId: 'plan-1' });

    expect(screen.getByText('provision')).toBeDefined();
    expect(screen.getByText('install')).toBeDefined();
    expect(screen.getByText('1 step')).toBeDefined();
  });

  it('keeps two runs of one saga apart rather than merging them into a single block', () => {
    state.jobDetail = detail({
      events: [
        event({ id: 'a', stepName: 'wipe' }),
        event({ id: 'b', sagaName: 'collection', stepName: 'inventory' }),
        event({ id: 'c', stepName: 'verify' }),
      ],
    });
    show({ tab: 'lifecycle', jobId: 'plan-1' });

    expect(screen.getAllByText('provision')).toHaveLength(2);
    expect(screen.getAllByText('1 step')).toHaveLength(3);
  });

  it('reports a step the bridge sent no time for as unknown rather than as a zero lag', () => {
    state.jobDetail = detail({ events: [event({ occurredAtMs: null })] });
    const { unmount } = show({ tab: 'lifecycle', jobId: 'plan-1' });
    expect(screen.getByText('no bridge time')).toBeDefined();
    expect(screen.queryByText(/ingest/)).toBeNull();
    unmount();

    state.jobDetail = detail({ events: [event({ occurredAtMs: NOW - 9000, recordedAtMs: NOW })] });
    show({ tab: 'lifecycle', jobId: 'plan-1' });
    expect(screen.getByText('+9s ingest')).toBeDefined();
    expect(screen.queryByText('no bridge time')).toBeNull();
  });

  it('calls a bridge stamp off the hub clock implausible rather than a 56-year ingest lag', () => {
    state.jobDetail = detail({ events: [event({ occurredAtMs: 1_808_070_994, recordedAtMs: NOW })] });
    show({ tab: 'lifecycle', jobId: 'plan-1' });

    expect(screen.getByText('bridge time implausible')).toBeDefined();
    expect(screen.queryByText(/ingest/)).toBeNull();
  });

  it('signs a bridge clock ahead of the hub, rather than rendering a plus in front of a minus', () => {
    state.jobDetail = detail({ events: [event({ occurredAtMs: NOW + 3000, recordedAtMs: NOW })] });
    show({ tab: 'lifecycle', jobId: 'plan-1' });

    expect(screen.getByText('-3s ingest')).toBeDefined();
    expect(screen.queryByText(/\+-/)).toBeNull();
  });

  it('still marks a hub that trailed the bridge with a plus', () => {
    state.jobDetail = detail({ events: [event({ occurredAtMs: NOW - 3000, recordedAtMs: NOW })] });
    show({ tab: 'lifecycle', jobId: 'plan-1' });

    expect(screen.getByText('+3s ingest')).toBeDefined();
  });

  it('shows a retried step as more than one attempt', () => {
    state.jobDetail = detail({ events: [event({ attempt: 2 })] });
    show({ tab: 'lifecycle', jobId: 'plan-1' });

    expect(screen.getByText('\u00d73')).toBeDefined();
  });

  it('keeps the payload collapsed, so the timeline is not pushed below it', () => {
    state.jobDetail = detail({ events: [event()] });
    const { container } = show({ tab: 'lifecycle', jobId: 'plan-1' });

    const payload = container.querySelector('details');
    expect(payload).not.toBeNull();
    expect(payload?.hasAttribute('open')).toBe(false);
  });

  it('says a cut timeline is cut, so a short one is not read as the whole', () => {
    state.jobDetail = detail({ events: [event()], eventsTruncated: true });
    const { unmount } = show({ tab: 'lifecycle', jobId: 'plan-1' });
    expect(screen.getByText(/timeline \(oldest omitted\)/)).toBeDefined();
    unmount();

    state.jobDetail = detail({ events: [event()] });
    show({ tab: 'lifecycle', jobId: 'plan-1' });
    expect(screen.queryByText(/oldest omitted/)).toBeNull();
  });

  it('distinguishes an unreadable timeline from a job with no events', () => {
    state.jobDetail = detail({ eventsReadError: 'ECONNREFUSED' });
    const { unmount } = show({ tab: 'lifecycle', jobId: 'plan-1' });
    expect(screen.queryByText('no events recorded')).toBeNull();
    expect(screen.getByText(/ECONNREFUSED/)).toBeDefined();
    unmount();

    state.jobDetail = detail();
    show({ tab: 'lifecycle', jobId: 'plan-1' });
    expect(screen.getByText('no events recorded')).toBeDefined();
  });

  it('shows a device filter it inherited from a deep link, with a way to clear it', () => {
    show({ tab: 'lifecycle', deviceId: 'dev-abcdef' });

    const chip = screen.getByTitle(/clear the device filter/);
    expect(chip.textContent).toContain('abcdef');
    chip.click();
    expect(setSearch).toHaveBeenCalledWith({ deviceId: undefined });
  });
});

describe('the device token audit trail', () => {
  it('flags a use after revocation rather than listing it like any other event', () => {
    state.tokenEvents = { rows: [tokenEvent({ event: 'USED_AFTER_REVOKE' })], skipped: 0, readError: null };
    show({ tab: 'tokens', tokenId: 'tok-1' });

    const cell = screen.getByText('USED_AFTER_REVOKE');
    expect(cell.className).toContain('text-status-offline');
    expect(screen.getByTitle(/token it should no longer be able to use/)).toBeDefined();
  });

  it('leaves an ordinary event untoned, so the alarm colour stays a signal', () => {
    state.tokenEvents = { rows: [tokenEvent({ event: 'ISSUED' })], skipped: 0, readError: null };
    show({ tab: 'tokens', tokenId: 'tok-1' });

    expect(screen.getByText('ISSUED').className).not.toContain('text-status-offline');
  });

  it('distinguishes an unreadable audit trail from a token with no events', () => {
    state.tokenEvents = { rows: [], skipped: 0, readError: 'pg down' };
    const { unmount } = show({ tab: 'tokens', tokenId: 'tok-1' });
    expect(screen.queryByText('no audit events')).toBeNull();
    expect(screen.getByText(/pg down/)).toBeDefined();
    unmount();

    state.tokenEvents = { rows: [], skipped: 0, readError: null };
    show({ tab: 'tokens', tokenId: 'tok-1' });
    expect(screen.getByText('no audit events')).toBeDefined();
  });
});

describe('the lifecycle list row', () => {
  it('says which saga step a job is on, because a phase alone does not', () => {
    state.jobs = {
      rows: [job({ latestStep: { ...event(), sagaName: 'provision', stepName: 'install', attempt: 1 } })],
      skipped: 0,
      readError: null,
      counts: [],
      countsReadError: null,
    };
    show({ tab: 'lifecycle' });

    expect(screen.getByText(/provision\/install/)).toBeDefined();
    expect(screen.getByText(/×2/)).toBeDefined();
  });

  it('survives a lab api too old to report the step, and calls it unknown rather than none', () => {
    const stale = { ...job() };
    delete (stale as { latestStep?: unknown }).latestStep;
    state.jobs = { rows: [stale], skipped: 0, readError: null, counts: [], countsReadError: null };
    show({ tab: 'lifecycle' });

    expect(screen.getByTitle(/does not report the newest step/)).toBeDefined();
    expect(screen.queryByText('no steps yet')).toBeNull();
  });

  it('says a job has recorded no steps rather than leaving the line blank', () => {
    state.jobs = { rows: [job()], skipped: 0, readError: null, counts: [], countsReadError: null };
    show({ tab: 'lifecycle' });

    expect(screen.getByText('no steps yet')).toBeDefined();
  });
});

describe('the phase census', () => {
  const counts = [
    { phase: 'RUNNING' as const, count: 4 },
    { phase: 'AWAITING_PHONE_HOME' as const, count: 2 },
    { phase: 'FAILED' as const, count: 3 },
    { phase: 'COMPLETED' as const, count: 90 },
  ];

  it('totals the whole table rather than the returned page', () => {
    state.jobs = { rows: [job()], skipped: 0, readError: null, counts, countsReadError: null };
    show({ tab: 'lifecycle' });

    expect(screen.getByText('99')).toBeDefined();
    expect(screen.getByText('6')).toBeDefined();
  });

  it('renders no counts at all when the census could not be read, rather than zeros', () => {
    state.jobs = { rows: [job()], skipped: 0, readError: null, counts: [], countsReadError: 'pg down' };
    show({ tab: 'lifecycle' });

    expect(screen.getByText(/phase census unavailable/)).toBeDefined();
    expect(screen.queryAllByText('0')).toHaveLength(0);
  });
});

describe('the phase group filter', () => {
  it('selects a whole group with one click rather than one phase', () => {
    show({ tab: 'lifecycle' });

    screen.getByText('in flight').click();
    expect(setSearch).toHaveBeenCalledWith({
      phases: ['REQUESTED', 'AUTHORIZING', 'SCHEDULED', 'DEFERRED', 'DISPATCHED', 'RUNNING', 'AWAITING_PHONE_HOME'],
    });
  });

  it('marks the group active only when the selection is exactly that group', () => {
    const { unmount } = show({ tab: 'lifecycle', phases: ['COMPLETED', 'FAILED', 'ABORTED'] });
    expect(screen.getByText('terminal').className).toContain('border-accent');
    unmount();

    show({ tab: 'lifecycle', phases: ['FAILED'] });
    expect(screen.getByText('terminal').className).not.toContain('border-accent');
  });
});

describe('the saga queue panel', () => {
  const queueJob = (over = {}) => ({
    id: 'dev-1-provision-plan-1',
    name: 'saga.run',
    state: 'failed' as const,
    attemptsMade: 3,
    timestamp: NOW,
    processedOn: NOW - 5000,
    finishedOn: NOW - 1000,
    delay: 0,
    failedReason: 'bridge timed out awaiting agent',
    deviceId: 'dev-1',
    sagaName: 'provision',
    planId: 'plan-1',
    sealed: false,
    zoneId: 'zone-1',
    ...over,
  });
  const join = (over = {}) => ({
    joinable: true,
    unjoinableReason: null,
    deviceId: 'dev-1',
    matches: [{ queue: { prefix: 'zone-1', name: 'lifecycle', kind: 'saga' as const }, job: queueJob() }],
    searchedQueues: [{ prefix: 'zone-1', name: 'lifecycle', kind: 'saga' as const }],
    discoveryCapped: false,
    readError: null,
    ...over,
  });

  it('shows the queue job the plan id resolves to, with a way into the inspector', () => {
    state.jobDetail = detail();
    state.queueJoin = join();
    show({ tab: 'lifecycle', jobId: 'plan-1' });

    expect(screen.getByText('bridge timed out awaiting agent')).toBeDefined();
    expect(screen.getByText('3 att')).toBeDefined();
    expect(screen.getByTitle(/queue inspector/)).toBeDefined();
    expect(linkTargets.map((entry) => entry.to)).toContain('/datastore');
  });

  it('routes the inspector link at the exact queue job, not merely at the queues tab', () => {
    state.jobDetail = detail();
    state.queueJoin = join();
    show({ tab: 'lifecycle', jobId: 'plan-1' });

    const target = linkTargets.find((entry) => entry.to === '/datastore');
    expect(target?.search({})).toMatchObject({
      tab: 'queues',
      queuePrefix: 'zone-1',
      queueName: 'lifecycle',
      jobId: 'dev-1-provision-plan-1',
    });
  });

  it('says a job with no device cannot be joined, rather than that it has no queue jobs', () => {
    state.jobDetail = detail();
    state.queueJoin = join({
      joinable: false,
      unjoinableReason: 'this lifecycle job is not scoped to a device',
      deviceId: null,
      matches: [],
      searchedQueues: [],
    });
    show({ tab: 'lifecycle', jobId: 'plan-1' });

    expect(screen.getByText(/cannot be joined/)).toBeDefined();
    expect(screen.queryByText(/no queue job/)).toBeNull();
  });

  it('tones a queue state the same way the queue inspector does', () => {
    state.jobDetail = detail();
    state.queueJoin = join({
      matches: [
        {
          queue: { prefix: 'zone-1', name: 'lifecycle', kind: 'saga' as const },
          job: queueJob({ state: 'delayed' as const }),
        },
      ],
    });
    show({ tab: 'lifecycle', jobId: 'plan-1' });

    expect(screen.getByText('delayed').className).toBe(stateTone('delayed'));
  });

  it('does not claim none were found when the search itself was incomplete', () => {
    state.jobDetail = detail();
    state.queueJoin = join({ matches: [], discoveryCapped: true });
    const { unmount } = show({ tab: 'lifecycle', jobId: 'plan-1' });
    expect(screen.getByText(/search above was incomplete/)).toBeDefined();
    expect(screen.queryByText(/no queue job carries this plan id/)).toBeNull();
    unmount();

    state.jobDetail = detail();
    state.queueJoin = join({ matches: [], readError: 'redis down' });
    show({ tab: 'lifecycle', jobId: 'plan-1' });
    expect(screen.getByText(/search above was incomplete/)).toBeDefined();
  });

  it('says a capped search may be short rather than presenting it as complete', () => {
    state.jobDetail = detail();
    state.queueJoin = join({ discoveryCapped: true });
    show({ tab: 'lifecycle', jobId: 'plan-1' });

    expect(screen.getByText(/the search was capped/)).toBeDefined();
  });

  it('reads an empty result for a finished job as trimmed, not as missing', () => {
    state.jobDetail = detail({ job: job({ phase: 'COMPLETED' }) });
    state.queueJoin = join({ matches: [] });
    const { unmount } = show({ tab: 'lifecycle', jobId: 'plan-1' });
    expect(screen.getByText(/keep-completed policy/)).toBeDefined();
    unmount();

    state.jobDetail = detail({ job: job({ phase: 'RUNNING' }) });
    state.queueJoin = join({ matches: [] });
    show({ tab: 'lifecycle', jobId: 'plan-1' });
    expect(screen.getByText(/no queue job carries this plan id/)).toBeDefined();
    expect(screen.queryByText(/keep-completed/)).toBeNull();
  });

  it('reports a queue it could not read rather than showing the rest as the whole answer', () => {
    state.jobDetail = detail();
    state.queueJoin = join({ readError: 'redis down' });
    show({ tab: 'lifecycle', jobId: 'plan-1' });

    expect(screen.getByText(/a queue could not be read/)).toBeDefined();
  });
});
