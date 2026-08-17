// Profile delegation instead of per-vendor handler subclasses is deliberate: `boot` and
// `tee` both extend `power`, so a whole-chain vendor subclass could not inherit its `reboot`.

import type { JsonRecord } from './base.js';
import { logger } from './base.js';
import type { RedfishBootHandler } from './boot.js';
import type { RedfishDiscoveryHandler } from './discovery.js';
import type { RedfishPowerHandler } from './power.js';
import type { RedfishTeeHandler, TeeVerificationResult } from './tee.js';

const APP_CLASS = 'adapters-redfish';

export abstract class BaseVendorProfile {
  /** Matched against `RedfishDevice.tag()`; first registered match wins. */
  abstract readonly tagPattern: RegExp;
  /** Discovery resolves on a bare `vendor..` tag (no controller yet), which a narrow
   *  `tagPattern` silently misses; undefined → discovery falls back to `tagPattern`. */
  readonly discoveryTagPattern?: RegExp;

  // ── discovery ─────────────────────────────────────────────────────────
  discoverSystemInfo(handler: RedfishDiscoveryHandler, _systemResponse: JsonRecord): Promise<void> {
    logger.error(`support not implemented for: ${handler.device.tag()}`, {
      jobId: handler.jobId,
      appClassName: APP_CLASS,
    });
    return Promise.resolve();
  }

  // ── bios ──────────────────────────────────────────────────────────────
  normalizeEnumValues(valueNames: unknown[], _values: unknown[]): unknown[] {
    return valueNames;
  }
  readonly requiresEtag: boolean = false;

  // ── power ─────────────────────────────────────────────────────────────
  reboot(handler: RedfishPowerHandler): Promise<void> {
    logger.warning(`support for reboot() has not been implemented for: ${handler.device.tag()}`, {
      jobId: handler.jobId,
      appClassName: APP_CLASS,
    });
    return Promise.resolve();
  }

  // ── tee ───────────────────────────────────────────────────────────────
  setTee(handler: RedfishTeeHandler, enable: boolean): Promise<boolean> {
    logger.info(`support for set_tee(${enable}) has not been implemented for: ${handler.device.tag()}`, {
      jobId: handler.jobId,
      appClassName: APP_CLASS,
    });
    return Promise.resolve(false);
  }
  verifyTee(handler: RedfishTeeHandler): Promise<TeeVerificationResult> {
    logger.warning(
      `verify_tee: no TEE readback model for ${handler.device.tag()} — cannot confirm; treating as non-blocking`,
      {
        jobId: handler.jobId,
        appClassName: APP_CLASS,
      },
    );
    return Promise.resolve({ ok: true, checked: false, missing: [] });
  }

  // ── boot ──────────────────────────────────────────────────────────────
  // preBootTweaks has no default log — unlisted tags fall through with no warning.
  preBootTweaks(_handler: RedfishBootHandler): Promise<void> {
    return Promise.resolve();
  }
  findActiveInterfaces(handler: RedfishBootHandler): Promise<JsonRecord[]> {
    logger.warning(`support for find_active_interfaces() has not been implemented for: ${handler.device.tag()}`, {
      jobId: handler.jobId,
      appClassName: APP_CLASS,
    });
    return Promise.resolve([]);
  }
  setPxeInterface(handler: RedfishBootHandler): Promise<void> {
    logger.warning(`support for set_pxe_interface() has not been implemented for: ${handler.device.tag()}`, {
      jobId: handler.jobId,
      appClassName: APP_CLASS,
    });
    return Promise.resolve();
  }
  setBootPxe(handler: RedfishBootHandler): Promise<void> {
    logger.warning(`support for set_boot_pxe() has not been implemented for: ${handler.device.tag()}`, {
      jobId: handler.jobId,
      appClassName: APP_CLASS,
    });
    return Promise.resolve();
  }
  setIpmi(handler: RedfishBootHandler, _newSetting: boolean): Promise<void> {
    logger.info(`support for set_ipmi() has not been implemented for: ${handler.device.tag()}`, {
      jobId: handler.jobId,
      appClassName: APP_CLASS,
    });
    return Promise.resolve();
  }
  setSecureboot(handler: RedfishBootHandler, _newSetting: boolean): Promise<void> {
    logger.warning(`support for set_secureboot() has not been implemented for: ${handler.device.tag()}`, {
      jobId: handler.jobId,
      appClassName: APP_CLASS,
    });
    return Promise.resolve();
  }
  disableOsBootOptions(handler: RedfishBootHandler): Promise<void> {
    logger.warning(`disable_os_boot_options() not implemented for: ${handler.device.tag()}`, {
      jobId: handler.jobId,
      appClassName: APP_CLASS,
    });
    return Promise.resolve();
  }
}

/** Fallback profile for devices whose tag matches no registered brand. */
export class DefaultVendorProfile extends BaseVendorProfile {
  readonly tagPattern = /.*/;
}
