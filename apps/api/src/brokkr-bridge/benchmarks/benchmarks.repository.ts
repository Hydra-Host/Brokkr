import { Injectable } from '@nestjs/common';
import { DeviceTestType, Prisma } from '@repo/database';
import { PrismaClient } from 'src/prisma/prisma.client';
import { latestDeviceTestRunRowSchema, type LatestDeviceTestRunRow } from './benchmarks.types';

@Injectable()
export class BenchmarksRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async createRunningDeviceTestRun(deviceId: string, type: DeviceTestType) {
    return this.prisma.deviceTestRun.create({
      data: {
        device: { connect: { id: deviceId } },
        type,
        status: 'Running',
      },
    });
  }

  async getLatestDeviceTestRunForDevice(deviceId: string): Promise<LatestDeviceTestRunRow | null> {
    const rows = await this.prisma.$queryRaw<Array<Record<string, Prisma.JsonValue | Date | null>>>`
    SELECT dtr.*, LOWER(d."status"::text) as "deviceStatus", d."role"::text as "role", d."zoneId"
    FROM "Device" d
    LEFT JOIN LATERAL (
      SELECT *
      FROM "DeviceTestRun"
      WHERE "deviceId" = d."id"
      ORDER BY "createdAt" DESC
      LIMIT 1
    ) dtr ON true
    WHERE d."id" = ${deviceId}
    LIMIT 1
    `;

    const [row] = rows;
    if (!row) {
      return null;
    }

    return latestDeviceTestRunRowSchema.parse(row);
  }
}
