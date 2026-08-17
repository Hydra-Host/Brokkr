import type { SagaContext, SagaDef, SagaStepExecutor } from '../saga-framework/saga.types';

export interface PowerStatusSagaStepServices {
  pcValidateIpmi: SagaStepExecutor;
}

export function buildPowerStatusSaga(steps: PowerStatusSagaStepServices): SagaDef {
  return {
    name: 'power_status',
    steps: [
      {
        name: 'validate_ipmi',
        operation: 'Check IPMI power status',
        execute: (ctx: SagaContext) => steps.pcValidateIpmi.execute(ctx),
      },
    ],
  };
}
