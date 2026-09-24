import { LifecycleJobRecord } from '@repo/lifecycle';
import { type PrismaClient } from 'src/prisma/prisma.client';

// provision, deprovision, reboot and power plan ids are LifecycleJob ids; commission and the other legacy sagas still key on Job
export async function resolvePlanDeviceId(client: Pick<PrismaClient, 'job'>, planId: string): Promise<string | null> {
  const lifecycleJob: LifecycleJobRecord | null = await LifecycleJobRecord.findByIdUnscoped(planId);
  if (lifecycleJob?.data.deviceId) {
    return lifecycleJob.data.deviceId;
  }
  const legacyJob = await client.job.findUnique({
    where: { id: planId },
    select: { deviceId: true },
  });
  return legacyJob?.deviceId ?? null;
}
