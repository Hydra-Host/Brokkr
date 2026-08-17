import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { sleep } from '@repo/utils';
import { Job } from 'bullmq';
import { Logger } from 'src/common/decorators/logger.decorator';
import { type SealedSecretEnvelope } from 'src/device-secret/device-secret.service';
import { LoggerService } from 'src/logger/logger.service';
import { z } from 'zod';
import { bmcSecretDispatchFields, DeviceContextService } from '../device-context.service';
import { type LifecycleJobData, BridgeQueueService } from '../queue/bridge-queue.service';
import { type SagaName } from '../queue/bridge-queue.types';

const PICKUP_TIMEOUT_MS = 120_000;
const COMPLETION_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 1_000;

const planReturnValueSchema = z.object({ status: z.string() });

@Injectable()
export class BridgePowerControlService {
  constructor(
    private readonly bridgeQueueService: BridgeQueueService,
    private readonly deviceContext: DeviceContextService,
    @Logger(BridgePowerControlService.name)
    private readonly logger: LoggerService,
  ) {}

  async rebootDevice(deviceId: string, jobId: string, options?: { bootDevice?: string; bootTarget?: string }) {
    this.logger.log(`Resolving device context for reboot of device ${deviceId}`, jobId);

    const ctx = await this.deviceContext.resolve(deviceId);

    await this.enqueueWithPickupCheck(
      ctx.zoneId,
      'reboot',
      jobId,
      {
        device_id: ctx.device.id,
        bmc_ip: ctx.bmcIp,
        ...bmcSecretDispatchFields(ctx.bmcSecret),
        boot_device: options?.bootDevice ?? ctx.device.ipmiBootDeviceOverride ?? 'pxe',
        boot_target: options?.bootTarget ?? 'os',
      },
      ctx.device.id,
    );

    return { success: true as const, plan_id: jobId };
  }

  async powerOnDevice(deviceId: string, jobId: string, options?: { bootDevice?: string; bootTarget?: string }) {
    this.logger.log(`Resolving device context for power on of device ${deviceId}`, jobId);

    const ctx = await this.deviceContext.resolve(deviceId);

    await this.enqueueWithPickupCheck(
      ctx.zoneId,
      'power_on',
      jobId,
      {
        device_id: ctx.device.id,
        bmc_ip: ctx.bmcIp,
        ...bmcSecretDispatchFields(ctx.bmcSecret),
        boot_device: options?.bootDevice ?? ctx.device.ipmiBootDeviceOverride ?? 'pxe',
        boot_target: options?.bootTarget ?? 'os',
      },
      ctx.device.id,
    );

    return { success: true as const, plan_id: jobId };
  }

  async powerOffDevice(deviceId: string, jobId: string) {
    this.logger.log(`Resolving device context for power off of device ${deviceId}`, jobId);

    const ctx = await this.deviceContext.resolve(deviceId);

    await this.enqueueWithPickupCheck(
      ctx.zoneId,
      'power_off',
      jobId,
      {
        device_id: ctx.device.id,
        bmc_ip: ctx.bmcIp,
        ...bmcSecretDispatchFields(ctx.bmcSecret),
      },
      ctx.device.id,
    );

    return { success: true as const, plan_id: jobId };
  }

  async checkPowerStatus(
    zoneId: string,
    bmcIp: string,
    bmcSecret: SealedSecretEnvelope,
    jobId: string,
  ): Promise<Job<LifecycleJobData>> {
    return this.enqueueWithPickupCheck(zoneId, 'power_status', jobId, {
      device_id: jobId,
      bmc_ip: bmcIp,
      ...bmcSecretDispatchFields(bmcSecret),
    });
  }

  async waitForJobCompletion(
    bullmqJob: Job<LifecycleJobData>,
    zoneId: string,
    timeoutMs: number = COMPLETION_TIMEOUT_MS,
  ): Promise<'completed' | 'failed'> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const state = await bullmqJob.getState();
      if (state === 'failed') return 'failed';
      if (state === 'completed')
        return (await this.resolvePlanStatus(bullmqJob, zoneId)) === 'complete' ? 'completed' : 'failed';
      await sleep(POLL_INTERVAL_MS);
    }

    throw new HttpException(
      `Job ${bullmqJob.id} did not complete within ${timeoutMs / 1000}s`,
      HttpStatus.GATEWAY_TIMEOUT,
    );
  }

  private async resolvePlanStatus(bullmqJob: Job<LifecycleJobData>, zoneId: string): Promise<string> {
    const jobId = bullmqJob.id;
    const fresh = jobId ? await this.bridgeQueueService.getLifecycleQueue(zoneId).getJob(jobId) : null;
    const parsed = planReturnValueSchema.safeParse(fresh?.returnvalue ?? bullmqJob.returnvalue);
    return parsed.success ? parsed.data.status : 'unknown';
  }

  private async enqueueWithPickupCheck(
    zoneId: string,
    sagaName: SagaName,
    jobId: string,
    payload: Record<string, unknown>,
    bullmqDeviceKey?: string,
  ): Promise<Job<LifecycleJobData>> {
    const deviceId = bullmqDeviceKey ?? String(payload.device_id);

    this.logger.log(`Enqueuing ${sagaName} saga for device ${deviceId}`, jobId);

    const bullmqJob = await this.bridgeQueueService.enqueueSagaJob(zoneId, sagaName, jobId, payload, deviceId);

    this.logger.log(`${sagaName} saga enqueued: planId=${jobId}, bullmqJobId=${bullmqJob.id}`, jobId);

    const queue = this.bridgeQueueService.getLifecycleQueue(zoneId);
    const deadline = Date.now() + PICKUP_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const state = await bullmqJob.getState();
      if (state === 'active' || state === 'completed') {
        this.logger.log(`${sagaName} job picked up by bridge (state=${state})`, jobId);
        return bullmqJob;
      }
      if (state === 'failed') {
        this.logger.error(`${sagaName} job failed immediately after pickup`, undefined, jobId);
        throw new HttpException(`${sagaName} job failed immediately after bridge pickup`, HttpStatus.BAD_GATEWAY);
      }
      if (state === 'delayed') {
        const fresh = bullmqJob.id ? await queue.getJob(bullmqJob.id) : null;
        if (fresh?.processedOn != null) {
          this.logger.log(
            `${sagaName} job rescheduled by bridge for lock contention (processedOn=${fresh.processedOn}, attempts=${fresh.attemptsMade}) — accepting as picked up`,
            jobId,
          );
          return fresh;
        }
      }
      await sleep(POLL_INTERVAL_MS);
    }

    const finalState = await bullmqJob.getState();
    if (finalState === 'active' || finalState === 'completed') {
      this.logger.log(`${sagaName} job picked up by bridge (state=${finalState})`, jobId);
      return bullmqJob;
    }
    if (finalState === 'failed') {
      this.logger.error(`${sagaName} job failed immediately after pickup`, undefined, jobId);
      throw new HttpException(`${sagaName} job failed immediately after bridge pickup`, HttpStatus.BAD_GATEWAY);
    }
    if (finalState === 'delayed') {
      const fresh = bullmqJob.id ? await queue.getJob(bullmqJob.id) : null;
      if (fresh?.processedOn != null) {
        this.logger.log(
          `${sagaName} job rescheduled by bridge for lock contention (processedOn=${fresh.processedOn}, attempts=${fresh.attemptsMade}) — accepting as picked up`,
          jobId,
        );
        return fresh;
      }
    }

    try {
      await bullmqJob.remove();
    } catch {
      const state = await bullmqJob.getState().catch(() => undefined);
      if (state === 'active' || state === 'completed') {
        this.logger.log(`${sagaName} job was picked up while removal was attempted`, jobId);
        return bullmqJob;
      }
      if (state === 'failed') {
        throw new HttpException(`${sagaName} job failed immediately after bridge pickup`, HttpStatus.BAD_GATEWAY);
      }
      if (state === 'delayed') {
        const fresh = bullmqJob.id ? await queue.getJob(bullmqJob.id).catch(() => null) : null;
        if (fresh?.processedOn != null) {
          this.logger.log(`${sagaName} job was picked up while removal was attempted`, jobId);
          return fresh;
        }
      }
    }

    this.logger.error(
      `${sagaName} job not picked up within ${PICKUP_TIMEOUT_MS}ms — bridge may be offline`,
      undefined,
      jobId,
    );
    throw new HttpException(
      `Bridge did not pick up ${sagaName} job within ${PICKUP_TIMEOUT_MS / 1000}s — bridge may be offline`,
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  }
}
