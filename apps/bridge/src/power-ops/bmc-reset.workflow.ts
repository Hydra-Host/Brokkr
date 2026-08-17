import type { SagaContext, SagaDef, SagaStepExecutor } from '../saga-framework/saga.types';

export interface BmcResetSagaStepServices {
  pcValidateIpmi: SagaStepExecutor;
  pcBmcResetCold: SagaStepExecutor;
  pcVerifyBmcRecovery: SagaStepExecutor;
}

export function buildBmcResetSaga(steps: BmcResetSagaStepServices): SagaDef {
  return {
    name: 'bmc_reset',
    steps: [
      {
        name: 'validate_ipmi',
        operation: 'Validate IPMI credentials',
        execute: (ctx: SagaContext) => steps.pcValidateIpmi.execute(ctx),
      },
      {
        name: 'bmc_reset_cold',
        operation: 'Issue BMC cold reset',
        execute: (ctx: SagaContext) => steps.pcBmcResetCold.execute(ctx),
        maxAttempts: 2,
        recovery: [{ rewindTo: 'validate_ipmi', description: 'Re-validate and retry BMC reset' }],
      },
      {
        name: 'verify_bmc_recovery',
        operation: 'Verify BMC recovery',
        execute: (ctx: SagaContext) => steps.pcVerifyBmcRecovery.execute(ctx),
      },
    ],
  };
}
