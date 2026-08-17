import { z } from 'zod';

import { StackSlotSchema } from './common';

export const StackProcessCountsSchema = z.object({
  running: z
    .number()
    .int()
    .describe('Supervised processes currently up (running and not unready) on that stack, from its own GET /processes'),
  total: z.number().int().describe('Supervised processes on that stack, excluding disabled ones'),
});
export type StackProcessCounts = z.infer<typeof StackProcessCountsSchema>;

export const RegisteredStackSchema = z.object({
  slot: z.number().int().describe('Instance slot the stack owns (0–46); all of its ports and subnets derive from it'),
  checkout: z.string().describe('Absolute path of the repo checkout that claimed the slot'),
  state: z
    .string()
    .describe(
      "Lifecycle state the registry recorded at the last transition (e.g. up/down); 'unknown' before the first stamp",
    ),
  live: z
    .boolean()
    .describe(
      'Whether the stack’s process-compose socket answers right now — the registry entry is a hint, the socket is truth',
    ),
  hubUrl: z
    .string()
    .nullable()
    .describe('Hub API base URL from the entry’s denormalized ports; null until the first bring-up stamps them'),
  webUrl: z.string().nullable().describe('Hub web UI URL; null until the entry carries denormalized ports'),
  labUrl: z
    .string()
    .nullable()
    .describe('That stack’s control-center API URL; null until the entry carries denormalized ports'),
  labWebUrl: z
    .string()
    .nullable()
    .describe(
      'That stack’s control-center web UI URL — the page an operator opens, unlike labUrl which is the API; null until the entry carries denormalized ports',
    ),
  processes: StackProcessCountsSchema.describe(
    'Process rollup from the stack’s own GET /processes; 0/0 while not live',
  ),
  healthLine: z
    .string()
    .nullable()
    .describe(
      'One-line health rollup derived from that stack’s own /api/status (datastores + fleet); null when not live or its lab doesn’t answer',
    ),
});
export type RegisteredStack = z.infer<typeof RegisteredStackSchema>;

export const StacksListSchema = z.object({
  stacks: z.array(RegisteredStackSchema).describe('Every stack registered on this host, sorted by slot ascending'),
  selfSlot: StackSlotSchema.describe(
    'Slot of the stack that served this response — the only trustworthy way for its UI to tell which row is itself',
  ),
});
export type StacksList = z.infer<typeof StacksListSchema>;
