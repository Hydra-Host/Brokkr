import type { ZodSchema } from 'zod';

export type SagaPayloadSchemaRegistry = Readonly<Record<string, ZodSchema>>;

export function validateSagaPayload(sagaName: string, payload: unknown, schemas: SagaPayloadSchemaRegistry): void {
  const schema = schemas[sagaName];
  if (schema === undefined) return;
  const result = schema.safeParse(payload);
  if (!result.success) {
    throw new Error(`Invalid payload for saga '${sagaName}': ${result.error.message}`);
  }
}
