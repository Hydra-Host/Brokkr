import { Injectable, NotFoundException } from '@nestjs/common';
import { LIFECYCLE_JOB_EVENT_CAP, type LifecycleJobEventsResponse } from '@repo/api-client';
import { LifecycleJobRecord, readJobEvents } from '@repo/lifecycle';
import { ContextService } from 'src/common/context/context.service';

@Injectable()
export class LifecycleJobEventsService {
  constructor(private readonly contextService: ContextService) {}

  async list(jobId: string): Promise<LifecycleJobEventsResponse> {
    this.contextService.requirePermission('job', 'read');
    this.contextService.requireInstanceOperator();

    const job = await LifecycleJobRecord.findByIdUnscoped(jobId);
    if (!job) throw new NotFoundException('Job not found');

    const { events, truncated } = await readJobEvents(jobId, LIFECYCLE_JOB_EVENT_CAP);
    return { data: events, meta: { truncated, cap: LIFECYCLE_JOB_EVENT_CAP } };
  }
}
