import { describe, expect, it } from 'vitest';

import { deviceSagaLock, scanSagaLock } from '../../common/redis/redis-keys';
import { LOCKLESS_SAGAS } from '../bullmq.types';
import { resolveLockKey } from '../saga-lock';

const LOCKLESS_SAGA = 'device_health_check';
const LOCKING_SAGA = 'provision';

describe('resolveLockKey', () => {
  it('LOCKLESS_SAGA is a real member of LOCKLESS_SAGAS', () => {
    expect(LOCKLESS_SAGAS.has(LOCKLESS_SAGA)).toBe(true);
    expect(LOCKLESS_SAGAS.has(LOCKING_SAGA)).toBe(false);
  });

  it('returns null for a lockless saga regardless of payload', () => {
    expect(resolveLockKey(LOCKLESS_SAGA, { device_id: 'dev-1' })).toBeNull();
  });

  it('locks on device_id for a non-lockless saga', () => {
    expect(resolveLockKey(LOCKING_SAGA, { device_id: 'dev-1' })).toBe(deviceSagaLock('dev-1'));
  });

  it('coerces a numeric device_id via String() before keying', () => {
    expect(resolveLockKey(LOCKING_SAGA, { device_id: 99 })).toBe(deviceSagaLock(String(99)));
  });

  it('falls through to subnet when device_id is absent', () => {
    expect(resolveLockKey(LOCKING_SAGA, { subnet: '10.0.0.0/24' })).toBe(scanSagaLock('10.0.0.0/24'));
  });

  it('returns null when neither device_id nor subnet is present', () => {
    expect(resolveLockKey(LOCKING_SAGA, {})).toBeNull();
  });

  it.each([
    ['zero', 0],
    ['empty string', ''],
    ['false', false],
    ['null', null],
    ['empty array', []],
    ['empty object', {}],
  ])('does not lock on device_id when it is %s (falls through to subnet)', (_label, deviceId) => {
    expect(resolveLockKey(LOCKING_SAGA, { device_id: deviceId, subnet: '10.0.0.0/24' })).toBe(
      scanSagaLock('10.0.0.0/24'),
    );
  });

  it.each([
    ['zero', 0],
    ['empty string', ''],
    ['false', false],
    ['null', null],
    ['empty array', []],
    ['empty object', {}],
  ])('returns null when device_id is %s and no subnet is present', (_label, deviceId) => {
    expect(resolveLockKey(LOCKING_SAGA, { device_id: deviceId })).toBeNull();
  });
});
