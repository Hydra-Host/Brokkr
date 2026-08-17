import { z } from 'zod';

export const dmidecodeSchema = z.array(z.unknown());
export type DmidecodeInput = z.infer<typeof dmidecodeSchema>;
