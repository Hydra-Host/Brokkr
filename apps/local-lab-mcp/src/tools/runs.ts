import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { LabContext } from '../client.js';
import labContractPkg from '../lab-contract.js';
import { collectRunLogs } from '../runs.js';
import { call, failOnError } from '../shared.js';

const { RunSectionSchema, RunStatusSchema } = labContractPkg;

export function registerRunTools(server: McpServer, ctx: LabContext): void {
  server.tool(
    'lab_list_runs',
    'The unified run ledger — every background op the control center has launched (stack ops, fleet ops, tests, builds), newest first, with live state overlaid on anything still executing.',
    {
      section: RunSectionSchema.optional().describe('Restrict to one domain'),
      status: RunStatusSchema.optional().describe('Restrict to one lifecycle state'),
      opId: z.string().optional().describe('Restrict to one operation id'),
      limit: z.number().int().min(1).max(500).optional().describe('Page size, newest first (default 100)'),
      offset: z.number().int().min(0).optional().describe('Rows skipped before the page starts'),
    },
    (args) =>
      call(ctx, async (client) => {
        const res = await client.listRuns({
          query: {
            section: args.section,
            status: args.status,
            opId: args.opId,
            limit: args.limit ?? 100,
            offset: args.offset ?? 0,
          },
        });
        failOnError(res, 'listRuns');
        return res.body;
      }),
  );

  server.tool(
    'lab_get_run',
    'One run by id, preferring live in-process state over the persisted row. 404 for an id the ledger has never held.',
    {
      runId: z.string().min(1).describe('Run to fetch'),
    },
    (args) =>
      call(ctx, async (client) => {
        const res = await client.getRun({ params: { runId: args.runId } });
        failOnError(res, 'getRun');
        return res.body;
      }),
  );

  server.tool(
    'lab_get_run_logs',
    'The log of any run (live or finished — finished runs replay their persisted log), capped to a tail. done=true means the stream ended normally.',
    {
      runId: z.string().min(1).describe('Run to read logs for'),
      maxChars: z.number().int().min(1024).optional().describe('Tail cap in characters (default 65536)'),
    },
    (args) => call(ctx, () => collectRunLogs(ctx, args.runId, { maxChars: args.maxChars })),
  );

  server.tool(
    'lab_cancel_run',
    'SIGTERM the child process group of an in-progress run. cancelled=true means a signal was actually delivered; the run stays running until its child exits.',
    {
      runId: z.string().min(1).describe('Run to cancel'),
    },
    (args) =>
      call(ctx, async (client) => {
        const res = await client.cancelRun({ params: { runId: args.runId }, body: {} });
        failOnError(res, 'cancelRun');
        return res.body;
      }),
  );
}
