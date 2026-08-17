import { Injectable } from '@nestjs/common';

import { isRecord } from '@repo/utils';

import { jsonFlag } from '../../../saga-framework/dispatch-payload';
import type { SagaContext } from '../../../saga-framework/saga.types';
import { credsFromContext } from '../../steps/power-control-context';
import { decideTeeAction } from '../decide-tee-action';

interface RedfishOperationsLike {
  enableTee(deviceId: string, bmcIp: string, username: string, password: string, jobId: string): Promise<boolean>;
  disableTee(deviceId: string, bmcIp: string, username: string, password: string, jobId: string): Promise<unknown>;
  verifyTee?(
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

interface TeeVerificationResult {
  ok: boolean;
  checked: boolean;
  missing: unknown[];
}

type VerifiableTeeConfigResult =
  | { action: 'enabled'; success: boolean }
  | { skipped: true; reason: string; success?: boolean };

type TeeConfigResult = VerifiableTeeConfigResult | { action: 'disabled' };

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
      const success = await this.redfish.enableTee(deviceId, bmcIp, username, password, ctx.jobId);
      if (!success && platformSlug !== 'ipxe-custom-tee') {
        throw new Error('enableTee failed: TEE was not enabled on the device');
      }
      const result: VerifiableTeeConfigResult = { action: 'enabled', success };
      return this.verifyCustomTee(ctx, platformSlug, result);
    }
    if (action === 'disable') {
      const { bmcIp, username, password } = credsFromContext(ctx);
      const success = await this.redfish.disableTee(deviceId, bmcIp, username, password, ctx.jobId);
      if (success === false) {
        throw new Error('disableTee failed: TEE was not disabled on the device');
      }
      return { action: 'disabled' };
    }

    await this.logger.info(`No TEE action needed (current=${String(teeEnabled)}, requested=${String(teeRequested)})`, {
      jobId: ctx.jobId,
    });
    const result: VerifiableTeeConfigResult = {
      skipped: true,
      reason: `current=${String(teeEnabled)}, requested=${String(teeRequested)}`,
    };
    if (teeRequested) {
      return this.verifyCustomTee(ctx, platformSlug, result);
    }
    return result;
  }

  private async verifyCustomTee(
    ctx: SagaContext,
    platformSlug: unknown,
    result: VerifiableTeeConfigResult,
  ): Promise<TeeConfigResult> {
    if (platformSlug !== 'ipxe-custom-tee') {
      return result;
    }

    const verifyTee = this.redfish.verifyTee;
    if (verifyTee === undefined) {
      throw new Error('verifyTee is not available');
    }

    const deviceId = String(ctx.deviceId);
    const { bmcIp, username, password } = credsFromContext(ctx);

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const verification = await verifyTee(deviceId, bmcIp, username, password, ctx.jobId);
      if (verification.checked && verification.ok) {
        await this.logger.info(`TEE verification succeeded on attempt ${attempt}`, { jobId: ctx.jobId });
        return 'action' in result ? { action: 'enabled', success: true } : { ...result, success: true };
      }
      if (!verification.checked) {
        await this.logger.warning('TEE verification is not available for this hardware', { jobId: ctx.jobId });
        if ('action' in result && !result.success) {
          throw new Error('enableTee failed: TEE was not enabled on the device');
        }
        return result;
      }

      await this.logger.warning(
        `TEE verification failed on attempt ${attempt}/3; missing=${JSON.stringify(verification.missing)}`,
        { jobId: ctx.jobId },
      );
      if (attempt < 3) {
        await this.redfish.enableTee(deviceId, bmcIp, username, password, ctx.jobId);
      }
    }

    throw new Error(`TEE verification failed after three attempts for device ${deviceId}`);
  }
}

function getWithDefault(obj: unknown, key: string, fallback: unknown): unknown {
  if (!isRecord(obj)) {
    throw new TypeError(`Cannot read properties of ${obj === null ? 'null' : typeof obj} (expected object)`);
  }
  return key in obj ? obj[key] : fallback;
}
