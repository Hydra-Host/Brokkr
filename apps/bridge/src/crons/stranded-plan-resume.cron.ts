import { getBullmqConfig } from '../bullmq/bullmq.config.js';
import { makeJobId } from '../bullmq/job-id.js';
import { BullmqQueueService } from '../bullmq/queue.service.js';
import { getLeaderService } from '../leader-election/leader-election.service.js';
import { logInfo } from '../logger/logger.service.js';
import { PlanManagerService } from '../saga-framework/plan-manager.service.js';

import { register } from './cron-registry.js';

export function registerStrandedPlanResumeCron(planManager: PlanManagerService, queue: BullmqQueueService): void {
  const config = getBullmqConfig();
  register({
    name: 'stranded_plan_resume',
    intervalMs: config.strandedPlanResumeIntervalSeconds * 1000,
    enabledWhen: () => getLeaderService()?.isLeader ?? false,
    timeoutMs: 60_000,
    run: async (signal) => {
      const plans = await planManager.scanResumablePlans({
        graceSecs: config.strandedPlanGraceSeconds,
        staleSecs: config.strandedPlanRunningStaleSeconds,
        batchSize: config.strandedPlanResumeBatchSize,
      });
      for (const plan of plans) {
        if (signal.aborted) break;
        const jobId = plan.jobId ?? makeJobId(plan.deviceId, `${plan.sagaName}-${plan.planId}`);
        if (await queue.jobExistsInQueue(jobId, plan.planId)) continue;
        if (signal.aborted) break;
        const enqueued = await queue.enqueueSagaJob({
          planId: plan.planId,
          sagaName: plan.sagaName,
          payload: plan.payload,
          deviceId: plan.deviceId,
          bridgeLocal: true,
          removeExisting: true,
        });
        if (enqueued) {
          await logInfo(`Re-enqueued stranded lifecycle plan ${plan.planId}`, {
            jobId: `cron-stranded_plan_resume`,
          });
        }
      }
    },
  });
}
