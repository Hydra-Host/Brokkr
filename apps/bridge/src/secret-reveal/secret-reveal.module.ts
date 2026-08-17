import { Module, type OnModuleInit } from '@nestjs/common';

import type { ResultsService } from '../bullmq/results.service';
import { BULLMQ_RESULTS_SERVICE } from '../composition/composition-tokens';
import { registerSagaDef } from '../saga-framework/saga-registry';

import { SecretRevealStep } from './secret-reveal.step';
import { buildSecretRevealSaga } from './secret-reveal.workflow';

@Module({
  providers: [
    {
      provide: SecretRevealStep,
      useFactory: (results: ResultsService) => new SecretRevealStep(results),
      inject: [BULLMQ_RESULTS_SERVICE],
    },
  ],
})
export class SecretRevealModule implements OnModuleInit {
  constructor(private readonly step: SecretRevealStep) {}

  onModuleInit(): void {
    registerSagaDef(buildSecretRevealSaga(this.step));
  }
}
