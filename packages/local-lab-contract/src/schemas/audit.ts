import { z } from 'zod';
import { RequestOriginSchema } from './common';

export const AuditOutcomeSchema = z
  .enum(['ok', 'error', 'denied'])
  .describe("'denied' is a rejected request, not a failed one — it never reached the handler body");
export type AuditOutcome = z.infer<typeof AuditOutcomeSchema>;

export const AuditEventSchema = z.object({
  id: z.number().int().describe('Monotonic rowid; the tiebreaker when several events share a millisecond'),
  ts: z.number().describe('Unix ms the request was recorded'),
  method: z.string().describe('HTTP method of the audited request'),
  path: z.string().describe('Request path as routed, including path params already substituted'),
  handler: z.string().describe('Contract route key that served the request (e.g. runPgQuery)'),
  outcome: AuditOutcomeSchema,
  statusCode: z.number().int().nullable().describe('HTTP status returned; null when no response was produced'),
  durationMs: z.number().int().nullable().describe('Wall time the handler took; null for a denial short-circuit'),
  runId: z.string().nullable().describe('Run the request minted or acted on; null for requests that touch no run'),
  origin: RequestOriginSchema.nullable().describe('Request that produced the event; null for system-issued calls'),
  params: z
    .string()
    .nullable()
    .describe(
      'Redacted JSON of the request body/query capped at 8 KiB, null when there was nothing to record — values under secret-shaped keys are replaced and DSN credentials masked, but a secret under any other key is retained, as is raw SQL, because the statement is the audit',
    ),
  error: z.string().nullable().describe('Failure or denial reason; null on an ok outcome'),
});
export type AuditEvent = z.infer<typeof AuditEventSchema>;
