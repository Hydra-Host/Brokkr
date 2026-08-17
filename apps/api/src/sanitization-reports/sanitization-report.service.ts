import { Injectable } from '@nestjs/common';
import { Prisma } from '@repo/database';
import type { SanitizationReport } from 'src/brokkr-bridge/types/queue.types';
import { Logger } from 'src/common/decorators/logger.decorator';
import { LoggerService } from 'src/logger/logger.service';
import { PrismaClient } from 'src/prisma/prisma.client';

@Injectable()
export class SanitizationReportService {
  @Logger()
  private readonly logger!: LoggerService;

  constructor(private prisma: PrismaClient) {}

  async createFromStepResult(
    deviceId: string,
    actionType: string,
    report: SanitizationReport,
    planId?: string,
  ): Promise<void> {
    const device = await this.prisma.device.findUnique({
      where: { id: deviceId, deletedAt: null },
      select: { id: true },
    });

    if (!device) {
      this.logger.warn(`Cannot persist sanitization report: no device found for id ${deviceId}`);
      return;
    }

    const jobId = report.job_id ?? planId ?? `unknown-${deviceId}`;
    const overallResult = report.overall_result ?? 'fail';
    const mode = report.mode ?? 'full';

    // An unparseable timestamp must NOT drop the audit record — fall back to now.
    const parseOr = (value: string | undefined, fallback: Date): Date => {
      if (value === undefined) return fallback;
      const d = new Date(value);
      return Number.isNaN(d.getTime()) ? fallback : d;
    };
    const now = new Date();
    const startedAt = parseOr(report.started_at, now);
    const completedAt = parseOr(report.completed_at, now);

    const row = {
      deviceId: device.id,
      jobId,
      actionType,
      mode,
      result: overallResult,
      startedAt,
      completedAt,
      duration: report.duration_seconds ?? 0,
      report: report as unknown as Prisma.InputJsonValue,
    };
    await this.prisma.sanitizationReport.upsert({
      where: { deviceId_jobId: { deviceId: device.id, jobId } },
      create: row,
      update: overallResult === 'pass' ? row : {},
    });

    this.logger.log(
      `Sanitization report persisted for device ${device.id} (action=${actionType}, result=${overallResult}, job=${jobId})`,
    );
  }
}
