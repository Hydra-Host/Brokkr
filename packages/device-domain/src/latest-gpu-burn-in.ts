import { ActiveRecordRegistry } from '@repo/active-record';
import { DeviceTestRun, DeviceTestStatus, DeviceTestType } from '@repo/database';

/** Workaround for https://github.com/prisma/prisma/issues/28740 — Prisma 7 drops LIMIT from nested `take` includes, so the naive include loads every historical run. */
async function loadLatestGpuBurnInRunsByDeviceId(deviceIds: string[]): Promise<Map<string, DeviceTestRun>> {
  if (deviceIds.length === 0) {
    return new Map();
  }

  const client = ActiveRecordRegistry.client;

  const rows = await client.$queryRaw<DeviceTestRun[]>`
    SELECT DISTINCT ON ("deviceId") *
    FROM "DeviceTestRun"
    WHERE "type" = ${DeviceTestType.GpuBurnIn}::"DeviceTestType"
      AND "status" = ${DeviceTestStatus.Completed}::"DeviceTestStatus"
      AND "deviceId" = ANY(${deviceIds}::text[])
    ORDER BY "deviceId", "endTime" DESC NULLS LAST
  `;

  return new Map(rows.map((row) => [row.deviceId, row]));
}

export async function attachLatestGpuBurnInRuns<T extends { id: string; deviceTestRuns?: DeviceTestRun[] }>(
  devices: T[],
): Promise<void> {
  if (devices.length === 0) return;

  const latestByDeviceId = await loadLatestGpuBurnInRunsByDeviceId(devices.map((d) => d.id));

  for (const device of devices) {
    const latest = latestByDeviceId.get(device.id);
    device.deviceTestRuns = latest ? [latest] : [];
  }
}
