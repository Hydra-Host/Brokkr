import { deviceSagaLock, scanSagaLock } from '../common/redis/redis-keys';
import { coerceEnvelopeId, hasEnvelopeId } from '../saga-framework/dispatch-payload';

import { LOCKLESS_SAGAS } from './bullmq.types';

export function resolveLockKey(sagaName: string, payload: Record<string, unknown>): string | null {
  if (LOCKLESS_SAGAS.has(sagaName)) {
    return null;
  }

  const deviceId = coerceEnvelopeId(payload.device_id);
  if (hasEnvelopeId(deviceId)) {
    return deviceSagaLock(String(deviceId));
  }

  const subnet = coerceEnvelopeId(payload.subnet);
  if (hasEnvelopeId(subnet)) {
    return scanSagaLock(String(subnet));
  }

  return null;
}
