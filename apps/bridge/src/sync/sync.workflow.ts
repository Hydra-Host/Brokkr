import type { SagaContext, SagaDef, SagaStepExecutor } from '../saga-framework/saga.types';

export interface SyncSagaStepServices {
  sync: SagaStepExecutor;
}

export function buildSyncSaga(steps: SyncSagaStepServices): SagaDef {
  return {
    name: 'sync',
    steps: [
      {
        name: 'sync',
        operation: 'Sync assets',
        execute: (ctx: SagaContext) => steps.sync.execute(ctx),
      },
    ],
  };
}
