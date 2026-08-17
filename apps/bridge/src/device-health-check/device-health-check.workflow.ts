import type { SagaContext, SagaDef, SagaStepExecutor } from '../saga-framework/saga.types';

export interface DeviceHealthCheckSagaStepServices {
  checkDevice: SagaStepExecutor;
}

export function buildDeviceHealthCheckSaga(steps: DeviceHealthCheckSagaStepServices): SagaDef {
  return {
    name: 'device_health_check',
    steps: [
      {
        name: 'check_device',
        operation: 'Run health checks for a single device',
        execute: (ctx: SagaContext) => steps.checkDevice.execute(ctx),
      },
    ],
  };
}
