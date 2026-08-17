import { isRecord } from '@repo/utils';

import { logger } from './base.js';
import { RedfishPowerHandler } from './power.js';
import { resolveVendorProfile } from './registry.js';

const APP_CLASS = 'adapters-redfish';

export interface TeeVerificationMissing {
  key: string;
  expected: unknown[];
  actual: unknown;
}

export interface TeeVerificationResult extends Record<string, unknown> {
  ok: boolean;
  checked: boolean;
  missing: TeeVerificationMissing[];
}

export type TeeBiosCheck = readonly [section: string, key: string, expected: readonly unknown[]];

export class RedfishTeeHandler extends RedfishPowerHandler {
  setTee(newSetting = true): Promise<boolean> {
    return resolveVendorProfile(this.device.tag()).setTee(this, newSetting);
  }

  verifyTee(): Promise<TeeVerificationResult> {
    return resolveVendorProfile(this.device.tag()).verifyTee(this);
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
