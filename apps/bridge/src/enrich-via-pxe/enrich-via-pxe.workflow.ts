import type { SagaContext, SagaDef, SagaStepExecutor } from '../saga-framework/saga.types';

export interface EnrichViaPxeSagaStepServices {
  redfishCommand: SagaStepExecutor;
  ensureLanplusAccess: SagaStepExecutor;
  pcValidateIpmi: SagaStepExecutor;
  pcPowerOff: SagaStepExecutor;
  pcVerifyPowerOff: SagaStepExecutor;
  pcSetBootDevice: SagaStepExecutor;
  pcVerifyBootDevice: SagaStepExecutor;
  pcPowerOn: SagaStepExecutor;
  pcVerifyPowerOn: SagaStepExecutor;
}

export function buildEnrichViaPxeSaga(steps: EnrichViaPxeSagaStepServices): SagaDef {
  return {
    name: 'enrich_via_pxe',
    steps: [
      {
        name: 'redfish_reliable_boot',
        operation: 'Prep system for reliable PXE boot via Redfish',
        execute: (ctx: SagaContext) => steps.redfishCommand.execute(ctx),
        maxAttempts: 2,
      },
      {
        name: 'ensure_lanplus_access',
        operation: 'Ensure BMC accepts RMCP+ (lanplus)',
        execute: (ctx: SagaContext) => steps.ensureLanplusAccess.execute(ctx),
        maxAttempts: 2,
      },
      {
        name: 'validate_ipmi',
        operation: 'Validate IPMI credentials',
        execute: (ctx: SagaContext) => steps.pcValidateIpmi.execute(ctx),
      },
      {
        name: 'power_off',
        operation: 'Power off server',
        execute: (ctx: SagaContext) => steps.pcPowerOff.execute(ctx),
        maxAttempts: 2,
        recovery: [{ rewindTo: 'validate_ipmi', description: 'Re-validate and retry power off' }],
      },
      {
        name: 'verify_power_off',
        operation: 'Verify server powered off',
        execute: (ctx: SagaContext) => steps.pcVerifyPowerOff.execute(ctx),
        maxAttempts: 2,
        recovery: [{ rewindTo: 'power_off', description: 'Retry power off' }],
      },
      {
        name: 'set_boot_device',
        operation: 'Set boot device to PXE',
        execute: (ctx: SagaContext) => steps.pcSetBootDevice.execute(ctx),
        maxAttempts: 2,
        recovery: [{ rewindTo: 'validate_ipmi', description: 'Re-validate and retry boot device' }],
      },
      {
        name: 'verify_boot_device',
        operation: 'Verify boot device set',
        execute: (ctx: SagaContext) => steps.pcVerifyBootDevice.execute(ctx),
        maxAttempts: 2,
        recovery: [{ rewindTo: 'set_boot_device', description: 'Retry set boot device' }],
      },
      {
        name: 'power_on',
        operation: 'Power on server',
        execute: (ctx: SagaContext) => steps.pcPowerOn.execute(ctx),
        maxAttempts: 2,
        recovery: [{ rewindTo: 'validate_ipmi', description: 'Re-validate and retry power on' }],
      },
      {
        name: 'verify_power_on',
        operation: 'Verify server powered on',
        execute: (ctx: SagaContext) => steps.pcVerifyPowerOn.execute(ctx),
        maxAttempts: 2,
        recovery: [{ rewindTo: 'power_on', description: 'Retry power on' }],
      },
    ],
  };
}
