import { Module, type OnModuleInit } from '@nestjs/common';

import { OobModule } from '../oob/oob.module';
import { DeactivateSolStep } from '../oob/sol/steps/deactivate-sol.step';
import { EnsureSolEnabledStep } from '../oob/sol/steps/ensure-sol-enabled.step';
import { SolMonitorStep } from '../oob/sol/steps/sol-monitor.step';
import { registerSagaDef } from '../saga-framework/saga-registry';

import { buildSolSaga } from './sol.workflow';

@Module({
  imports: [OobModule],
})
export class SolWorkflowModule implements OnModuleInit {
  constructor(
    private readonly ensureSolEnabled: EnsureSolEnabledStep,
    private readonly deactivateSol: DeactivateSolStep,
    private readonly solMonitor: SolMonitorStep,
  ) {}

  onModuleInit(): void {
    registerSagaDef(
      buildSolSaga({
        ensureSolEnabled: this.ensureSolEnabled,
        deactivateSol: this.deactivateSol,
        solMonitor: this.solMonitor,
      }),
    );
  }
}
