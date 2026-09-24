import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { type JobSolLogsQuery, type JobSolLogsResponse } from '@repo/api-client';
import { LifecycleJobRecord } from '@repo/lifecycle';
import { DeviceContextService } from 'src/brokkr-bridge/device-context.service';
import { SolLogService } from 'src/brokkr-bridge/sol-logs/sol-log.service';
import { ContextService } from 'src/common/context/context.service';
import { Logger } from 'src/common/decorators/logger.decorator';
import { LoggerService } from 'src/logger/logger.service';

export const DEVICE_PIN = Symbol('DEVICE_PIN');

export interface DevicePin {
  findByDeviceIdOrThrow(deviceId: string): Promise<unknown>;
}

@Injectable()
export class JobSolLogsService {
  constructor(
    @Inject(DEVICE_PIN) private readonly devicePin: DevicePin,
    @Inject(DeviceContextService)
    private readonly deviceContext: Pick<DeviceContextService, 'resolveZoneContext'>,
    @Inject(ContextService)
    private readonly contextService: Pick<
      ContextService,
      'requirePermission' | 'requireInstanceOperator' | 'buildAuditPayload'
    >,
    @Inject(SolLogService) private readonly solLogs: Pick<SolLogService, 'getLogsPage'>,
    @Logger(JobSolLogsService.name) private readonly logger: Pick<LoggerService, 'log'>,
  ) {}

  async getJobSolLogs(deviceId: string, jobId: string, query: JobSolLogsQuery): Promise<JobSolLogsResponse> {
    this.contextService.requirePermission('job-log', 'access');
    this.contextService.requireInstanceOperator();

    // the device pin runs before the job lookup so an unknown device never reveals whether the job exists
    await this.devicePin.findByDeviceIdOrThrow(deviceId);
    const job: LifecycleJobRecord | null = await LifecycleJobRecord.findByIdUnscoped(jobId);
    if (!job || job.data.deviceId !== deviceId) {
      throw new NotFoundException('Job not found');
    }

    const { zoneId } = await this.deviceContext.resolveZoneContext(deviceId);
    const page = await this.solLogs.getLogsPage(zoneId, jobId, query.cursor, query.limit);
    const audit = this.contextService.buildAuditPayload();
    this.logger.log(`Job sol logs read: device=${deviceId} job=${jobId} actor=${audit.triggeredBy}`);
    return page;
  }
}
