import { z } from 'zod';
import { RequestOriginSchema } from './common';

export const RunSectionSchema = z
  .enum(['stack', 'fleet', 'build', 'storage', 'test', 'queues'])
  .describe('Domain that minted the run — a wider axis than StackOp.section, which is UI placement');
export type RunSection = z.infer<typeof RunSectionSchema>;

export const RunStatusSchema = z
  .enum(['running', 'passed', 'failed', 'cancelled', 'orphaned'])
  .describe(
    "running until the child exits; 'cancelled' only when the API sent the SIGTERM itself; 'orphaned' when the run outlived the API process that owned it",
  );
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const RunSchema = z.object({
  runId: z.string().describe('Server-minted uuid; one global id space across every section'),
  section: RunSectionSchema,
  opId: z.string().describe('Stable machine id for the operation — the join key for filtering and grouping'),
  label: z.string().describe('Human display string; may embed a node name or layer summary'),
  status: RunStatusSchema,
  startedAt: z.number().describe('Unix ms'),
  finishedAt: z.number().nullable().describe('Unix ms the run reached a terminal status; null while running'),
  exitCode: z.number().nullable().describe('Child exit code; null while running or when no child was spawned'),
  nodeIndex: z.number().int().nullable().describe('Fleet node the run is pinned to; null for unpinned runs'),
  origin: RequestOriginSchema.nullable().describe(
    'Request that started the run; null for system runs (boot reconcile, journal resurrection)',
  ),
  hasLog: z.boolean().describe('A retained per-run log file exists and can be replayed from the run stream'),
  hasResult: z
    .boolean()
    .describe('Structured test results exist for this run; always false until the vitest reporter is wired'),
});
export type Run = z.infer<typeof RunSchema>;
