import type { SagaContext } from '../saga.types';

export const stubSagaStep: { execute: (ctx: SagaContext) => Promise<unknown> } = {
  execute: async () => undefined,
};
