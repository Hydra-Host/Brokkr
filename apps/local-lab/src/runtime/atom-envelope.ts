import { z } from 'zod';

/** Hand-maintained mirror of the hub's envelope (apps/api/src/common/redis/atom-envelope.types.ts).
 *  Deliberately not `.strict()` like the hub/bridge copies: an added envelope field must not fail the read. */
const baseFields = {
  written_at: z.number().int(),
  request_id: z.string().nullable(),
};

export const AtomEnvelopeSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), value: z.unknown(), ...baseFields }),
  z.object({ status: z.literal('failed'), reason: z.string(), ...baseFields }),
]);

export type AtomEnvelope = z.infer<typeof AtomEnvelopeSchema>;

export type AtomRead<T> =
  | { ok: true; value: T; writtenAtMs: number; requestId: string | null }
  | { ok: false; error: string; writtenAtMs: number | null; requestId: string | null };

/** A hub-written atom can legitimately carry `status: 'failed'`; that is an answer, not a read error,
 *  so it surfaces as a reason rather than disappearing from the caller's list. */
export function readAtom<T>(raw: string | null, valueSchema: z.ZodType<T>): AtomRead<T> {
  if (raw === null) return { ok: false, error: 'atom is absent', writtenAtMs: null, requestId: null };

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'atom is not valid json', writtenAtMs: null, requestId: null };
  }

  const envelope = AtomEnvelopeSchema.safeParse(json);
  if (!envelope.success) {
    return { ok: false, error: 'atom envelope did not parse', writtenAtMs: null, requestId: null };
  }
  if (envelope.data.status === 'failed') {
    return {
      ok: false,
      error: `hub reported ${envelope.data.reason}`,
      writtenAtMs: envelope.data.written_at,
      requestId: envelope.data.request_id,
    };
  }

  const value = valueSchema.safeParse(envelope.data.value);
  if (!value.success) {
    return {
      ok: false,
      error: 'atom value did not match the expected shape',
      writtenAtMs: envelope.data.written_at,
      requestId: envelope.data.request_id,
    };
  }
  return {
    ok: true,
    value: value.data,
    writtenAtMs: envelope.data.written_at,
    requestId: envelope.data.request_id,
  };
}
