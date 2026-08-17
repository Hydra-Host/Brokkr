import type { SagaContext, SagaDef, SagaStepExecutor } from '../saga-framework/saga.types';

export interface PowerOnSagaStepServices {
  pcValidateIpmi: SagaStepExecutor;
  pcSetBootDevice: SagaStepExecutor;
  pcVerifyBootDevice: SagaStepExecutor;
  pcPowerOn: SagaStepExecutor;
  pcVerifyPowerOn: SagaStepExecutor;
  pcWaitForOs: SagaStepExecutor;
}

export function buildPowerOnSaga(steps: PowerOnSagaStepServices): SagaDef {
  return {
    name: 'power_on',
    steps: [
      {
        name: 'validate_ipmi',
        operation: 'Validate IPMI credentials',
        execute: (ctx: SagaContext) => steps.pcValidateIpmi.execute(ctx),
      },
      {
        name: 'set_boot_device',
        operation: 'Set boot device',
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
      {
        name: 'wait_for_os',
        operation: 'Wait for OS readiness',
        execute: (ctx: SagaContext) => steps.pcWaitForOs.execute(ctx),
      },
    ],
  };
}
