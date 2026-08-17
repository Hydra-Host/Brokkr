import { Module, type OnModuleInit } from '@nestjs/common';

import { OobModule } from '../oob/oob.module';
import { PcBmcResetColdStep } from '../oob/steps/pc-bmc-reset-cold.step';
import { PcPowerOffStep } from '../oob/steps/pc-power-off.step';
import { PcPowerOnStep } from '../oob/steps/pc-power-on.step';
import { PcSetBootDeviceStep } from '../oob/steps/pc-set-boot-device.step';
import { PcValidateIpmiStep } from '../oob/steps/pc-validate-ipmi.step';
import { PcVerifyBmcRecoveryStep } from '../oob/steps/pc-verify-bmc-recovery.step';
import { PcVerifyBootDeviceStep } from '../oob/steps/pc-verify-boot-device.step';
import { PcVerifyPowerOffStep } from '../oob/steps/pc-verify-power-off.step';
import { PcVerifyPowerOnStep } from '../oob/steps/pc-verify-power-on.step';
import { PcWaitForOsStep } from '../oob/steps/pc-wait-for-os.step';
import { registerSagaDef } from '../saga-framework/saga-registry';

import { buildBmcResetSaga } from './bmc-reset.workflow';
import { buildPowerOffSaga } from './power-off.workflow';
import { buildPowerOnSaga } from './power-on.workflow';
import { buildPowerStatusSaga } from './power-status.workflow';
import { buildRebootSaga } from './reboot.workflow';

@Module({
  imports: [OobModule],
})
export class PowerOpsModule implements OnModuleInit {
  constructor(
    private readonly pcValidateIpmi: PcValidateIpmiStep,
    private readonly pcPowerOff: PcPowerOffStep,
    private readonly pcVerifyPowerOff: PcVerifyPowerOffStep,
    private readonly pcSetBootDevice: PcSetBootDeviceStep,
    private readonly pcVerifyBootDevice: PcVerifyBootDeviceStep,
    private readonly pcPowerOn: PcPowerOnStep,
    private readonly pcVerifyPowerOn: PcVerifyPowerOnStep,
    private readonly pcWaitForOs: PcWaitForOsStep,
    private readonly pcBmcResetCold: PcBmcResetColdStep,
    private readonly pcVerifyBmcRecovery: PcVerifyBmcRecoveryStep,
  ) {}

  onModuleInit(): void {
    registerSagaDef(
      buildPowerOnSaga({
        pcValidateIpmi: this.pcValidateIpmi,
        pcSetBootDevice: this.pcSetBootDevice,
        pcVerifyBootDevice: this.pcVerifyBootDevice,
        pcPowerOn: this.pcPowerOn,
        pcVerifyPowerOn: this.pcVerifyPowerOn,
        pcWaitForOs: this.pcWaitForOs,
      }),
    );
    registerSagaDef(
      buildPowerOffSaga({
        pcValidateIpmi: this.pcValidateIpmi,
        pcPowerOff: this.pcPowerOff,
        pcVerifyPowerOff: this.pcVerifyPowerOff,
      }),
    );
    registerSagaDef(buildPowerStatusSaga({ pcValidateIpmi: this.pcValidateIpmi }));
    registerSagaDef(
      buildRebootSaga({
        pcValidateIpmi: this.pcValidateIpmi,
        pcPowerOff: this.pcPowerOff,
        pcVerifyPowerOff: this.pcVerifyPowerOff,
        pcSetBootDevice: this.pcSetBootDevice,
        pcVerifyBootDevice: this.pcVerifyBootDevice,
        pcPowerOn: this.pcPowerOn,
        pcVerifyPowerOn: this.pcVerifyPowerOn,
        pcWaitForOs: this.pcWaitForOs,
      }),
    );
    registerSagaDef(
      buildBmcResetSaga({
        pcValidateIpmi: this.pcValidateIpmi,
        pcBmcResetCold: this.pcBmcResetCold,
        pcVerifyBmcRecovery: this.pcVerifyBmcRecovery,
      }),
    );
  }
}
