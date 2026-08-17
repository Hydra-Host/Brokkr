import { z } from 'zod';

// Shape is mirrored on the spoke side; do not diverge without coordinating both repos.
const baseEnvelopeFields = {
  written_at: z.number().int().describe('Unix milliseconds when this atom was written.'),
  request_id: z
    .string()
    .nullable()
    .describe(
      'Correlation token that produced this atom (often a label-prefixed plan id); null for unsolicited writes.',
    ),
};

export const failedEnvelopeSchema = z
  .object({
    status: z.literal('failed'),
    reason: z.string().describe('Short machine-readable failure reason (e.g. "unsupported_domain").'),
    ...baseEnvelopeFields,
  })
  .strict();

export const rawAtomEnvelopeSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('ok'),
      value: z.unknown(),
      ...baseEnvelopeFields,
    })
    .strict(),
  failedEnvelopeSchema,
]);

export type AtomEnvelopeOk<T> = {
  status: 'ok';
  value: T;
  written_at: number;
  request_id: string | null;
};
export type AtomEnvelopeFailed = z.infer<typeof failedEnvelopeSchema>;
export type AtomEnvelope<T> = AtomEnvelopeOk<T> | AtomEnvelopeFailed;
