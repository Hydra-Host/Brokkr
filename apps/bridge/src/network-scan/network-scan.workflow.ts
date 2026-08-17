import type { SagaContext, SagaDef, SagaStepExecutor } from '../saga-framework/saga.types';

export interface NetworkScanSagaStepServices {
  networkScan: SagaStepExecutor;
}

export function buildNetworkScanSaga(steps: NetworkScanSagaStepServices): SagaDef {
  return {
    name: 'network_scan',
    steps: [
      {
        name: 'network_scan',
        operation: 'Scan network subnets for device discovery',
        execute: (ctx: SagaContext) => steps.networkScan.execute(ctx),
      },
    ],
  };
}
