import { RedfishBiosHandler } from './bios.js';
import { resolveVendorProfile } from './registry.js';

export class RedfishPowerHandler extends RedfishBiosHandler {
  // Vendor reboot mechanics live in each brand's VendorProfile (vendor/<brand>/).
  // Unmatched tags fall back to the default profile's "not implemented" warning.
  reboot(): Promise<void> {
    return resolveVendorProfile(this.device.tag()).reboot(this);
  }
}
