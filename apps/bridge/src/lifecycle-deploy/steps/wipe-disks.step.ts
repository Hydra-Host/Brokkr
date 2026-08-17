import { Inject, Injectable } from '@nestjs/common';
import { getErrorMessage } from '../../common/error-utils';

import type { OperationName, OperationOutput } from '@repo/bridge-agent-protocol';

import {
  AgentNotConnected,
  AgentNotResponsive,
  DispatchFailed,
  DispatchStalled,
} from '../../agent/dispatch/grpc.exceptions';
import type { SagaContext } from '../../saga-framework/saga.types';
import { EFI_BOOT_SERVICE_FACTORY } from '../efi-boot.service';
import { getWipeTimeoutConfig } from '../wipe-timeout.config';

type WipeDisksOutput = OperationOutput<'storage.wipeDisks'>;

interface DispatcherLike {
  dispatchTyped<N extends OperationName>(
    deviceId: string,
    operation: N,
    input: Record<string, unknown>,
    options: {
      jobId: string;
      timeoutS: number;
      stallTimeoutS?: number;
      signal?: AbortSignal;
      workId?: string;
    },
  ): Promise<OperationOutput<N>>;
}

interface DiskLayoutNormalizer {
  diskLayoutsForAgent(layouts: unknown): unknown;
}

interface EfiBootServiceLike {
  forceBootDevice(): Promise<void>;
}

interface EfiBootServiceFactoryLike {
  create(args: { jobId: string; deviceId: string; signal?: AbortSignal; workId?: string }): Promise<EfiBootServiceLike>;
}

interface AppConfigLike {
  environment: string;
}

interface LoggerLike {
  info(message: string, context?: { jobId?: string }): Promise<void>;
  debug(message: string, context?: { jobId?: string }): Promise<void>;
  warning(message: string, context?: { jobId?: string }): Promise<void>;
  error(message: string, context?: { jobId?: string }): Promise<void>;
}

interface WipeDisksResult {
  wiped: true;
  mode: WipeDisksOutput['sanitization_report']['mode'];
  optimal_os_disk: WipeDisksOutput['optimal_os_disk'];
  sanitization_report: WipeDisksOutput['sanitization_report'];
}

@Injectable()
export class WipeDisksStep {
  constructor(
    private readonly dispatcher: DispatcherLike,
    private readonly normalizer: DiskLayoutNormalizer,
    @Inject(EFI_BOOT_SERVICE_FACTORY)
    private readonly efiBootFactory: EfiBootServiceFactoryLike,
    private readonly appConfig: AppConfigLike,
    private readonly logger: LoggerLike,
  ) {}

  async execute(ctx: SagaContext): Promise<WipeDisksResult> {
    const deviceId = String(ctx.deviceId);
    const payload = ctx.payload;
    const { jobId } = ctx;
    const config = getWipeTimeoutConfig();

    const resolveResult = asMapping(ctx.stepResults['resolve_deploy_target']) ?? {};
    const resolveLayouts = resolveResult['disk_layouts'];
    const payloadLayouts = payload['disk_layouts'];
    const diskLayoutsRaw =
      Array.isArray(resolveLayouts) && resolveLayouts.length === 0
        ? payloadLayouts
        : (resolveLayouts ?? payloadLayouts);
    const diskLayouts = diskLayoutsRaw === undefined ? null : diskLayoutsRaw;

    const normalizedLayouts = diskLayouts ? this.normalizer.diskLayoutsForAgent(diskLayouts) : diskLayouts;

    const env =
      this.appConfig.environment === 'prod' || this.appConfig.environment === 'production'
        ? 'production'
        : 'development';

    // PROVISION wipes EVERY disk (a fresh tenant must never inherit prior-tenant data on non-enumerated disks); REPROVISION keeps selective preserve semantics. Layouts still drive partitioning downstream.
    const fullWipe = payload['status'] === 'provisioning';

    const wipePayload: Record<string, unknown> = {
      disk_layouts: normalizedLayouts,
      environment: env,
      full_wipe: fullWipe,
      job_id: jobId,
    };

    const mode = fullWipe || !diskLayouts ? 'full' : 'selective';
    await this.logger.info(`Starting disk wipe for device ${deviceId} (mode=${mode}, environment=${env})`, {
      jobId,
    });
    await this.logger.debug(`storage.wipeDisks payload: ${JSON.stringify(wipePayload)}`, {
      jobId,
    });

    let response: WipeDisksOutput;
    try {
      response = await this.dispatcher.dispatchTyped(deviceId, 'storage.wipeDisks', wipePayload, {
        jobId,
        timeoutS: config.absoluteTimeoutS,
        stallTimeoutS: config.stallTimeoutS,
        signal: ctx.signal,
        workId: ctx.workId,
      });

      const sanitizationReport = response.sanitization_report;
      const optimalOsDisk = response.optimal_os_disk;

      // A failed sanitization must FAIL the saga — {wiped:true} would let a new tenant chain onto un-sanitized disks. Throwing drives the device to 'failed' and fires re-wipe compensation.
      assertSanitizationPassed(sanitizationReport.overall_result, sanitizationReport, jobId, this.logger);

      try {
        await this.logger.info('Configuring EFI boot menu', { jobId });
        const efiService = await this.efiBootFactory.create({
          jobId,
          deviceId,
          signal: ctx.signal,
          workId: ctx.workId === undefined ? undefined : `${ctx.workId}:efi`,
        });
        await efiService.forceBootDevice();
        await this.logger.info('EFI boot menu configured successfully', { jobId });
      } catch (error) {
        await this.logger.warning(`EFI boot configuration failed (non-fatal): ${getErrorMessage(error)}`, { jobId });
      }

      await this.logger.info('Disk wipe completed successfully', { jobId });

      return {
        wiped: true,
        mode: sanitizationReport.mode,
        optimal_os_disk: optimalOsDisk,
        sanitization_report: sanitizationReport,
      };
    } catch (error) {
      if (error instanceof AgentNotConnected || error instanceof AgentNotResponsive) {
        throw error;
      }
      if (error instanceof SanitizationFailedError) {
        throw error;
      }
      if (error instanceof DispatchStalled) {
        await this.logger.error(
          `Disk wipe stalled: no agent progress for ${error.stall_seconds.toFixed(0)}s (work_id=${error.work_id}, last_progress=${JSON.stringify(error.last_progress)})`,
          { jobId },
        );
        throw new Error(`Disk wipe stalled: ${error.message}`);
      }
      if (error instanceof DispatchFailed) {
        await this.logger.error(
          `Disk wipe failed: ${error.message}; agent details=${error.details || '<none>'}; payload sent=${JSON.stringify(wipePayload)}`,
          { jobId },
        );
        throw new Error(`Disk wipe failed: ${error.message}`);
      }
      const msg = getErrorMessage(error);
      await this.logger.error(`Disk wipe failed: ${msg}`, { jobId });
      throw new Error(`Disk wipe failed: ${msg}`);
    }
  }
}

const SANITIZATION_SUCCESS_RESULTS: ReadonlySet<string> = new Set(['pass', 'pass_crypto_erase']);

class SanitizationFailedError extends Error {
  readonly stepResult: { sanitization_report: unknown };
  constructor(message: string, sanitizationReport: unknown) {
    super(message);
    this.name = 'SanitizationFailedError';
    this.stepResult = { sanitization_report: sanitizationReport };
  }
}

function assertSanitizationPassed(
  overallResult: unknown,
  sanitizationReport: unknown,
  jobId: string,
  logger: LoggerLike,
): void {
  // Fail CLOSED: only an explicit success verdict passes — a missing overall_result must not let an un-sanitized device re-enter inventory.
  if (typeof overallResult === 'string' && SANITIZATION_SUCCESS_RESULTS.has(overallResult)) return;
  void logger.error(`Disk wipe failed: sanitization not verified (overall_result=${JSON.stringify(overallResult)})`, {
    jobId,
  });
  throw new SanitizationFailedError(
    `Disk wipe failed: sanitization not verified (overall_result=${JSON.stringify(overallResult)})`,
    sanitizationReport,
  );
}

function asMapping(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}
