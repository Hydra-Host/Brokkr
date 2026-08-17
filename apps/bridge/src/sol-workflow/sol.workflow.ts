import type { SagaContext, SagaDef, SagaStepExecutor } from '../saga-framework/saga.types';

export interface SolSagaStepServices {
  ensureSolEnabled: SagaStepExecutor;
  deactivateSol: SagaStepExecutor;
  solMonitor: SagaStepExecutor;
}

export function buildSolSaga(steps: SolSagaStepServices): SagaDef {
  return {
    name: 'sol',
    steps: [
      {
        name: 'ensure_sol_enabled',
        operation: 'Ensure SOL is enabled on BMC',
        execute: (ctx: SagaContext) => steps.ensureSolEnabled.execute(ctx),
      },
      {
        name: 'deactivate_sol',
        operation: 'Deactivate existing SOL session',
        execute: (ctx: SagaContext) => steps.deactivateSol.execute(ctx),
      },
      {
        name: 'sol_monitor',
        operation: 'Monitor SOL console output',
        execute: (ctx: SagaContext) => steps.solMonitor.execute(ctx),
        maxAttempts: 2,
        recovery: [{ rewindTo: 'deactivate_sol', description: 'Clean up and retry SOL' }],
      },
    ],
  };
}
