import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { DeviceTestType, JobType } from '@repo/database';
import { SYSTEM_JOB_SAGAS } from '@repo/lifecycle';
import { Logger } from 'src/common/decorators/logger.decorator';
import { LifecycleService, type SystemJobSource } from 'src/lifecycle/lifecycle.service';
import { LoggerService } from 'src/logger/logger.service';
import { BridgeQueueService } from '../queue/bridge-queue.service';
import { BenchmarksRepository } from './benchmarks.repository';
import { type LatestDeviceTestRunRow } from './benchmarks.types';

@Injectable()
export class BenchmarkService {
  constructor(
    private readonly benchmarksRepository: BenchmarksRepository,
    private readonly bridgeQueueService: BridgeQueueService,
    @Inject(LifecycleService) private readonly lifecycleService: Pick<LifecycleService, 'runSystem'>,
    @Logger(BenchmarkService.name) private readonly logger: LoggerService,
  ) {}

  shouldRunBenchmarks(latestDeviceTestRun: LatestDeviceTestRunRow | null) {
    if (!latestDeviceTestRun?.createdAt || !latestDeviceTestRun.status) {
      return true;
    }

    const lastRun = latestDeviceTestRun.createdAt;
    if (latestDeviceTestRun.status === 'Running') {
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
      return lastRun < oneHourAgo;
    }

    if (latestDeviceTestRun.testPassed === false) {
      return true;
    }

    const fifteenDaysAgo = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000);
    if (lastRun < fifteenDaysAgo) {
      return true;
    }

    return false;
  }

  async runBenchmarks(deviceId: string, source: SystemJobSource = 'manual') {
    const latestTestRun = await this.benchmarksRepository.getLatestDeviceTestRunForDevice(deviceId);

    if (!latestTestRun) {
      throw new BadRequestException(`Device ${deviceId} not found`);
    }
    if (latestTestRun.deviceStatus === 'provisioning') {
      throw new BadRequestException(`Device ${deviceId} is currently provisioning`);
    }

    // Mid-commissioning (no role yet) skip must happen ahead of createRunningDeviceTestRun —
    // stranded `Running` runs would make shouldRunBenchmarks block retries for an hour.
    if (!latestTestRun.role) {
      this.logger.log(`Skipping benchmarks for device ${deviceId} — no role assigned yet`);
      return { skipped: true };
    }

    if (!this.shouldRunBenchmarks(latestTestRun)) {
      this.logger.log(`Skipping benchmarks for device ${deviceId} — ran within last 15 days`);
      return { skipped: true };
    }

    const zoneId = latestTestRun.zoneId;
    if (!zoneId) {
      throw new BadRequestException(`Device ${deviceId} is not assigned to a zone`);
    }

    const [gpuBurnRun, ncclRun] = await Promise.all([
      this.benchmarksRepository.createRunningDeviceTestRun(deviceId, DeviceTestType.GpuBurnIn),
      this.benchmarksRepository.createRunningDeviceTestRun(deviceId, DeviceTestType.NcclPerformance),
    ]);

    const job = await this.lifecycleService.runSystem({
      jobType: JobType.Benchmarks,
      deviceId,
      zoneId,
      source,
      dispatch: async (planId) => {
        const enqueued = await this.bridgeQueueService.enqueueSagaJob(
          zoneId,
          SYSTEM_JOB_SAGAS[JobType.Benchmarks],
          planId,
          {
            device_id: deviceId,
            gpu_burn_job_id: gpuBurnRun.id,
            nccl_job_id: ncclRun.id,
            benchmark_type: 'all',
          },
          deviceId,
        );
        this.logger.log(
          `Benchmarks enqueued for device ${deviceId}: planId=${planId}, bullmqJobId=${enqueued.id}`,
          planId,
        );
      },
    });

    return { enqueued: true, plan_id: job.data.id, gpu_burn_run_id: gpuBurnRun.id, nccl_run_id: ncclRun.id };
  }
}
