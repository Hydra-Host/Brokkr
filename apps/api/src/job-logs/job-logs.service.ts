import { HttpException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { LifecycleJobRecord } from '@repo/lifecycle';
import { type Redis } from 'ioredis';
import { DeviceContextService } from 'src/brokkr-bridge/device-context.service';
import { ContextService } from 'src/common/context/context.service';
import { Logger } from 'src/common/decorators/logger.decorator';
import { REDIS_CLIENT } from 'src/common/redis';
import { REDIS_KEYS } from 'src/common/redis/redis-keys';
import { LoggerService } from 'src/logger/logger.service';
import { PrismaClient } from 'src/prisma/prisma.client';
import { z } from 'zod';

export const jobLogStreamEntrySchema = z.object({
  timestamp: z.string(),
  log_level: z.string(),
  message: z.string(),
  app_name: z.string(),
  app_class_name: z.string(),
});

@Injectable()
export class JobLogsService {
  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly prisma: PrismaClient,
    private readonly deviceContext: DeviceContextService,
    private readonly contextService: ContextService,
    @Logger(JobLogsService.name) private readonly logger: LoggerService,
  ) {}

  private gate(): void {
    this.contextService.requireInstanceOperator();
    this.contextService.requirePermission('job-log', 'access');
  }

  async getJobLogs(jobId: string, query: { cursor?: string; limit: number }) {
    this.gate();

    const deviceId = await this.resolveJobDeviceId(jobId);
    const zoneId = await this.resolveZoneId(deviceId);
    const key = REDIS_KEYS.jobLogs(zoneId, jobId);
    const start = query.cursor ? `(${query.cursor}` : '-';
    const raw = await this.redis.xrange(key, start, '+', 'COUNT', query.limit);

    const entries = raw.flatMap(([id, fields]) => {
      const parsed = jobLogStreamEntrySchema.safeParse(fieldArrayToRecord(fields));
      if (!parsed.success) {
        this.logger.warn(`Dropping malformed job log entry ${id} for job ${jobId}: ${parsed.error.message}`);
        return [];
      }
      return [
        {
          id,
          timestamp: parsed.data.timestamp,
          logLevel: parsed.data.log_level,
          message: parsed.data.message,
          appName: parsed.data.app_name,
          appClassName: parsed.data.app_class_name,
        },
      ];
    });

    const nextCursor = raw.length === query.limit ? raw[raw.length - 1][0] : null;
    const audit = this.contextService.buildAuditPayload();
    this.logger.log(`Job logs read: job=${jobId} actor=${audit.triggeredBy}`);
    return { entries, nextCursor };
  }

  async listDeviceJobs(deviceId: string) {
    this.gate();

    const device = await this.prisma.device.findUnique({ where: { id: deviceId }, select: { id: true } });
    if (!device) {
      throw new NotFoundException('Device not found');
    }

    const lifecycleJobs: LifecycleJobRecord[] = await LifecycleJobRecord.findManyUnscoped({
      where: { deviceId },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    const legacyJobs = await this.prisma.job.findMany({
      where: { deviceId },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });

    const jobs = [
      ...lifecycleJobs.map((job) => ({
        id: job.data.id,
        jobType: job.data.jobType,
        status: job.data.phase,
        createdAt: job.data.createdAt,
        error: job.data.error,
      })),
      ...legacyJobs.map((job) => ({
        id: job.id,
        jobType: job.jobType,
        status: job.status,
        createdAt: job.createdAt,
        error: job.error,
      })),
    ]
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, 100);

    return {
      jobs: jobs.map((job) => ({
        id: job.id,
        jobType: job.jobType,
        status: job.status,
        createdAt: job.createdAt.toISOString(),
        error: job.error,
      })),
    };
  }

  private async resolveJobDeviceId(jobId: string): Promise<string> {
    const lifecycleJob: LifecycleJobRecord | null = await LifecycleJobRecord.findByIdUnscoped(jobId);
    if (lifecycleJob?.data.deviceId) {
      return lifecycleJob.data.deviceId;
    }
    const legacyJob = await this.prisma.job.findUnique({
      where: { id: jobId },
      select: { deviceId: true },
    });
    if (legacyJob?.deviceId) {
      return legacyJob.deviceId;
    }
    throw new NotFoundException('Job not found');
  }

  private async resolveZoneId(deviceId: string): Promise<string> {
    try {
      const ctx = await this.deviceContext.resolveZoneContext(deviceId);
      return ctx.zoneId;
    } catch (error) {
      if (error instanceof HttpException) {
        throw new NotFoundException('Job not found');
      }
      throw error;
    }
  }
}

function fieldArrayToRecord(fields: string[]): Record<string, string> {
  const record: Record<string, string> = {};
  for (let i = 0; i + 1 < fields.length; i += 2) {
    record[fields[i]] = fields[i + 1];
  }
  return record;
}
