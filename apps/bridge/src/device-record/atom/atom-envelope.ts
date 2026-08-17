// Must stay in sync with hub's Zod at apps/api/src/common/redis/atom-envelope.types.ts.

import { z } from 'zod';

const atomEnvelopeBase = {
  written_at: z.number().int(),
  request_id: z.string().nullable(),
};

export const atomEnvelopeOkSchema = z
  .object({
    status: z.literal('ok'),
    value: z.unknown().refine((v) => v !== undefined, { message: 'Field required' }),
    ...atomEnvelopeBase,
  })
  .strict();

export const atomEnvelopeFailedSchema = z
  .object({
    status: z.literal('failed'),
    reason: z.string(),
    ...atomEnvelopeBase,
  })
  .strict();

export const atomEnvelopeSchema = z.discriminatedUnion('status', [atomEnvelopeOkSchema, atomEnvelopeFailedSchema]);

export type AtomEnvelopeOk = z.infer<typeof atomEnvelopeOkSchema>;
export type AtomEnvelopeFailed = z.infer<typeof atomEnvelopeFailedSchema>;
export type AtomEnvelope = z.infer<typeof atomEnvelopeSchema>;
