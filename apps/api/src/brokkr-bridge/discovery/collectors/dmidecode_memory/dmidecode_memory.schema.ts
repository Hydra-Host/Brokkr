import { z } from 'zod';

export const dmidecodeMemorySchema = z.array(z.unknown());

export const dmidecodeRecordSchema = z
  .object({
    type: z.number().int(),
    values: z.record(z.string(), z.unknown()).optional().default({}),
  })
  .passthrough();

export type DmidecodeMemoryInput = z.infer<typeof dmidecodeMemorySchema>;
