import { HttpException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { type JobLogsResponse } from '@repo/api-client';
import { type JobLogStream, JobLogStreamReader, LifecycleJobRecord } from '@repo/lifecycle';
import { DeviceContextService } from 'src/brokkr-bridge/device-context.service';
import { resolvePlanDeviceId } from 'src/brokkr-bridge/job-logs/plan-device-id';
import { ContextService } from 'src/common/context/context.service';
import { Logger } from 'src/common/decorators/logger.decorator';
import { REDIS_CLIENT } from 'src/common/redis';
import { LoggerService } from 'src/logger/logger.service';
import { PrismaClient } from 'src/prisma/prisma.client';

export { jobLogStreamEntrySchema } from '@repo/lifecycle';

@Injectable()
export class JobLogsService {
  private readonly reader: JobLogStreamReader;

  constructor(
    @Inject(REDIS_CLIENT) redis: JobLogStream,
    @Inject(PrismaClient) private readonly prisma: Pick<PrismaClient, 'device' | 'job'>,
    @Inject(DeviceContextService)
    private readonly deviceContext: Pick<DeviceContextService, 'resolveZoneContext'>,
    @Inject(ContextService)
    private readonly contextService: Pick<
      ContextService,
      'requireInstanceOperator' | 'requirePermission' | 'buildAuditPayload'
    >,
    @Logger(JobLogsService.name) private readonly logger: Pick<LoggerService, 'log' | 'warn'>,
  ) {
    this.reader = new JobLogStreamReader(redis, logger);
  }

  private gate(): void {
    this.contextService.requireInstanceOperator();
    this.contextService.requirePermission('job-log', 'access');
  }

  async getJobLogs(jobId: string, query: { cursor?: string; limit: number }): Promise<JobLogsResponse> {
    this.gate();

    const deviceId = await this.resolveJobDeviceId(jobId);
    const zoneId = await this.resolveZoneId(deviceId);
    const page = await this.reader.readPage(zoneId, jobId, query.cursor, query.limit);
    const audit = this.contextService.buildAuditPayload();
    this.logger.log(`Job logs read: job=${jobId} actor=${audit.triggeredBy}`);
    return page;
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
    const deviceId = await resolvePlanDeviceId(this.prisma, jobId);
    if (!deviceId) {
      throw new NotFoundException('Job not found');
    }
    return deviceId;
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
