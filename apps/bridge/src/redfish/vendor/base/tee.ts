import { isRecord } from '@repo/utils';

import { isEmptyRecord, logger } from './base.js';
import { RedfishPowerHandler } from './power.js';
import { resolveVendorProfile } from './registry.js';

const APP_CLASS = 'adapters-redfish';

export interface TeeVerificationMissing {
  key: string;
  expected: unknown[];
  actual: unknown;
}

/** Why a verification could not read the BIOS back; only set when `checked` is false. */
export type TeeVerificationReason = 'unmodeled' | 'bmc-unreachable';

export interface TeeVerificationResult extends Record<string, unknown> {
  ok: boolean;
  checked: boolean;
  missing: TeeVerificationMissing[];
  reason?: TeeVerificationReason;
}

export interface TeeStageResult {
  ok: boolean;
  /** PATCH requests the stage issued; zero means every value was already in place. */
  patched: number;
}

export type TeeBiosCheck = readonly [section: string, key: string, expected: readonly unknown[]];

export class RedfishTeeHandler extends RedfishPowerHandler {
  setTee(newSetting = true): Promise<boolean> {
    return resolveVendorProfile(this.device.tag()).setTee(this, newSetting);
  }

  verifyTee(): Promise<TeeVerificationResult> {
    if (!this.device.redfishEndpoint || isEmptyRecord(this.device.biosParams)) {
      logger.warning('verify_tee: discovery returned no redfish endpoint or bios attributes — cannot confirm TEE', {
        jobId: this.jobId,
        appClassName: APP_CLASS,
      });
      return Promise.resolve({ ok: false, checked: false, missing: [], reason: 'bmc-unreachable' });
    }
    return resolveVendorProfile(this.device.tag()).verifyTee(this);
  }

  /** @internal Public so brand TEE profiles (vendor/<brand>/) can tell a stage that wrote from one that did not. */
  async applyTeeStage(settings: Record<string, number | string>): Promise<TeeStageResult> {
    const before = this.device.callStack.length;
    const ok = await this.applySequentialBiosSettings(settings);
    const patched = this.device.callStack.slice(before).filter((entry) => entry.method === 'PATCH').length;
    return { ok, patched };
  }

  verifyBiosSettings(checks: readonly TeeBiosCheck[]): TeeVerificationResult {
    const missing: TeeVerificationMissing[] = [];

    for (const [section, key, expected] of checks) {
      const sectionParams = this.device.biosParams[section];
      const actual =
        section && isRecord(sectionParams) && key in sectionParams
          ? sectionParams[key]
          : (this.device.biosParams[key] ?? null);
      if (!expected.includes(actual)) {
        missing.push({ key, expected: [...expected], actual });
      }
    }

    const ok = missing.length === 0;
    if (ok) {
      logger.info('verify_tee: TEE fully applied (all critical attributes enabled)', {
        jobId: this.jobId,
        appClassName: APP_CLASS,
      });
    } else {
      logger.warning(`verify_tee: TEE NOT fully applied — missing=${JSON.stringify(missing)}`, {
        jobId: this.jobId,
        appClassName: APP_CLASS,
      });
    }
    return { ok, checked: true, missing };
  }
}
