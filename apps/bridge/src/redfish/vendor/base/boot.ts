import { type JsonRecord, logger } from './base.js';
import { RedfishPowerHandler } from './power.js';
import { resolveVendorProfile } from './registry.js';

const APP_CLASS = 'adapters-redfish';

export class RedfishBootHandler extends RedfishPowerHandler {
  async reliableBoot(): Promise<void> {
    await this.setIpmi(true);
    await this.setBootPxe();
    await this.setPxeInterface();
    await resolveVendorProfile(this.device.tag()).preBootTweaks(this);
  }

  findActiveInterfaces(): Promise<JsonRecord[]> {
    return resolveVendorProfile(this.device.tag()).findActiveInterfaces(this);
  }

  setPxeInterface(): Promise<void> {
    return resolveVendorProfile(this.device.tag()).setPxeInterface(this);
  }

  setBootPxe(): Promise<void> {
    return resolveVendorProfile(this.device.tag()).setBootPxe(this);
  }

  setIpmi(newSetting: boolean): Promise<void> {
    return resolveVendorProfile(this.device.tag()).setIpmi(this, newSetting);
  }

  setSecureboot(newSetting: boolean): Promise<void> {
    // Generic guard: the vendor bodies assume the Secure Boot endpoint is known.
    if (!this.device.securebootEndpoint) {
      logger.info("Can't apply new parameters, failed to determine the Secure Boot endpoint", {
        jobId: this.jobId,
        appClassName: APP_CLASS,
      });
      return Promise.resolve();
    }
    return resolveVendorProfile(this.device.tag()).setSecureboot(this, newSetting);
  }

  disableOsBootOptions(): Promise<void> {
    return resolveVendorProfile(this.device.tag()).disableOsBootOptions(this);
  }
}
