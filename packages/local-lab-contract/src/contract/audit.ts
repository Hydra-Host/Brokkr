import { z } from 'zod';
import { AuditEventSchema, AuditOutcomeSchema } from '../schemas/audit';

export const auditRoutes = {
  listAuditEvents: {
    method: 'GET',
    path: '/api/audit',
    query: z.object({
      outcome: AuditOutcomeSchema.optional().describe('Restrict to one outcome'),
      method: z.string().optional().describe('Restrict to one HTTP method'),
      since: z.coerce.number().int().min(0).optional().describe('Unix ms lower bound on the event timestamp'),
      limit: z.coerce.number().int().min(1).max(500).default(100).describe('Page size, newest event first'),
      offset: z.coerce.number().int().min(0).default(0).describe('Rows skipped before the page starts'),
    }),
    responses: { 200: z.array(AuditEventSchema) },
    summary: 'List audit log events',
    description:
      'Read-only: returns recorded control-center requests, newest first. There is deliberately no mutation or clear route — retention (a row cap plus a ttl sweep) is the only eviction path, so an operator cannot erase their own trail. Recorded params are JSON redacted on two axes only: values under secret-shaped keys are replaced, and DSN credentials are masked wherever they appear in a string — so a secret carried under a non-secret key, buried in a stringified blob, or past the 8 KiB cap (which is truncated, not redacted) is served back verbatim, and the log must be treated as sensitive. Narrow with outcome/method/since and page with limit/offset.',
  },
} as const;
