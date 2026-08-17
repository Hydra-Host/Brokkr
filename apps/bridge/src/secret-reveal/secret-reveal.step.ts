import { z } from 'zod';
import type { ResultsService } from '../bullmq/results.service';
import type { SagaContext } from '../saga-framework/saga.types';
import { forwardedSecretSchema, openForwardedSecret } from '../zone-crypto/device-secret-open';

const revealPayloadSchema = z.object({
  request_id: z.string(),
  device_id: z.string(),
  secret: forwardedSecretSchema,
});

export class SecretRevealStep {
  constructor(private readonly results: ResultsService) {}

  async execute(ctx: SagaContext): Promise<Record<string, unknown>> {
    const { request_id, device_id, secret } = revealPayloadSchema.parse(ctx.payload);
    const opened = openForwardedSecret(secret);
    const enqueued = await this.results.enqueueSecretRevealed({
      requestId: request_id,
      deviceId: device_id,
      secret: opened,
    });
    if (!enqueued) {
      // Fail the saga so BullMQ retries instead of leaving the hub poll to hang until timeout.
      throw new Error(`failed to enqueue secret.revealed for request ${request_id}`);
    }
    return { request_id, revealed: true };
  }
}
