import { Module, type OnModuleInit } from '@nestjs/common';

import { CollectionModule } from '../collection/collection.module';
import { CollectHardwareStep } from '../collection/steps/collect-hardware.step';
import { WaitForBrokkrLiveStep } from '../collection/steps/wait-for-brokkr-live.step';
import { EFI_BOOT_SERVICE_FACTORY } from '../lifecycle-deploy/efi-boot.service.js';
import { LifecycleDeployModule } from '../lifecycle-deploy/lifecycle-deploy.module.js';
import { WipeDisksStep } from '../lifecycle-deploy/steps/wipe-disks.step';
import { ContextLogger } from '../logger/logger.service';
import { OobModule } from '../oob/oob.module';
import { DisableOsBootStep } from '../oob/redfish/steps/disable-os-boot.step';
import { EnsureSolEnabledStep } from '../oob/sol/steps/ensure-sol-enabled.step';
import { SolActivationStep } from '../oob/sol/steps/sol-activation.step';
import { PcPowerOffStep } from '../oob/steps/pc-power-off.step';
import { PcPowerOnStep } from '../oob/steps/pc-power-on.step';
import { PcSetBootDeviceStep } from '../oob/steps/pc-set-boot-device.step';
import { PcVerifyBootDeviceStep } from '../oob/steps/pc-verify-boot-device.step';
import { PcVerifyPowerOffStep } from '../oob/steps/pc-verify-power-off.step';
import { PcVerifyPowerOnStep } from '../oob/steps/pc-verify-power-on.step';
import { registerSagaDef } from '../saga-framework/saga-registry';

import { buildDeprovisionSaga } from './deprovision.workflow';
import { EfiCleanupStep } from './steps/efi-cleanup.step';

@Module({
  imports: [OobModule, CollectionModule, LifecycleDeployModule],
  providers: [
    {
      provide: EfiCleanupStep,
      useFactory: (
        factory: {
          create: (args: {
            jobId: string;
            deviceId: string;
          }) => Promise<{ cleanupOsBootEntries: () => Promise<Record<string, unknown>> }>;
        },
        logger: ContextLogger,
      ) => new EfiCleanupStep(factory, logger),
      inject: [EFI_BOOT_SERVICE_FACTORY, ContextLogger],
    },
  ],
  exports: [LifecycleDeployModule, EfiCleanupStep],
})
export class DeprovisionModule implements OnModuleInit {
  constructor(
    private readonly disableOsBoot: DisableOsBootStep,
    private readonly ensureSolEnabled: EnsureSolEnabledStep,
    private readonly solActivation: SolActivationStep,
    private readonly pcPowerOff: PcPowerOffStep,
    private readonly pcVerifyPowerOff: PcVerifyPowerOffStep,
    private readonly pcSetBootDevice: PcSetBootDeviceStep,
    private readonly pcVerifyBootDevice: PcVerifyBootDeviceStep,
    private readonly pcPowerOn: PcPowerOnStep,
    private readonly pcVerifyPowerOn: PcVerifyPowerOnStep,
    private readonly waitForBrokkrLive: WaitForBrokkrLiveStep,
    private readonly wipeDisks: WipeDisksStep,
    private readonly efiCleanup: EfiCleanupStep,
    private readonly collectHardware: CollectHardwareStep,
  ) {}

  onModuleInit(): void {
    registerSagaDef(
      buildDeprovisionSaga({
        disableOsBoot: this.disableOsBoot,
        ensureSolEnabled: this.ensureSolEnabled,
        solActivation: this.solActivation,
        pcPowerOff: this.pcPowerOff,
        pcVerifyPowerOff: this.pcVerifyPowerOff,
        pcSetBootDevice: this.pcSetBootDevice,
        pcVerifyBootDevice: this.pcVerifyBootDevice,
        pcPowerOn: this.pcPowerOn,
        pcVerifyPowerOn: this.pcVerifyPowerOn,
        waitForBrokkrLive: this.waitForBrokkrLive,
        wipeDisks: this.wipeDisks,
        efiCleanup: this.efiCleanup,
        collectHardware: this.collectHardware,
      }),
    );
  }
}
