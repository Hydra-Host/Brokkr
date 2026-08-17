import type { SagaContext, SagaDef, SagaStepExecutor } from '../saga-framework/saga.types';

export interface RedfishSagaStepServices {
  redfishCommand: SagaStepExecutor;
}

export function buildRedfishSaga(steps: RedfishSagaStepServices): SagaDef {
  return {
    name: 'redfish',
    steps: [
      {
        name: 'redfish_command',
        operation: 'Execute Redfish command',
        execute: (ctx: SagaContext) => steps.redfishCommand.execute(ctx),
      },
    ],
  };
}
