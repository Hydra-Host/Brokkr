import { Controller } from '@nestjs/common';
import { TsRestHandler, tsRestHandler } from '@ts-rest/nest';

import { LabRoute } from '../common/lab-route';
import { contract } from '../contract';
import { QueueJobsService } from './queue-jobs.service';
import { QueueMutationsService } from './queue-mutations.service';
import { QueueRegistryService } from './queue-registry.service';

@Controller()
export class QueuesController {
  constructor(
    private readonly registry: QueueRegistryService,
    private readonly jobs: QueueJobsService,
    private readonly mutations: QueueMutationsService,
  ) {}

  @TsRestHandler(contract.listQueues)
  listQueues() {
    return tsRestHandler(contract.listQueues, async () => ({
      status: 200 as const,
      body: await this.registry.list(),
    }));
  }

  @TsRestHandler(contract.listQueueJobs)
  listQueueJobs() {
    return tsRestHandler(contract.listQueueJobs, async ({ params, query }) => {
      const page = await this.jobs.list(params.prefix, params.name, {
        states: query.states,
        limit: query.limit,
        offset: query.offset,
        deviceId: query.deviceId ?? null,
      });
      return page
        ? { status: 200 as const, body: page }
        : { status: 404 as const, body: { error: `unknown queue: ${params.prefix}:${params.name}` } };
    });
  }

  @TsRestHandler(contract.getQueueJob)
  getQueueJob() {
    return tsRestHandler(contract.getQueueJob, async ({ params }) => {
      const job = await this.jobs.get(params.prefix, params.name, params.jobId);
      return job
        ? { status: 200 as const, body: job }
        : { status: 404 as const, body: { error: `unknown job: ${params.prefix}:${params.name}:${params.jobId}` } };
    });
  }

  @TsRestHandler(contract.retryQueueJob)
  @LabRoute({ capability: 'operate' })
  retryQueueJob() {
    return tsRestHandler(contract.retryQueueJob, async ({ params, body }) => {
      const outcome = await this.mutations.retryJob(params.prefix, params.name, params.jobId, body);
      return outcome.ok
        ? { status: 200 as const, body: { runId: outcome.runId } }
        : { status: outcome.status, body: { error: outcome.error } };
    });
  }

  @TsRestHandler(contract.removeQueueJob)
  @LabRoute({ capability: 'operate' })
  removeQueueJob() {
    return tsRestHandler(contract.removeQueueJob, async ({ params }) => {
      const outcome = await this.mutations.removeJob(params.prefix, params.name, params.jobId);
      return outcome.ok
        ? { status: 200 as const, body: { runId: outcome.runId } }
        : { status: outcome.status, body: { error: outcome.error } };
    });
  }

  @TsRestHandler(contract.drainQueue)
  @LabRoute({ capability: 'operate' })
  drainQueue() {
    return tsRestHandler(contract.drainQueue, async ({ params, body }) => {
      const outcome = await this.mutations.drainQueue(params.prefix, params.name, body);
      return outcome.ok
        ? { status: 200 as const, body: { runId: outcome.runId } }
        : { status: outcome.status, body: { error: outcome.error } };
    });
  }

  @TsRestHandler(contract.cleanQueue)
  @LabRoute({ capability: 'operate' })
  cleanQueue() {
    return tsRestHandler(contract.cleanQueue, async ({ params, body }) => {
      const outcome = await this.mutations.cleanQueue(params.prefix, params.name, body);
      return outcome.ok
        ? { status: 200 as const, body: { runId: outcome.runId } }
        : { status: outcome.status, body: { error: outcome.error } };
    });
  }
}
