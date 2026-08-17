import { Module, type OnModuleInit } from '@nestjs/common';

import { OobModule } from '../oob/oob.module';
import { RedfishCommandStep } from '../oob/steps/redfish-command.step';
import { registerSagaDef } from '../saga-framework/saga-registry';

import { buildRedfishSaga } from './redfish.workflow';

@Module({
  imports: [OobModule],
})
export class RedfishWorkflowModule implements OnModuleInit {
  constructor(private readonly redfishCommand: RedfishCommandStep) {}

  onModuleInit(): void {
    registerSagaDef(buildRedfishSaga({ redfishCommand: this.redfishCommand }));
  }
}
