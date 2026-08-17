import type { SagaContext, SagaDef, SagaStepExecutor } from '../saga-framework/saga.types';

export interface CollectionSagaStepServices {
  waitForBrokkrLive: SagaStepExecutor;
  collectHardware: SagaStepExecutor;
  probeSerialPort: SagaStepExecutor;
}

export function buildInventoryCollectionSaga(steps: CollectionSagaStepServices): SagaDef {
  return {
    name: 'inventory_collection',
    steps: [
      {
        name: 'wait_for_brokkr_live',
        operation: 'Wait for Brokkr Live OS',
        execute: (ctx: SagaContext) => steps.waitForBrokkrLive.execute(ctx),
      },
      {
        name: 'collect_hardware',
        operation: 'Collect hardware facts',
        execute: (ctx: SagaContext) => steps.collectHardware.execute(ctx),
      },
      {
        name: 'probe_serial_port',
        operation: 'Probe BMC serial console via SOL',
        execute: (ctx: SagaContext) => steps.probeSerialPort.execute(ctx),
      },
    ],
  };
}
