import { Inject, Injectable } from '@nestjs/common';
import { ServerLifecycleStatus } from '@repo/database';
import { sleep } from '@repo/utils';
import type Redis from 'ioredis';
import { Logger } from 'src/common/decorators/logger.decorator';
import { getErrorMessage } from 'src/common/error-utils';
import { REDIS_CLIENT } from 'src/common/redis';
import { REDIS_KEYS } from 'src/common/redis/redis-keys';
import { LoggerService } from 'src/logger/logger.service';
import { PrismaClient } from 'src/prisma/prisma.client';
import type { StorageLayoutData } from '../types/discovery-processors.types';
import { BridgeCommissioningService } from './commissioning.service';
import { BridgeDeprovisionService } from './deprovision.service';
import { LifecyclePreparationService } from './lifecycle-preparation.service';

@Injectable()
export class QualifyOrchestrationService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly bridgeDeprovisionService: BridgeDeprovisionService,
    private readonly bridgeCommissioningService: BridgeCommissioningService,
    private readonly lifecyclePrep: LifecyclePreparationService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Logger(QualifyOrchestrationService.name)
    private readonly logger: LoggerService,
  ) {}

  async isQualifyDevice(deviceId: string): Promise<boolean> {
    const device = await this.prisma.device.findUnique({
      where: { id: deviceId, role: null, deletedAt: null },
      select: { id: true },
    });
    return device !== null;
  }

  async handleDiscoveryCompleteForCommission(
    deviceId: string,
    zonePrefix: string,
    jobId: string,
    storageLayouts: StorageLayoutData | null,
  ): Promise<void> {
    if (!(await this.isQualifyDevice(deviceId))) {
      return;
    }

    const reclaimed = await this.prisma.server.updateMany({
      where: { deviceId, lifecycleStatus: ServerLifecycleStatus.FAILED },
      data: { lifecycleStatus: ServerLifecycleStatus.PROVISIONING },
    });
    let claimed = reclaimed.count === 1;
    if (!claimed) {
      const created = await this.prisma.server.createMany({
        data: { deviceId, lifecycleStatus: ServerLifecycleStatus.PROVISIONING },
        skipDuplicates: true,
      });
      claimed = created.count === 1;
    }
    if (!claimed) {
      return;
    }

    this.logger.log(
      `Qualify: discovery complete for commissioning device ${deviceId} — enqueuing qualify provision`,
      jobId,
    );

    if (zonePrefix) {
      try {
        await this.prisma.device.updateMany({
          where: { id: deviceId, zoneId: null },
          data: { zoneId: zonePrefix },
        });
      } catch (error) {
        this.logger.warn(`Failed to set zoneId for device ${deviceId}: ${getErrorMessage(error)}`, jobId);
      }
    }

    try {
      const qualifyJobId = crypto.randomUUID();
      await this.bridgeCommissioningService.enqueueQualifyProvision(deviceId, qualifyJobId, storageLayouts);
      this.logger.log(`Qualify provision enqueued for device ${deviceId} (jobId=${qualifyJobId})`, jobId);
    } catch (error) {
      this.logger.error(
        `Failed to enqueue qualify provision for device ${deviceId}: ${getErrorMessage(error)}`,
        undefined,
        jobId,
      );
      await this.handleQualifyFailure(deviceId, `Failed to enqueue qualify provision: ${getErrorMessage(error)}`);
    }
  }

  async handleDeviceProvisioned(deviceId: string): Promise<void> {
    if (!(await this.isQualifyDevice(deviceId))) {
      return;
    }

    // An INVENTORY/FAILED device re-PXEing and phoning home 'provisioned' must not re-enter the deprovision/wipe path.
    const device = await this.prisma.device.findUnique({
      where: { id: deviceId },
      select: { server: { select: { lifecycleStatus: true } } },
    });
    const lifecycleStatus = device?.server?.lifecycleStatus ?? null;
    if (
      lifecycleStatus !== ServerLifecycleStatus.PROVISIONING &&
      lifecycleStatus !== ServerLifecycleStatus.PROVISIONED
    ) {
      return;
    }

    this.logger.log(`Qualify: device ${deviceId} reached provisioned — enqueuing deprovision`);

    try {
      await this.completePhoneHomeStep(deviceId);
    } catch (error) {
      this.logger.warn(`Qualify: failed to complete phone_home step for device ${deviceId}: ${getErrorMessage(error)}`);
    }

    try {
      const jobId = crypto.randomUUID();

      await this.lifecyclePrep.prepareForDeprovision(deviceId, jobId);
      await this.bridgeDeprovisionService.deprovisionDevice(deviceId, jobId);
      this.logger.log(`Qualify: deprovision enqueued for device ${deviceId} (jobId=${jobId})`);
    } catch (error) {
      this.logger.error(`Qualify: failed to enqueue deprovision for device ${deviceId}: ${getErrorMessage(error)}`);
      await this.handleQualifyFailure(
        deviceId,
        `Failed to enqueue deprovision after provisioned: ${getErrorMessage(error)}`,
      );
    }
  }

  async handleQualifyDeprovisionComplete(deviceId: string, planId: string): Promise<void> {
    this.logger.log(`Qualify: deprovision complete for device ${deviceId} — promoting to marketplace`, planId);
    await this.promoteQualifyDevice(deviceId);
  }

  async promoteQualifyDevice(deviceId: string): Promise<void> {
    if (!(await this.isQualifyDevice(deviceId))) {
      return;
    }

    const device = await this.prisma.device.findUnique({
      where: { id: deviceId },
      select: { id: true, lastJobId: true, server: { select: { lifecycleStatus: true } } },
    });
    if (device?.server?.lifecycleStatus !== ServerLifecycleStatus.DEPROVISIONING) {
      return;
    }

    this.logger.log(`Qualify: promoting device ${deviceId} to marketplace`);

    try {
      const planId = device.lastJobId ?? '';

      await this.updateStepOnPlan(deviceId, planId, 'device_promotion', 'Promote to marketplace', 'running');

      await this.prisma.device.update({
        where: { id: device.id },
        data: { lastJobId: planId, server: { update: { lifecycleStatus: ServerLifecycleStatus.INVENTORY } } },
      });

      try {
        await this.endQualifyDeployment(device.id);
      } catch (error) {
        this.logger.error(
          `Qualify: promotion committed but deployment teardown failed for ${deviceId} (manual cleanup): ${getErrorMessage(error)}`,
          undefined,
          planId,
        );
      }

      await this.updateStepOnPlan(deviceId, planId, 'device_promotion', 'Promote to marketplace', 'complete');
      this.logger.log(`Qualify: device ${deviceId} qualified — Server lifecycle set to inventory`, planId);
    } catch (error) {
      this.logger.error(`Qualify: failed to promote device ${deviceId}: ${getErrorMessage(error)}`);
      await this.handleQualifyFailure(deviceId, `Failed to promote after discovery: ${getErrorMessage(error)}`);
    }
  }

  // Once saga-driven the saga owns failures — clobbering in-flight state to FAILED here would permanently block promotion; saga/internal paths call `handleQualifyFailure` directly so they CAN fail from those states.
  async handleDiscoveryRunFailure(deviceId: string, reason: string): Promise<void> {
    if (!(await this.isQualifyDevice(deviceId))) {
      return;
    }
    const device = await this.prisma.device.findUnique({
      where: { id: deviceId },
      select: { server: { select: { lifecycleStatus: true } } },
    });
    const lc = device?.server?.lifecycleStatus ?? null;
    if (
      lc === ServerLifecycleStatus.PROVISIONING ||
      lc === ServerLifecycleStatus.PROVISIONED ||
      lc === ServerLifecycleStatus.DEPROVISIONING
    ) {
      this.logger.warn(
        `Ignoring discovery run-failure for in-flight qualify device ${deviceId} (lifecycle=${lc}); the saga owns failures: ${reason}`,
      );
      return;
    }
    await this.handleQualifyFailure(deviceId, reason);
  }

  // Also reached from generic discovery/RunFailed paths — must never close a real customer deployment.
  async handleQualifyFailure(deviceId: string, reason: string): Promise<void> {
    if (!(await this.isQualifyDevice(deviceId))) {
      return;
    }
    // role stays null until Acknowledge, so isQualifyDevice can't distinguish in-flight from finished — never clobber INVENTORY back to FAILED on a late saga failure.
    const qualified = await this.prisma.device.findUnique({
      where: { id: deviceId },
      select: { server: { select: { lifecycleStatus: true } } },
    });
    if (qualified?.server?.lifecycleStatus === ServerLifecycleStatus.INVENTORY) {
      this.logger.warn(`Qualify failure ignored for already-qualified device ${deviceId}: ${reason}`);
      return;
    }
    let teardownError: unknown = null;
    try {
      await this.endQualifyDeployment(deviceId);
    } catch (error) {
      teardownError = error;
      this.logger.error(
        `Qualify teardown failed for device ${deviceId}; deployment may need manual cleanup: ${getErrorMessage(error)}`,
      );
    }
    try {
      const failedReason = teardownError
        ? `${reason} (teardown also failed: ${getErrorMessage(teardownError)})`
        : reason;
      await this.prisma.device.update({
        where: { id: deviceId, deletedAt: null },
        data: {
          server: {
            upsert: {
              create: { lifecycleStatus: ServerLifecycleStatus.FAILED },
              update: { lifecycleStatus: ServerLifecycleStatus.FAILED },
            },
          },
        },
      });
      this.logger.error(`Qualify failed for device ${deviceId}: ${failedReason}`);
    } catch (error) {
      this.logger.warn(`Failed to mark device ${deviceId} FAILED: ${getErrorMessage(error)}`);
    }
  }

  async setPhoneHomeRunning(deviceId: string, planId: string): Promise<void> {
    await this.updateStepOnPlan(deviceId, planId, 'phone_home', 'Wait for phone home', 'running');
  }

  private async completePhoneHomeStep(deviceId: string): Promise<void> {
    const planId = await this.getLastJobId(deviceId);
    if (!planId) return;
    await this.updateStepOnPlan(deviceId, planId, 'phone_home', 'Wait for phone home', 'complete');
  }

  // Lua script avoids read-modify-write races when multiple result events land concurrently.
  private static readonly UPDATE_STEP_LUA = `
    local raw = redis.call('GET', KEYS[1])
    if not raw then return nil end
    local plan = cjson.decode(raw)
    local steps = plan.steps or {}
    local found = false
    for i, s in ipairs(steps) do
      if s.step_name == ARGV[1] then
        s.status = ARGV[3]
        if ARGV[3] == 'running' then s.started_at = tonumber(ARGV[4]) end
        if ARGV[3] == 'complete' then s.completed_at = tonumber(ARGV[4]) end
        found = true
        break
      end
    end
    if not found then
      table.insert(steps, {
        step_name = ARGV[1],
        operation = ARGV[2],
        status = ARGV[3],
        started_at = tonumber(ARGV[4]),
        completed_at = ARGV[3] == 'complete' and tonumber(ARGV[4]) or cjson.null,
        error = cjson.null
      })
    end
    plan.steps = steps
    redis.call('SET', KEYS[1], cjson.encode(plan))
    return 1
  `;

  private async updateStepOnPlan(
    deviceId: string,
    planId: string,
    stepName: string,
    operation: string,
    status: 'running' | 'complete',
  ) {
    try {
      const zoneId = await this.getZoneIdForDevice(deviceId);
      if (!zoneId) return;

      const key = REDIS_KEYS.sagaPlanById(zoneId, planId);
      const now = String(Date.now() / 1000);

      const evalCmd = this.redis.eval.bind(this.redis);
      await evalCmd(QualifyOrchestrationService.UPDATE_STEP_LUA, 1, key, stepName, operation, status, now);

      this.logger.log(`Qualify: ${stepName} set to ${status} for device ${deviceId} (plan=${planId})`);
    } catch (error) {
      this.logger.warn(`Failed to update ${stepName} on plan for device ${deviceId}: ${getErrorMessage(error)}`);
    }
  }

  private async endQualifyDeployment(deviceId: string): Promise<void> {
    const attempts = 2;
    let lastError: unknown = null;
    for (let i = 0; i < attempts; i++) {
      try {
        await this.prisma.deployment.updateMany({
          where: { server: { deviceId }, endDate: null, reservationId: null },
          data: { endDate: new Date(), rescueLayerId: null },
        });
        return;
      } catch (error) {
        lastError = error;
        if (i < attempts - 1) await sleep(250);
      }
    }
    this.logger.warn(
      `Qualify: failed to end transient deployment for device ${deviceId} after ${attempts} attempts: ${getErrorMessage(lastError)}`,
    );
    throw lastError;
  }

  private async getLastJobId(deviceId: string): Promise<string | null> {
    const device = await this.prisma.device.findUnique({
      where: { id: deviceId },
      select: { lastJobId: true },
    });
    return device?.lastJobId ?? null;
  }

  private async getZoneIdForDevice(deviceId: string): Promise<string | null> {
    const device = await this.prisma.device.findUnique({
      where: { id: deviceId },
      select: { zoneId: true },
    });
    return device?.zoneId ?? null;
  }
}
