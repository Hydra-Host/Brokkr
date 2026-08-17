import { Module, type OnModuleInit } from '@nestjs/common';

import { BrokkrLiveModule } from '../brokkr-live/brokkr-live.module';
import { BrokkrLiveCheckStep } from '../brokkr-live/steps/brokkr-live-check.step';
import { CollectionModule } from '../collection/collection.module';
import { CollectHardwareStep } from '../collection/steps/collect-hardware.step';
import { WaitForBrokkrLiveStep } from '../collection/steps/wait-for-brokkr-live.step';
import { LifecycleDeployModule } from '../lifecycle-deploy/lifecycle-deploy.module';
import { WaitForAgentSessionStep } from '../lifecycle-deploy/steps/wait-for-agent-session.step';
import { WipeDisksStep } from '../lifecycle-deploy/steps/wipe-disks.step';
import { OobModule } from '../oob/oob.module';
import { DisableOsBootStep } from '../oob/redfish/steps/disable-os-boot.step';
import { RedfishStandardizeStep } from '../oob/redfish/steps/redfish-standardize.step';
import { PcPowerOffStep } from '../oob/steps/pc-power-off.step';
import { PcPowerOnStep } from '../oob/steps/pc-power-on.step';
import { PcSetBootDeviceStep } from '../oob/steps/pc-set-boot-device.step';
import { PcValidateIpmiStep } from '../oob/steps/pc-validate-ipmi.step';
import { PcVerifyBootDeviceStep } from '../oob/steps/pc-verify-boot-device.step';
import { PcVerifyPowerOffStep } from '../oob/steps/pc-verify-power-off.step';
import { PcVerifyPowerOnStep } from '../oob/steps/pc-verify-power-on.step';
import { registerSagaDef } from '../saga-framework/saga-registry';

import { buildCommissionSaga } from './commission.workflow';

@Module({
  imports: [OobModule, BrokkrLiveModule, CollectionModule, LifecycleDeployModule],
})
export class CommissionModule implements OnModuleInit {
  constructor(
    private readonly validateIpmi: PcValidateIpmiStep,
    private readonly redfishStandardize: RedfishStandardizeStep,
    private readonly brokkrLiveCheck: BrokkrLiveCheckStep,
    private readonly disableOsBoot: DisableOsBootStep,
    private readonly pcPowerOff: PcPowerOffStep,
    private readonly pcVerifyPowerOff: PcVerifyPowerOffStep,
    private readonly pcSetBootDevice: PcSetBootDeviceStep,
    private readonly pcVerifyBootDevice: PcVerifyBootDeviceStep,
    private readonly pcPowerOn: PcPowerOnStep,
    private readonly pcVerifyPowerOn: PcVerifyPowerOnStep,
    private readonly waitForBrokkrLive: WaitForBrokkrLiveStep,
    private readonly waitForAgentSession: WaitForAgentSessionStep,
    private readonly wipeDisks: WipeDisksStep,
    private readonly collectHardware: CollectHardwareStep,
  ) {}

  onModuleInit(): void {
    registerSagaDef(
      buildCommissionSaga({
        validateIpmi: this.validateIpmi,
        redfishStandardize: this.redfishStandardize,
        brokkrLiveCheck: this.brokkrLiveCheck,
        disableOsBoot: this.disableOsBoot,
        pcPowerOff: this.pcPowerOff,
        pcVerifyPowerOff: this.pcVerifyPowerOff,
        pcSetBootDevice: this.pcSetBootDevice,
        pcVerifyBootDevice: this.pcVerifyBootDevice,
        pcPowerOn: this.pcPowerOn,
        pcVerifyPowerOn: this.pcVerifyPowerOn,
        waitForBrokkrLive: this.waitForBrokkrLive,
        waitForAgentSession: this.waitForAgentSession,
        wipeDisks: this.wipeDisks,
        collectHardware: this.collectHardware,
      }),
    );
  }
}
