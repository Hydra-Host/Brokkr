import { BadRequestException, Injectable } from '@nestjs/common';
import type { LifecycleJobSummary, ListLifecycleJobsQuery } from '@repo/api-client';
import type { LifecycleJob } from '@repo/database';
import type { PaginatedResult } from '@repo/database/pagination';
import { LifecycleJobRecord, TERMINAL_PHASES } from '@repo/lifecycle';
import { ContextService } from 'src/common/context/context.service';

@Injectable()
export class JobsService {
  constructor(private readonly contextService: ContextService) {}

  async list(query: ListLifecycleJobsQuery): Promise<PaginatedResult<LifecycleJobSummary>> {
    this.contextService.requirePermission('job', 'read');
    this.contextService.requireInstanceOperator();

    const { deviceId, deploymentId, ...paginationQuery } = query;
    if (!deviceId && !deploymentId) {
      throw new BadRequestException('deviceId or deploymentId is required');
    }

    const page = await LifecycleJobRecord.findPageByTargetUnscoped(paginationQuery, { deviceId, deploymentId });
    return { ...page, data: page.data.map(toSummary) };
  }
}

function toSummary(row: LifecycleJob): LifecycleJobSummary {
  return {
    id: row.id,
    jobType: row.jobType,
    phase: row.phase,
    deviceId: row.deviceId,
    deploymentId: row.deploymentId,
    source: row.source,
    performedBy: row.performedBy,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
    completedAt: TERMINAL_PHASES.has(row.phase) ? row.updatedAt.toISOString() : null,
  };
}
