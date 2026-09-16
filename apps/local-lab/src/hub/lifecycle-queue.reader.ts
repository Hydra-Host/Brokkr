import { Injectable, Logger } from '@nestjs/common';

import { getErrorMessage } from '@repo/utils';
import type { LifecycleQueueJoin, LifecycleQueueMatch, QueueRef } from '../contract';
import { QueueJobsService } from '../queues/queue-jobs.service';
import { QueueRegistryService } from '../queues/queue-registry.service';
import { LifecycleJobsReaderService } from './lifecycle-jobs.reader';

// the discovery scan is per device, not per plan, so this only has to be wide enough to hold one
// device's jobs across its saga queues — the reader's own cap still governs what it can reach
const JOIN_PAGE = 200;

@Injectable()
export class LifecycleQueueReaderService {
  private readonly log = new Logger(LifecycleQueueReaderService.name);

  constructor(
    private readonly jobs: LifecycleJobsReaderService,
    private readonly registry: QueueRegistryService,
    private readonly queueJobs: QueueJobsService,
  ) {}

  async forJob(jobId: string): Promise<LifecycleQueueJoin> {
    const detail = await this.jobs.get(jobId);
    const deviceId = detail.job?.deviceId ?? null;

    if (detail.job === null) {
      return this.unjoinable(null, 'no lifecycle job carries this id');
    }
    // the id embeds the device uuid, the only key the scan can match — so a job scoped to no device
    // has nothing to search on, which is not the same as finding none
    if (deviceId === null) {
      return this.unjoinable(null, 'this lifecycle job is not scoped to a device, so its queue jobs cannot be found');
    }

    const saga = (await this.registry.inventory()).filter((ref) => ref.kind === 'saga');
    const matches: LifecycleQueueMatch[] = [];
    const searchedQueues: QueueRef[] = [];
    let discoveryCapped = false;
    let readError: string | null = null;

    for (const ref of saga) {
      try {
        const page = await this.queueJobs.list(ref.prefix, ref.name, {
          states: [],
          limit: JOIN_PAGE,
          offset: 0,
          deviceId,
        });
        if (page === null) continue;
        searchedQueues.push(ref);
        if (page.discoveryCapped) discoveryCapped = true;
        for (const job of page.jobs) {
          if (job.planId === jobId) matches.push({ queue: ref, job });
        }
      } catch (error) {
        // one unreadable queue must not present the others' matches as the whole answer
        readError = getErrorMessage(error);
        this.log.debug(`lifecycle queue join failed on ${ref.prefix}:${ref.name}: ${readError}`);
      }
    }

    return { joinable: true, unjoinableReason: null, deviceId, matches, searchedQueues, discoveryCapped, readError };
  }

  private unjoinable(deviceId: string | null, reason: string): LifecycleQueueJoin {
    return {
      joinable: false,
      unjoinableReason: reason,
      deviceId,
      matches: [],
      searchedQueues: [],
      discoveryCapped: false,
      readError: null,
    };
  }
}
