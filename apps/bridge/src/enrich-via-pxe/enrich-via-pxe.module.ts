import { Module, type OnModuleInit } from '@nestjs/common';

import { OobModule } from '../oob/oob.module';
import { EnsureLanplusAccessStep } from '../oob/steps/ensure-lanplus-access.step';
import { PcPowerOffStep } from '../oob/steps/pc-power-off.step';
import { PcPowerOnStep } from '../oob/steps/pc-power-on.step';
import { PcSetBootDeviceStep } from '../oob/steps/pc-set-boot-device.step';
import { PcValidateIpmiStep } from '../oob/steps/pc-validate-ipmi.step';
import { PcVerifyBootDeviceStep } from '../oob/steps/pc-verify-boot-device.step';
import { PcVerifyPowerOffStep } from '../oob/steps/pc-verify-power-off.step';
import { PcVerifyPowerOnStep } from '../oob/steps/pc-verify-power-on.step';
import { RedfishCommandStep } from '../oob/steps/redfish-command.step';
import { registerSagaDef } from '../saga-framework/saga-registry';

import { buildEnrichViaPxeSaga } from './enrich-via-pxe.workflow';

@Module({
  imports: [OobModule],
})
export class EnrichViaPxeModule implements OnModuleInit {
  constructor(
    private readonly redfishCommand: RedfishCommandStep,
    private readonly ensureLanplusAccess: EnsureLanplusAccessStep,
    private readonly pcValidateIpmi: PcValidateIpmiStep,
    private readonly pcPowerOff: PcPowerOffStep,
    private readonly pcVerifyPowerOff: PcVerifyPowerOffStep,
    private readonly pcSetBootDevice: PcSetBootDeviceStep,
    private readonly pcVerifyBootDevice: PcVerifyBootDeviceStep,
    private readonly pcPowerOn: PcPowerOnStep,
    private readonly pcVerifyPowerOn: PcVerifyPowerOnStep,
  ) {}

  onModuleInit(): void {
    registerSagaDef(
      buildEnrichViaPxeSaga({
        redfishCommand: this.redfishCommand,
        ensureLanplusAccess: this.ensureLanplusAccess,
        pcValidateIpmi: this.pcValidateIpmi,
        pcPowerOff: this.pcPowerOff,
        pcVerifyPowerOff: this.pcVerifyPowerOff,
        pcSetBootDevice: this.pcSetBootDevice,
        pcVerifyBootDevice: this.pcVerifyBootDevice,
        pcPowerOn: this.pcPowerOn,
        pcVerifyPowerOn: this.pcVerifyPowerOn,
      }),
    );
  }
}
