import type { SagaDef } from '../saga-framework/saga.types';
import type { SecretRevealStep } from './secret-reveal.step';

export function buildSecretRevealSaga(step: SecretRevealStep): SagaDef {
  return {
    name: 'secret_reveal',
    steps: [
      {
        name: 'reveal_secret',
        operation: 'Open the zone-sealed device secret and return it to the hub',
        execute: (ctx) => step.execute(ctx),
      },
    ],
  };
}
