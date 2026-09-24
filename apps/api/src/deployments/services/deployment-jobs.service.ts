import { Injectable, NotFoundException } from '@nestjs/common';
import { LIFECYCLE_JOB_EVENT_CAP, type LifecycleJobEventsResponse, type LifecycleJobSummary } from '@repo/api-client';
import type { PaginatedResult, PaginationQuery } from '@repo/database/pagination';
import {
  LifecycleJobRecord,
  readJobEvents,
  toCustomerJobEvent,
  toCustomerJobSummary,
  toLifecycleJobSummary,
} from '@repo/lifecycle';
import { DeploymentRecord } from '../deployment.record';

@Injectable()
export class DeploymentJobsService {
  async list(deploymentId: string, query: PaginationQuery): Promise<PaginatedResult<LifecycleJobSummary>> {
    await this.pin(deploymentId);
    const page = await LifecycleJobRecord.findPageByTargetUnscoped(query, { deploymentId });
    return { ...page, data: page.data.map((row) => toCustomerJobSummary(toLifecycleJobSummary(row))) };
  }

  async events(deploymentId: string, jobId: string): Promise<LifecycleJobEventsResponse> {
    await this.pin(deploymentId);
    const job: LifecycleJobRecord | null = await LifecycleJobRecord.findOneUnscoped({
      where: { id: jobId, deploymentId },
    });
    if (!job) throw new NotFoundException('Job not found');

    const { events, truncated } = await readJobEvents(jobId, LIFECYCLE_JOB_EVENT_CAP);
    return { data: events.map(toCustomerJobEvent), meta: { truncated, cap: LIFECYCLE_JOB_EVENT_CAP } };
  }

  // the deployment lookup is the authorization boundary; the job's tenant is whoever requested it, not the reader
  private async pin(deploymentId: string): Promise<void> {
    if (!(await DeploymentRecord.findActiveById(deploymentId))) {
      throw new NotFoundException('Deployment not found');
    }
  }
}
