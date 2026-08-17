import type { SagaContext, SagaDef, SagaStepExecutor } from '../saga-framework/saga.types';

export interface DeprovisionSagaStepServices {
  disableOsBoot: SagaStepExecutor;
  ensureSolEnabled: SagaStepExecutor;
  solActivation: SagaStepExecutor;
  pcPowerOff: SagaStepExecutor;
  pcVerifyPowerOff: SagaStepExecutor;
  pcSetBootDevice: SagaStepExecutor;
  pcVerifyBootDevice: SagaStepExecutor;
  pcPowerOn: SagaStepExecutor;
  pcVerifyPowerOn: SagaStepExecutor;
  waitForBrokkrLive: SagaStepExecutor;
  wipeDisks: SagaStepExecutor;
  efiCleanup: SagaStepExecutor;
  collectHardware: SagaStepExecutor;
}

export function buildDeprovisionSaga(steps: DeprovisionSagaStepServices): SagaDef {
  return {
    name: 'deprovision',
    steps: [
      {
        name: 'disable_os_boot',
        operation: 'Disable OS boot options',
        execute: (ctx: SagaContext) => steps.disableOsBoot.execute(ctx),
      },
      {
        name: 'ensure_sol_enabled',
        operation: 'Ensure SOL is enabled on BMC',
        execute: (ctx: SagaContext) => steps.ensureSolEnabled.execute(ctx),
      },
      {
        name: 'sol_activation',
        operation: 'Activate SOL monitoring',
        execute: (ctx: SagaContext) => steps.solActivation.execute(ctx),
      },
      {
        name: 'power_off',
        operation: 'Power off server',
        execute: (ctx: SagaContext) => steps.pcPowerOff.execute(ctx),
      },
      {
        name: 'verify_power_off',
        operation: 'Verify server powered off',
        execute: (ctx: SagaContext) => steps.pcVerifyPowerOff.execute(ctx),
      },
      {
        name: 'set_boot_device',
        operation: 'Set boot device',
        execute: (ctx: SagaContext) => steps.pcSetBootDevice.execute(ctx),
      },
      {
        name: 'verify_boot_device',
        operation: 'Verify boot device set',
        execute: (ctx: SagaContext) => steps.pcVerifyBootDevice.execute(ctx),
      },
      {
        name: 'power_on',
        operation: 'Power on server',
        execute: (ctx: SagaContext) => steps.pcPowerOn.execute(ctx),
      },
      {
        name: 'verify_power_on',
        operation: 'Verify server powered on',
        execute: (ctx: SagaContext) => steps.pcVerifyPowerOn.execute(ctx),
      },
      {
        name: 'wait_for_brokkr_live',
        operation: 'Wait for Brokkr Live OS',
        execute: (ctx: SagaContext) => steps.waitForBrokkrLive.execute(ctx),
      },
      {
        name: 'disk_wipe',
        operation: 'Wipe all disks (NIST 800)',
        execute: (ctx: SagaContext) => steps.wipeDisks.execute(ctx),
        maxAttempts: 3,
        recovery: [
          { rewindTo: 'disk_wipe', description: 'Retry disk wipe' },
          { rewindTo: 'power_off', description: 'Reboot and retry disk wipe' },
        ],
      },
      {
        name: 'efi_cleanup',
        operation: 'Remove EFI boot entries',
        execute: (ctx: SagaContext) => steps.efiCleanup.execute(ctx),
      },
      {
        name: 'collect_hardware',
        operation: 'Collect hardware facts',
        execute: (ctx: SagaContext) => steps.collectHardware.execute(ctx),
      },
    ],
  };
}
