import { type DeviceHealthSnapshot, DeviceHealthSnapshotSchema } from '@repo/api-client';
import { deviceRedisKeys } from './redis-keys';

export interface SnapshotRedis {
  get(key: string): Promise<string | null>;
}

export class HealthSnapshotReader {
  constructor(private readonly redis: SnapshotRedis) {}

  // a missing or malformed snapshot has no live value; the caller falls back to the newest history row
  async read(zoneId: string, deviceId: string): Promise<DeviceHealthSnapshot | null> {
    const raw = await this.redis.get(deviceRedisKeys.deviceHealthSnapshot(zoneId, deviceId));
    if (raw === null) return null;
    const parsed = DeviceHealthSnapshotSchema.safeParse(parseJson(raw));
    return parsed.success ? parsed.data : null;
  }
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
