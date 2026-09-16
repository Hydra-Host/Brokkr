import { JobStatus, JobType } from '@repo/database';

/** Prisma client or interactive transaction client with job.updateMany. */
export type SettleCommissionJobClient = {
  job: {
    updateMany: (args: {
      where: {
        id: string;
        jobType: JobType;
        status?: { in: JobStatus[] };
      };
      data: {
        status: JobStatus;
        lastCompletedStep?: string | null;
        error?: string | null;
      };
    }) => Promise<{ count: number }>;
  };
};

export type SettleCommissionJobExtras = {
  lastCompletedStep?: string;
  error?: string | null;
};

/** Flip a still-open Commission Job. `jobId` is Job.id; for commission sagas Job.id == Device.id == saga plan_id. */
export async function settleCommissionJob(
  client: SettleCommissionJobClient,
  jobId: string,
  status: JobStatus,
  extras: SettleCommissionJobExtras = {},
): Promise<{ count: number }> {
  return client.job.updateMany({
    where: {
      id: jobId,
      jobType: JobType.Commission,
      status: { in: [JobStatus.Pending, JobStatus.InProgress] },
    },
    data: {
      status,
      ...(extras.lastCompletedStep !== undefined ? { lastCompletedStep: extras.lastCompletedStep } : {}),
      ...(extras.error !== undefined ? { error: extras.error } : {}),
    },
  });
}

/** Reopen a Commission Job so a retry of the same device/plan id can settle again. */
export async function resetCommissionJob(client: SettleCommissionJobClient, jobId: string): Promise<{ count: number }> {
  return client.job.updateMany({
    where: { id: jobId, jobType: JobType.Commission },
    data: { status: JobStatus.Pending, error: null, lastCompletedStep: null },
  });
}
