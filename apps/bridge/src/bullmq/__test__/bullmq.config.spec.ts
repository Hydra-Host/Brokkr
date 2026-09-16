import { describe, expect, it } from 'vitest';

import { JobStatus, TERMINAL_STATUSES } from '../../saga-framework/state.types';

import { buildBullmqConfig, LOCK_WAIT_REDIS_TTL_DEFAULT_SECONDS } from '../bullmq.config';

const sagaPlanGlob = (zoneUuid: string): string => `${zoneUuid}:bridge:jobs:plan:*`;

const effectivePlanKey = (zonePrefix: string, redisKeyPrefix: string, id: string): string =>
  `${zonePrefix}:${redisKeyPrefix}:plan:${id}`;

describe('buildBullmqConfig lock policy', () => {
  it('uses the approved defaults while preserving existing defaults', () => {
    expect(buildBullmqConfig({})).toEqual({
      redisKeyPrefix: 'bridge:jobs',
      defaultJobTtlSeconds: 7_200,
      bullmqQueueName: 'lifecycle',
      bullmqPrefix: 'bull',
      redisPrefix: '',
      queueMode: 'device',
      bullmqRetries: 1,
      delayedPromoteIntervalSeconds: 3,
      lifecycleWorkerConcurrency: 10,
      deviceLockTimeoutSeconds: 60,
      deviceLockRenewIntervalSeconds: 20,
      lockLostRedelaySeconds: 90,
      bullmqLockDurationMs: 120_000,
      bullmqLockRenewTimeMs: 60_000,
      bullmqMaxStalledCount: 5,
      bullmqStalledIntervalMs: 30_000,
      resultsQueueName: 'inbox',
      resultsQueuePrefix: 'results',
      collectionQueueName: 'collection',
      collectionWorkerConcurrency: 1,
      brokkrLiveInitialDelaySeconds: 90,
      brokkrLiveWaitSeconds: 1800,
      lockWaitWarningSeconds: 60,
      lockWaitHardCapSeconds: 240,
      lockWaitRedisTtlSeconds: LOCK_WAIT_REDIS_TTL_DEFAULT_SECONDS,
      agentWaitHardCapSeconds: 3_600,
      strandedPlanResumeIntervalSeconds: 30,
      strandedPlanGraceSeconds: 60,
      strandedPlanResumeBatchSize: 10,
      strandedPlanRunningStaleSeconds: 1800,
    });
  });

  it.each([
    { lockLostRedelaySeconds: '59', deviceLockTimeoutSeconds: '60' },
    { lockLostRedelaySeconds: '60', deviceLockTimeoutSeconds: '60' },
  ])(
    'rejects $lockLostRedelaySeconds when the device lock timeout is $deviceLockTimeoutSeconds',
    ({ lockLostRedelaySeconds, deviceLockTimeoutSeconds }) => {
      expect(() =>
        buildBullmqConfig({
          LOCK_LOST_REDELAY_SECONDS: lockLostRedelaySeconds,
          DEVICE_LOCK_TIMEOUT_SECONDS: deviceLockTimeoutSeconds,
        }),
      ).toThrow(/LOCK_LOST_REDELAY_SECONDS \(.*\) must exceed DEVICE_LOCK_TIMEOUT_SECONDS \(.*\)/);
    },
  );

  it('accepts configured warning, hard-cap, and lock-loss delays', () => {
    const config = buildBullmqConfig({
      LOCK_WAIT_WARNING_SECONDS: '90',
      LOCK_WAIT_HARD_CAP_SECONDS: '120',
      DEVICE_LOCK_TIMEOUT_SECONDS: '60',
      LOCK_LOST_REDELAY_SECONDS: '61',
    });

    expect(config.lockWaitWarningSeconds).toBe(90);
    expect(config.lockWaitHardCapSeconds).toBe(120);
    expect(config.lockLostRedelaySeconds).toBe(61);
  });

  it('derives an unset lock-loss delay above a configured device lock timeout', () => {
    const config = buildBullmqConfig({ DEVICE_LOCK_TIMEOUT_SECONDS: '120' });

    expect(config.lockLostRedelaySeconds).toBe(150);
  });

  it.each(['-1', '-90'])('rejects a negative lock-wait hard cap', (hardCap) => {
    expect(() => buildBullmqConfig({ LOCK_WAIT_HARD_CAP_SECONDS: hardCap })).toThrow(
      /LOCK_WAIT_HARD_CAP_SECONDS .* must be non-negative/,
    );
  });

  it('rejects a lock-wait hard cap at the envelope freshness window', () => {
    expect(() => buildBullmqConfig({ LOCK_WAIT_HARD_CAP_SECONDS: '300' })).toThrow(
      /LOCK_WAIT_HARD_CAP_SECONDS .* must be less than the envelope freshness window/,
    );
  });

  it('rejects a lock-loss redelay at the envelope freshness window', () => {
    expect(() => buildBullmqConfig({ LOCK_LOST_REDELAY_SECONDS: '300' })).toThrow(
      /LOCK_LOST_REDELAY_SECONDS .* must be less than the envelope freshness window/,
    );
  });

  it('rejects an agent-wait hard cap inside the brokkr-live boot window', () => {
    expect(() => buildBullmqConfig({ AGENT_WAIT_HARD_CAP_SECONDS: '900' })).toThrow(
      /AGENT_WAIT_HARD_CAP_SECONDS .* must exceed the brokkr-live boot window/,
    );
  });

  it('rejects an agent-wait hard cap at the boot-window boundary', () => {
    expect(() => buildBullmqConfig({ AGENT_WAIT_HARD_CAP_SECONDS: '1890' })).toThrow(
      /AGENT_WAIT_HARD_CAP_SECONDS .* must exceed the brokkr-live boot window/,
    );
  });

  it('accepts an agent-wait hard cap just above the boot window', () => {
    expect(buildBullmqConfig({ AGENT_WAIT_HARD_CAP_SECONDS: '1891' }).agentWaitHardCapSeconds).toBe(1_891);
  });

  it('accepts a zero agent-wait hard cap as disabled', () => {
    expect(buildBullmqConfig({ AGENT_WAIT_HARD_CAP_SECONDS: '0' }).agentWaitHardCapSeconds).toBe(0);
  });

  it('rejects a negative agent-wait hard cap', () => {
    expect(() => buildBullmqConfig({ AGENT_WAIT_HARD_CAP_SECONDS: '-1' })).toThrow(
      /AGENT_WAIT_HARD_CAP_SECONDS .* must be non-negative/,
    );
  });

  it('accepts an agent-wait hard cap above a shrunk boot window', () => {
    const config = buildBullmqConfig({
      AGENT_WAIT_HARD_CAP_SECONDS: '900',
      BROKKR_LIVE_INITIAL_DELAY_SECONDS: '30',
      BROKKR_LIVE_WAIT_SECONDS: '60',
    });

    expect(config.agentWaitHardCapSeconds).toBe(900);
  });

  it('rejects a derived lock-loss redelay beyond the envelope freshness window', () => {
    expect(() => buildBullmqConfig({ DEVICE_LOCK_TIMEOUT_SECONDS: '270' })).toThrow(
      /LOCK_LOST_REDELAY_SECONDS .* must be less than the envelope freshness window/,
    );
  });

  it('rejects a negative lock-wait warning threshold', () => {
    expect(() => buildBullmqConfig({ LOCK_WAIT_WARNING_SECONDS: '-1' })).toThrow(
      /LOCK_WAIT_WARNING_SECONDS .* must be non-negative/,
    );
  });

  it.each(['59', '60'])('rejects a %s-second redelay for a 60-second device lock', (redelay) => {
    expect(() =>
      buildBullmqConfig({
        DEVICE_LOCK_TIMEOUT_SECONDS: '60',
        LOCK_LOST_REDELAY_SECONDS: redelay,
      }),
    ).toThrow(/LOCK_LOST_REDELAY_SECONDS .* must exceed DEVICE_LOCK_TIMEOUT_SECONDS/);
  });

  it('rejects a renewal retry budget that reaches the device lock timeout', () => {
    expect(() =>
      buildBullmqConfig({
        DEVICE_LOCK_TIMEOUT_SECONDS: '60',
        DEVICE_LOCK_RENEW_INTERVAL_SECONDS: '40',
      }),
    ).toThrow(/leave no safety budget inside DEVICE_LOCK_TIMEOUT_SECONDS/);
  });

  it('rejects a Redis command timeout that exhausts the renewal retry budget', () => {
    expect(() =>
      buildBullmqConfig({
        DEVICE_LOCK_TIMEOUT_SECONDS: '60',
        DEVICE_LOCK_RENEW_INTERVAL_SECONDS: '20',
        REDIS_SOCKET_TIMEOUT: '20',
      }),
    ).toThrow(/REDIS_SOCKET_TIMEOUT .* leave no safety budget inside DEVICE_LOCK_TIMEOUT_SECONDS/);
  });
});

describe('buildBullmqConfig redisKeyPrefix (zone-relative)', () => {
  it('keeps redisKeyPrefix zone-relative (no zone) with the default JOB_REDIS_KEY_PREFIX', () => {
    const config = buildBullmqConfig({ BROKKR_ZONE_ID: 'zone-x' });

    expect(config.redisKeyPrefix).toBe('bridge:jobs');
    expect(config.redisKeyPrefix).not.toBe('zone-x:bridge:jobs');
    expect(config.redisPrefix).toBe('zone-x');
  });

  it('honours an explicit JOB_REDIS_KEY_PREFIX without prepending the zone', () => {
    const config = buildBullmqConfig({ BROKKR_ZONE_ID: 'zone-x', JOB_REDIS_KEY_PREFIX: 'custom:jobs' });

    expect(config.redisKeyPrefix).toBe('custom:jobs');
  });

  it('produces an effective plan key that matches the hub sagaPlan(zone) glob', () => {
    const zone = 'zone-x';
    const planId = 'plan-123';
    const config = buildBullmqConfig({ BROKKR_ZONE_ID: zone });

    const written = effectivePlanKey(config.redisPrefix, config.redisKeyPrefix, planId);

    expect(written).toBe('zone-x:bridge:jobs:plan:plan-123');

    const glob = sagaPlanGlob(zone);
    expect(glob).toBe('zone-x:bridge:jobs:plan:*');
    expect(written).toBe(glob.replace(/\*$/, planId));
    expect(written).not.toContain(`${zone}:${zone}:`);
  });
});

describe('buildBullmqConfig device lock renewal', () => {
  it('rejects a renewal interval that cannot detect two errors before lease expiry', () => {
    expect(() =>
      buildBullmqConfig({
        DEVICE_LOCK_TIMEOUT_SECONDS: '60',
        DEVICE_LOCK_RENEW_INTERVAL_SECONDS: '40',
      }),
    ).toThrow('DEVICE_LOCK_RENEW_INTERVAL_SECONDS must be at most one third of DEVICE_LOCK_TIMEOUT_SECONDS');
  });
});

describe('buildBullmqConfig lock-wait settings', () => {
  it('uses the approved defaults', () => {
    const config = buildBullmqConfig({});

    expect(config.lockWaitWarningSeconds).toBe(60);
    expect(config.lockWaitHardCapSeconds).toBe(240);
    expect(config.lockWaitRedisTtlSeconds).toBe(LOCK_WAIT_REDIS_TTL_DEFAULT_SECONDS);
  });

  it.each([
    [0, LOCK_WAIT_REDIS_TTL_DEFAULT_SECONDS],
    [120, LOCK_WAIT_REDIS_TTL_DEFAULT_SECONDS],
    [299, LOCK_WAIT_REDIS_TTL_DEFAULT_SECONDS],
  ])('derives the lock-wait Redis TTL for a %i-second hard cap', (hardCap, expectedTtl) => {
    const config = buildBullmqConfig({
      LOCK_WAIT_WARNING_SECONDS: '90',
      LOCK_WAIT_HARD_CAP_SECONDS: String(hardCap),
    });

    expect(config.lockWaitWarningSeconds).toBe(90);
    expect(config.lockWaitHardCapSeconds).toBe(hardCap);
    expect(config.lockWaitRedisTtlSeconds).toBe(expectedTtl);
  });
});

describe('lock-wait status contract', () => {
  it('keeps BLOCKED notification-only and non-terminal', () => {
    expect(JobStatus.BLOCKED).toBe('blocked');
    expect(TERMINAL_STATUSES.has(JobStatus.BLOCKED)).toBe(false);
  });
});

describe('buildBullmqConfig stranded plan resume settings', () => {
  it('uses the stranded plan resume defaults', () => {
    expect(buildBullmqConfig({})).toMatchObject({
      strandedPlanResumeIntervalSeconds: 30,
      strandedPlanGraceSeconds: 60,
      strandedPlanResumeBatchSize: 10,
      strandedPlanRunningStaleSeconds: 1800,
    });
  });

  it('reads the stranded plan resume environment settings', () => {
    expect(
      buildBullmqConfig({
        STRANDED_PLAN_RESUME_INTERVAL_SECONDS: '15',
        STRANDED_PLAN_GRACE_SECONDS: '45',
        STRANDED_PLAN_RESUME_BATCH_SIZE: '20',
        STRANDED_PLAN_RUNNING_STALE_SECONDS: '900',
      }),
    ).toMatchObject({
      strandedPlanResumeIntervalSeconds: 15,
      strandedPlanGraceSeconds: 45,
      strandedPlanResumeBatchSize: 20,
      strandedPlanRunningStaleSeconds: 900,
    });
  });
});

describe('buildBullmqConfig timing settings', () => {
  it('reads the delayed promotion and Brokkr Live environment settings', () => {
    expect(
      buildBullmqConfig({
        DELAYED_PROMOTE_INTERVAL_SECONDS: '7',
        BROKKR_LIVE_INITIAL_DELAY_SECONDS: '45',
        BROKKR_LIVE_WAIT_SECONDS: '900',
      }),
    ).toMatchObject({
      delayedPromoteIntervalSeconds: 7,
      brokkrLiveInitialDelaySeconds: 45,
      brokkrLiveWaitSeconds: 900,
    });
  });

  it.each(['0', '-1'])('rejects a non-positive delayed promotion interval', (interval) => {
    expect(() => buildBullmqConfig({ DELAYED_PROMOTE_INTERVAL_SECONDS: interval })).toThrow(
      'DELAYED_PROMOTE_INTERVAL_SECONDS must be positive',
    );
  });
});
