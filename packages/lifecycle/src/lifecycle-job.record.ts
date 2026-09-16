import { ActiveRecordRegistry, createActiveRecord } from '@repo/active-record';
import { LifecycleJobPhase, Prisma, type LifecycleJob } from '@repo/database';
import { paginateQuery, type PaginatedResult, type PaginationQuery } from '@repo/database/pagination';
import { lifecycleJobPaginationConfig } from './lifecycle-job.pagination';
import { LifecycleJobPersistenceSchema } from './lifecycle-job.schema';
import { assertTransition } from './lifecycle-state.machine';

/** Inbound paths (results consumer, grace timer, watchdog) have no request context — load via the `*Unscoped` finders; mutate `phase` only through the transition methods. */
export class LifecycleJobRecord extends createActiveRecord(LifecycleJobPersistenceSchema, 'lifecycleJob', {
  tenantField: 'organizationId',
}) {
  authorize(): this {
    return this.transition(LifecycleJobPhase.AUTHORIZING);
  }

  schedule(at: Date): this {
    this.assertPhase(LifecycleJobPhase.SCHEDULED);
    return this.set({ phase: LifecycleJobPhase.SCHEDULED, scheduledAt: at });
  }

  dispatch(): this {
    return this.transition(LifecycleJobPhase.DISPATCHED);
  }

  defer(): this {
    return this.transition(LifecycleJobPhase.DEFERRED);
  }

  reschedule(): this {
    return this.transition(LifecycleJobPhase.SCHEDULED);
  }

  beginRunning(): this {
    return this.transition(LifecycleJobPhase.RUNNING);
  }

  awaitPhoneHome(deadline: Date): this {
    this.assertPhase(LifecycleJobPhase.AWAITING_PHONE_HOME);
    return this.set({ phase: LifecycleJobPhase.AWAITING_PHONE_HOME, phoneHomeDeadline: deadline });
  }

  complete(): this {
    return this.transition(LifecycleJobPhase.COMPLETED);
  }

  fail(error: string): this {
    this.assertPhase(LifecycleJobPhase.FAILED);
    return this.set({ phase: LifecycleJobPhase.FAILED, error });
  }

  abort(error: string): this {
    this.assertPhase(LifecycleJobPhase.ABORTED);
    return this.set({ phase: LifecycleJobPhase.ABORTED, error });
  }

  attachDeployment(deploymentId: string): this {
    return this.set({ deploymentId });
  }

  static async claimTransition(
    jobId: string,
    from: LifecycleJobPhase,
    to: LifecycleJobPhase,
    error?: string,
  ): Promise<boolean> {
    assertTransition(from, to);
    const { count } = await ActiveRecordRegistry.client.lifecycleJob.updateMany({
      where: { id: jobId, phase: from },
      data: { phase: to, ...(error !== undefined ? { error } : {}) },
    });
    return count === 1;
  }

  static async findPageByTargetUnscoped(
    query: PaginationQuery,
    target: { deviceId?: string; deploymentId?: string },
  ): Promise<PaginatedResult<LifecycleJob>> {
    return paginateQuery<LifecycleJob>(this._unscopedDelegate(), query, lifecycleJobPaginationConfig, {
      where: {
        ...(target.deviceId ? { deviceId: target.deviceId } : {}),
        ...(target.deploymentId ? { deploymentId: target.deploymentId } : {}),
      },
    });
  }

  private transition(to: LifecycleJobPhase): this {
    this.assertPhase(to);
    return this.set({ phase: to });
  }

  private assertPhase(to: LifecycleJobPhase): void {
    assertTransition(this.data.phase, to);
  }

  static async appendEvent(data: {
    jobId: string;
    sagaName: string;
    stepName: string;
    eventType: string;
    status: string;
    result?: Prisma.InputJsonValue;
    error?: string | null;
    attempt?: number;
    occurredAt: Date;
  }): Promise<void> {
    await ActiveRecordRegistry.client.lifecycleJobEvent.createMany({
      data: [
        {
          jobId: data.jobId,
          sagaName: data.sagaName,
          stepName: data.stepName,
          eventType: data.eventType,
          status: data.status,
          result: data.result,
          error: data.error ?? null,
          attempt: data.attempt ?? 0,
          occurredAt: data.occurredAt,
        },
      ],
      skipDuplicates: true,
    });
  }
}
