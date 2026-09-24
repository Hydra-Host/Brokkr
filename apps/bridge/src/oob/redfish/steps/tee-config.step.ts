import { Injectable } from '@nestjs/common';

import { isRecord } from '@repo/utils';

import type { TeeSetResult, TeeVerificationResult } from '../../../redfish/vendor/base/tee';
import { jsonFlag } from '../../../saga-framework/dispatch-payload';
import type { SagaContext } from '../../../saga-framework/saga.types';
import { credsFromContext } from '../../steps/power-control-context';
import { decideTeeAction } from '../decide-tee-action';

interface RedfishOperationsLike {
  enableTee(deviceId: string, bmcIp: string, username: string, password: string, jobId: string): Promise<TeeSetResult>;
  disableTee(deviceId: string, bmcIp: string, username: string, password: string, jobId: string): Promise<TeeSetResult>;
  verifyTee(
    deviceId: string,
    bmcIp: string,
    username: string,
    password: string,
    jobId: string,
  ): Promise<TeeVerificationResult>;
}

interface LoggerLike {
  info(message: string, context?: { jobId?: string }): Promise<void>;
  warning(message: string, context?: { jobId?: string }): Promise<void>;
}

type VerifiableTeeConfigResult =
  | { action: 'enabled'; success: boolean; host_reset_at?: number }
  | { skipped: true; reason: string; success?: boolean; host_reset_at?: number };

type TeeConfigResult = VerifiableTeeConfigResult | { action: 'disabled'; host_reset_at?: number };

@Injectable()
export class TeeConfigStep {
  constructor(
    private readonly redfish: RedfishOperationsLike,
    private readonly logger: LoggerLike,
  ) {}

  async execute(ctx: SagaContext): Promise<TeeConfigResult> {
    const payload = ctx.payload;
    const platform = getWithDefault(payload, 'platform', {});
    const variantIsTee = isRecord(platform) && getWithDefault(platform, 'variant', '') === 'tee';
    const teeRequested = jsonFlag(getWithDefault(payload, 'tee_requested', variantIsTee));
    const teeEnabled = jsonFlag(getWithDefault(payload, 'tee_enabled', false));
    const action = decideTeeAction({ teeRequested, teeEnabled });

    const deviceId = String(ctx.deviceId);
    const platformSlug = isRecord(platform) ? getWithDefault(platform, 'slug', '') : '';

    if (action === 'enable') {
      const { bmcIp, username, password } = credsFromContext(ctx);
      const { success, hostResetAt } = await this.redfish.enableTee(deviceId, bmcIp, username, password, ctx.jobId);
      if (!success && platformSlug !== 'ipxe-custom-tee') {
        throw new Error('enableTee failed: TEE was not enabled on the device');
      }
      const result: VerifiableTeeConfigResult = { action: 'enabled', success };
      return this.verifyEnable(ctx, withHostReset(result, hostResetAt));
    }
    if (action === 'disable') {
      const { bmcIp, username, password } = credsFromContext(ctx);
      const { success, hostResetAt } = await this.redfish.disableTee(deviceId, bmcIp, username, password, ctx.jobId);
      if (!success) {
        throw new Error('disableTee failed: TEE was not disabled on the device');
      }
      const result: TeeConfigResult = { action: 'disabled' };
      return withHostReset(result, hostResetAt);
    }

    await this.logger.info(`No TEE action needed (current=${String(teeEnabled)}, requested=${String(teeRequested)})`, {
      jobId: ctx.jobId,
    });
    const result: VerifiableTeeConfigResult = {
      skipped: true,
      reason: `current=${String(teeEnabled)}, requested=${String(teeRequested)}`,
    };
    if (teeRequested) {
      return this.verifyEnable(ctx, result);
    }
    return result;
  }

  private async verifyEnable(ctx: SagaContext, initial: VerifiableTeeConfigResult): Promise<TeeConfigResult> {
    const deviceId = String(ctx.deviceId);
    const { bmcIp, username, password } = credsFromContext(ctx);
    let result = initial;

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const verification = await this.redfish.verifyTee(deviceId, bmcIp, username, password, ctx.jobId);
      if (verification.checked && verification.ok) {
        await this.logger.info(`TEE verification succeeded on attempt ${attempt}`, { jobId: ctx.jobId });
        return { ...result, success: true };
      }
      if (!verification.checked) {
        switch (verification.reason) {
          case 'unmodeled':
            await this.logger.warning('TEE verification is not available for this hardware', { jobId: ctx.jobId });
            if ('action' in result && !result.success) {
              throw new Error('enableTee failed: TEE was not enabled on the device');
            }
            return result;
          case 'bmc-unreachable':
          case undefined:
            // the enable already ran; only the readback is missing, so retry that alone
            await this.logger.warning(
              `TEE verification could not read the BIOS on attempt ${attempt}/3; reason=${String(verification.reason)}`,
              { jobId: ctx.jobId },
            );
            continue;
          default: {
            const exhaustive: never = verification.reason;
            throw new Error(`TEE verification returned an unhandled reason: ${String(exhaustive)}`);
          }
        }
      }

      await this.logger.warning(
        `TEE verification failed on attempt ${attempt}/3; missing=${JSON.stringify(verification.missing)}`,
        { jobId: ctx.jobId },
      );
      if (attempt < 3) {
        const retry = await this.redfish.enableTee(deviceId, bmcIp, username, password, ctx.jobId);
        result = withHostReset(result, retry.hostResetAt);
      }
    }

    throw new Error(`TEE verification failed after three attempts for device ${deviceId}`);
  }
}

function withHostReset<T extends { host_reset_at?: number }>(result: T, hostResetAt: number | null): T {
  return hostResetAt === null ? result : { ...result, host_reset_at: hostResetAt };
}

function getWithDefault(obj: unknown, key: string, fallback: unknown): unknown {
  if (!isRecord(obj)) {
    throw new TypeError(`Cannot read properties of ${obj === null ? 'null' : typeof obj} (expected object)`);
  }
  return key in obj ? obj[key] : fallback;
}
