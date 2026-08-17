import type { SagaContext, SagaDef, SagaStepExecutor } from '../saga-framework/saga.types';

export interface PowerOffSagaStepServices {
  pcValidateIpmi: SagaStepExecutor;
  pcPowerOff: SagaStepExecutor;
  pcVerifyPowerOff: SagaStepExecutor;
}

export function buildPowerOffSaga(steps: PowerOffSagaStepServices): SagaDef {
  return {
    name: 'power_off',
    steps: [
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
    ],
  };
}
