import { z } from 'zod';
import { ErrorBodySchema } from '../schemas/common';
import { RunSchema, RunSectionSchema, RunStatusSchema } from '../schemas/runs';

export const runsRoutes = {
  listRuns: {
    method: 'GET',
    path: '/api/runs',
    query: z.object({
      section: RunSectionSchema.optional().describe('Restrict to one domain'),
      status: RunStatusSchema.optional().describe('Restrict to one lifecycle state'),
      opId: z.string().optional().describe('Restrict to one operation id'),
      limit: z.coerce.number().int().min(1).max(500).default(100).describe('Page size, newest run first'),
      offset: z.coerce.number().int().min(0).default(0).describe('Rows skipped before the page starts'),
    }),
    responses: { 200: z.array(RunSchema) },
    summary: 'List runs across every section',
    description:
      'Read-only: returns the unified run ledger — every recorded run, newest first, with live in-process state overlaid on anything still executing. A run that outlived the process that started it is still listed, which is what makes history survive a control-center restart. Narrow with section/status/opId and page with limit/offset.',
  },
  getRun: {
    method: 'GET',
    path: '/api/runs/:runId',
    pathParams: z.object({ runId: z.string().describe('Run to fetch') }),
    responses: { 200: RunSchema, 404: ErrorBodySchema },
    summary: 'Get one run',
    description:
      'Read-only: returns a single run, preferring live in-process state over the persisted row so a running op reports its current status. Returns 404 for an id the ledger has never held or that retention has already evicted.',
  },
  cancelRun: {
    method: 'POST',
    path: '/api/runs/:runId/cancel',
    pathParams: z.object({ runId: z.string().describe('Run to cancel') }),
    body: z.object({}),
    responses: {
      200: z.object({
        cancelled: z
          .boolean()
          .describe('A SIGTERM was actually delivered; false when the run was force-finalized with no child to signal'),
      }),
      404: ErrorBodySchema,
      409: ErrorBodySchema.describe('Run is not running (already terminal)'),
    },
    summary: 'Cancel an in-progress run',
    description:
      "Sends SIGTERM to the run's child process group. A 200 means the cancel was accepted, not that the run is already over: the cancelled flag reports whether a signal was actually delivered, and a signalled run stays running until its child exits. A run with no live child to signal comes back cancelled=false and is force-finalized as cancelled rather than left running until the next boot. Returns 404 for an unknown run and 409 for one that has already reached a terminal status.",
  },
} as const;
