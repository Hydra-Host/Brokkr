import { UnrecoverableError } from 'bullmq';
import { describe, expect, it } from 'vitest';

import {
  DeviceLockWaitExceeded,
  LOCK_LOST_REDELAY_SECONDS,
  LOCK_RENEW_MAX_TRANSIENT_FAILURES,
  LOCK_WAIT_NOTIFY_INTERVALS_SECONDS,
  LOCK_WAIT_REDIS_KEY_PREFIX,
  LOCK_WAIT_REDIS_TTL_BUFFER_SECONDS,
  LOCK_WAIT_REDIS_TTL_DEFAULT_SECONDS,
} from '../bullmq.types';
import {
  calculateLockWaitTtlSeconds,
  isLockWaitHardCapExceeded,
  lockWaitRedisKey,
  markLockWaitNotified,
  parseLockWaitState,
  recordLockContention,
  selectLockWaitNotificationIntervalSeconds,
  serializeLockWaitState,
  shouldNotifyLockWait,
} from '../lock-wait';

describe('lock-wait constants', () => {
  it('matches the approved BullMQ values', () => {
    expect(LOCK_RENEW_MAX_TRANSIENT_FAILURES).toBe(2);
    expect(LOCK_LOST_REDELAY_SECONDS).toBe(90);
    expect(LOCK_WAIT_REDIS_KEY_PREFIX).toBe('lockwait');
    expect(LOCK_WAIT_REDIS_TTL_DEFAULT_SECONDS).toBe(3_600);
    expect(LOCK_WAIT_REDIS_TTL_BUFFER_SECONDS).toBe(300);
    expect(LOCK_WAIT_NOTIFY_INTERVALS_SECONDS).toEqual([60, 300, 1_800]);
    expect(lockWaitRedisKey('job-1')).toBe('lockwait:job-1');
  });
});

describe('DeviceLockWaitExceeded', () => {
  it('is unrecoverable and preserves contention details', () => {
    const error = new DeviceLockWaitExceeded('device:abc', 125.6, 7);

    expect(error).toBeInstanceOf(UnrecoverableError);
    expect(error.name).toBe('DeviceLockWaitExceeded');
    expect(error.lockKey).toBe('device:abc');
    expect(error.elapsed).toBe(125.6);
    expect(error.attempts).toBe(7);
    expect(error.message).toBe('device:abc lock wait exceeded after 126s (7 attempts)');
  });
});

describe('lock-wait state', () => {
  it('creates the first contention state with holder metadata', () => {
    const state = recordLockContention(null, 'device:abc', 1_000, {
      plan_id: 'holder-plan',
      saga_name: 'provision',
      acquired_at: '2026-07-28T18:00:00Z',
      token: 'ignored',
    });

    expect(state).toEqual({
      first_deferred_at: 1_000,
      first_blocked_at: 1_000,
      attempts: 1,
      reason: 'lock_contention',
      lock_key: 'device:abc',
      last_notified_at: 0,
      holder_plan_id: 'holder-plan',
      holder_saga_name: 'provision',
      holder_since: '2026-07-28T18:00:00Z',
    });
  });

  it('increments repeated contention without replacing its start time', () => {
    const initial = recordLockContention(null, 'device:abc', 1_000);
    const repeated = recordLockContention(initial, 'device:abc', 1_010, {
      plan_id: 'next-holder',
      saga_name: 'deprovision',
      acquired_at: '2026-07-28T18:01:00Z',
    });

    expect(repeated.first_blocked_at).toBe(1_000);
    expect(repeated.attempts).toBe(2);
    expect(repeated.holder_plan_id).toBe('next-holder');
    expect(repeated.holder_saga_name).toBe('deprovision');
  });

  it('starts a new contention clock when the lock key changes', () => {
    const initial = recordLockContention(null, 'device:1', 1_000);
    const changed = recordLockContention(initial, 'device:2', 1_059);

    expect(changed.first_blocked_at).toBe(1_059);
    expect(changed.attempts).toBe(1);
    expect(changed.lock_key).toBe('device:2');
  });

  it('serializes and parses valid Redis state', () => {
    const state = recordLockContention(null, 'device:abc', 1_000);
    const serialized = serializeLockWaitState(state);

    expect(serialized).toBe(
      '{"first_deferred_at":1000,"first_blocked_at":1000,"attempts":1,"reason":"lock_contention","lock_key":"device:abc","last_notified_at":0}',
    );
    expect(parseLockWaitState(serialized)).toEqual(state);
  });

  it.each([
    null,
    'not-json',
    '[]',
    '{}',
    '{"first_blocked_at":"old","attempts":1,"lock_key":"device:abc","last_notified_at":0}',
    '{"first_blocked_at":1000,"attempts":"1","lock_key":"device:abc","last_notified_at":0}',
    '{"first_blocked_at":1000,"attempts":1,"lock_key":"","last_notified_at":0}',
    '{"first_blocked_at":1000,"attempts":1,"lock_key":"device:abc","last_notified_at":-1}',
  ])('rejects malformed Redis state safely', (raw) => {
    expect(parseLockWaitState(raw)).toBeNull();
  });
});

describe('lock-wait policy', () => {
  it.each([
    [0, 3_600],
    [120, 3_600],
    [7_200, 7_500],
  ])('calculates a bounded TTL for a %i-second hard cap', (hardCap, expected) => {
    expect(calculateLockWaitTtlSeconds(hardCap)).toBe(expected);
  });

  it.each([
    [59, null],
    [60, 60],
    [299, 60],
    [300, 300],
    [1_799, 300],
    [1_800, 1_800],
    [10_000, 1_800],
  ])('selects the notification cadence at %i seconds', (elapsed, expected) => {
    expect(selectLockWaitNotificationIntervalSeconds(elapsed)).toBe(expected);
  });

  it('uses the active cadence and tracks the last notification timestamp', () => {
    const state = recordLockContention(null, 'device:abc', 1_000);

    expect(shouldNotifyLockWait(state, 1_059, 60)).toBe(false);
    expect(shouldNotifyLockWait(state, 1_060, 60)).toBe(true);

    const notified = markLockWaitNotified(state, 1_060);
    expect(notified.last_notified_at).toBe(1_060);
    expect(shouldNotifyLockWait(notified, 1_119, 60)).toBe(false);
    expect(shouldNotifyLockWait(notified, 1_120, 60)).toBe(true);
  });

  it('uses the previous interval when the notification tier changes', () => {
    let state = recordLockContention(null, 'device:abc', 1_000);

    for (const elapsed of [60, 120, 180, 240]) {
      expect(shouldNotifyLockWait(state, 1_000 + elapsed, 60)).toBe(true);
      state = markLockWaitNotified(state, 1_000 + elapsed);
    }

    expect(shouldNotifyLockWait(state, 1_299, 60)).toBe(false);
    expect(shouldNotifyLockWait(state, 1_300, 60)).toBe(true);
  });

  it('treats zero as disabled and enforces a strict positive hard cap', () => {
    const state = recordLockContention(null, 'device:abc', 1_000);

    expect(isLockWaitHardCapExceeded(state, 2_000, 0)).toBe(false);
    expect(isLockWaitHardCapExceeded(state, 1_120, 120)).toBe(false);
    expect(isLockWaitHardCapExceeded(state, 1_121, 120)).toBe(true);
  });
});
